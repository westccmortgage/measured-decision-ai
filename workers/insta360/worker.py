"""Measured Decision Insta360 GPU worker.

Claims a prepared dual-lens capture, stitches the protected originals into one
equirectangular master, and registers that master as evidence so the Studio can
actually play it. Stitching a file nobody can open is not work finished.
"""

import json
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path

import boto3
import requests

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
POLL_SECONDS = int(os.getenv("POLL_SECONDS", "15"))
# On a rented GPU an idle loop is money burning. Zero means run forever; any
# positive number exits cleanly after that many empty polls, so the host can
# shut itself down between batches.
MAX_IDLE_POLLS = int(os.getenv("MAX_IDLE_POLLS", "0"))
OUTPUT_BUCKET = os.getenv("OUTPUT_BUCKET", os.environ["AWS_S3_BUCKET"])
# Overridable so the pipeline can be exercised end to end before the licensed
# SDK is installed. The substitute must accept the same arguments.
STITCH_COMMAND = os.getenv("STITCH_COMMAND", "/usr/local/bin/stitch360")
MASTER_WIDTH = int(os.getenv("MASTER_WIDTH", "5760"))
MASTER_HEIGHT = int(os.getenv("MASTER_HEIGHT", "2880"))
MASTER_BITRATE = int(os.getenv("MASTER_BITRATE", "80000000"))
SDK_LABEL = os.getenv("SDK_LABEL", "Insta360 MediaSDK")
# The SDK loads its AI weights from here; the vendor example defaults to ./models/.
MODELS_DIR = os.getenv("MODELS_DIR", "/app/models")
FFMPEG_COMMAND = os.getenv("FFMPEG_COMMAND", "ffmpeg")
FFPROBE_COMMAND = os.getenv("FFPROBE_COMMAND", "ffprobe")
# The same window the Studio applies (studio/trim360.js): the operator starts the
# camera, walks out, walks back in to stop it. Ten seconds is the default, five
# the floor, and a capture with less than fifteen seconds left is not touched.
TRIM_PREFERRED_SECONDS = int(os.getenv("TRIM_PREFERRED_SECONDS", "10"))
TRIM_MINIMUM_SECONDS = int(os.getenv("TRIM_MINIMUM_SECONDS", "5"))
TRIM_KEEP_AT_LEAST_SECONDS = int(os.getenv("TRIM_KEEP_AT_LEAST_SECONDS", "15"))
# The boot script opens a row for this machine before the container starts and
# passes its id in. Empty means nobody is listening — the worker still works the
# queue, it just has nowhere to say so.
RUN_ID = os.getenv("MDAI_RUN_ID", "").strip()
TRIM_POLICY = "camera-handling-v1"
TRIM_REASON = "The operator leaves and re-enters the space while the camera is running"

headers = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}", "Content-Type": "application/json"}
s3 = boto3.client(
    "s3",
    region_name=os.getenv("AWS_REGION"),
    endpoint_url=os.getenv("AWS_S3_ENDPOINT") or None,
)


def api(method, path, extra_headers=None, **kwargs):
    request_headers = dict(headers)
    if extra_headers:
        request_headers.update(extra_headers)
    response = requests.request(method, f"{SUPABASE_URL}/rest/v1/{path}", headers=request_headers, timeout=60, **kwargs)
    response.raise_for_status()
    return response.json() if response.content else None


def patch_job(job_id, **values):
    values["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    api("PATCH", f"capture_360_jobs?id=eq.{job_id}", data=json.dumps(values))


def report_run(**values):
    """Tell the record what this machine is doing right now.

    A person watching the Studio should not have to fetch a log from a bucket to
    learn whether the machine is awake. Reporting is best-effort by design: a
    status update that fails must never stop the stitch it describes.
    """
    if not RUN_ID:
        return
    values["last_seen_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    try:
        api("PATCH", f"worker_machine_runs?id=eq.{RUN_ID}", data=json.dumps(values))
    except Exception as error:
        print(f"could not report machine state: {error}", flush=True)


def set_group_state(group_id, state):
    api("PATCH", f"capture_360_groups?id=eq.{group_id}", data=json.dumps({"state": state}))


def claim_job(attempted=()):
    """Claim exactly one job. The state filter is part of the write, so two
    workers racing for the same row cannot both win it.

    A failed job is claimable again: this machine only runs because a person
    started it, and starting it is the request to try again. Without this, one
    bad run — a missing driver, an expired key — left every capture permanently
    failed with no way back. Anything already attempted in *this* run is skipped,
    so a genuinely broken capture cannot spin the loop."""
    select = (
        "id,organization_id,property_id,capture_group_id,"
        "capture_360_groups!inner(source_evidence_ids,capture_key,space_id,processing_profile)"
    )
    claimable = "state=in.(waiting_for_sdk,queued,failed)"
    rows = api("GET", f"capture_360_jobs?{claimable}&select={select}&order=created_at.asc&limit=25")
    rows = [row for row in rows if row["id"] not in attempted]
    if not rows:
        return None
    job = rows[0]
    claimed = api(
        "PATCH",
        f"capture_360_jobs?id=eq.{job['id']}&{claimable}",
        extra_headers={"Prefer": "return=representation"},
        data=json.dumps({
            "state": "processing",
            "stage": "Downloading protected originals",
            "progress": 8,
            "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }),
    )
    if not claimed:
        return None
    set_group_state(job["capture_group_id"], "stitching")
    return job


def evidence_records(ids):
    joined = ",".join(ids)
    return api(
        "GET",
        f"evidence_items?id=in.({joined})"
        "&select=id,original_filename,storage_bucket,storage_path,captured_at,created_by"
        "&order=original_filename.asc",
    )


def master_filename(capture_key):
    """Keep the camera's capture key in the name so the master reads as the same
    capture as the originals it came from."""
    stem = re.sub(r"[^A-Za-z0-9_.-]+", "-", capture_key or "capture").strip("-") or "capture"
    return f"{stem}-vr-master.mp4"


def plan_trim(duration_seconds):
    """The usable window of a capture, or nothing when the clip is too short."""
    duration = float(duration_seconds or 0)
    if duration <= 0:
        return None
    for pad in (TRIM_PREFERRED_SECONDS, TRIM_MINIMUM_SECONDS):
        if duration - pad * 2 >= TRIM_KEEP_AT_LEAST_SECONDS:
            return {
                "policy": TRIM_POLICY,
                "head_seconds": pad,
                "tail_seconds": pad,
                "start_seconds": pad,
                "end_seconds": round(duration - pad, 2),
                "kept_seconds": round(duration - pad * 2, 2),
                "duration_seconds": round(duration, 2),
                "reason": TRIM_REASON,
            }
    return None


def probe_duration(path):
    result = subprocess.run(
        [FFPROBE_COMMAND, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True, timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip()[:200] or "ffprobe failed")
    return float(result.stdout.strip())


def trim_master(path):
    """Cut the camera handling out of the master itself.

    The protected originals are never touched, but the master is the file that
    ends up in a headset, so it has to be clean on its own — a player that knows
    nothing about this product still must not open on an empty doorway. The cut
    is a stream copy: no re-encode, no quality lost. If ffmpeg cannot do it the
    master is published whole with the window recorded, and the Studio applies
    the window on playback instead.
    """
    try:
        window = plan_trim(probe_duration(path))
    except Exception as error:
        print(f"trim skipped, duration unavailable: {error}", flush=True)
        return path, {"applied": False, "policy": TRIM_POLICY, "mode": "not_measured", "reason": str(error)[:200]}
    if not window:
        return path, {"applied": False, "policy": TRIM_POLICY, "mode": "clip_too_short",
                      "reason": "The clip is too short to trim without losing the space itself"}

    trimmed = Path(path).with_name("vr-master-hevc-trimmed.mp4")
    command = [
        FFMPEG_COMMAND, "-y", "-ss", str(window["start_seconds"]), "-i", str(path),
        "-t", str(window["kept_seconds"]), "-c", "copy", "-movflags", "+faststart", str(trimmed),
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=3600)
    if result.returncode != 0 or not trimmed.exists() or trimmed.stat().st_size == 0:
        print(f"trim failed, publishing the whole master: {result.stderr.strip()[:200]}", flush=True)
        # Recorded rather than cut: the Studio still opens the capture inside the
        # window, so nobody reviews the operator walking out.
        return path, {**window, "applied": True, "mode": "recorded"}
    return trimmed, {
        **window,
        # The published file already starts and ends inside the window, so no
        # player should skip anything further.
        "applied": False,
        "mode": "cut_at_processing",
        "start_seconds": 0,
        "end_seconds": window["kept_seconds"],
        "source_duration_seconds": window["duration_seconds"],
        "duration_seconds": window["kept_seconds"],
    }


def master_metadata(capture_key, source_count, trim=None):
    return {
        "trim": trim or {"applied": False, "policy": TRIM_POLICY, "mode": "not_measured"},
        "projection": "equirectangular",
        "width": MASTER_WIDTH,
        "height": MASTER_HEIGHT,
        "codec": "hevc",
        "aspect_ratio": "2:1",
        "insta360_capture_key": capture_key,
        "stitched_by": SDK_LABEL,
        "source_count": source_count,
        "vr": {"role": "equirectangular_playback", "playback_ready": True, "original_preserved": True},
    }


def master_evidence_payload(job, group, sources, object_key, byte_size, created_by, trim=None):
    """The master is a derivative: it points back at the protected original it
    was stitched from, so the chain from record to camera file stays intact."""
    return {
        "organization_id": job["organization_id"],
        "property_id": job["property_id"],
        "space_id": group.get("space_id"),
        "storage_path": object_key,
        "storage_provider": "aws-s3",
        "storage_bucket": OUTPUT_BUCKET,
        "original_filename": master_filename(group.get("capture_key")),
        "media_type": "360 capture",
        "mime_type": "video/mp4",
        "byte_size": byte_size,
        "captured_at": sources[0].get("captured_at"),
        "source_metadata": master_metadata(group.get("capture_key"), len(sources), trim),
        "derivative_of": sources[0]["id"],
        "created_by": created_by,
    }


def registering_user(job, sources):
    """evidence_items.created_by is a real account. Reuse whoever uploaded the
    originals; fall back to an owner of the organization."""
    for source in sources:
        if source.get("created_by"):
            return source["created_by"]
    rows = api(
        "GET",
        f"organization_members?organization_id=eq.{job['organization_id']}"
        "&role=in.(owner,admin)&select=user_id&order=created_at.asc&limit=1",
    )
    if not rows:
        raise RuntimeError("No owner account is available to register the VR master")
    return rows[0]["user_id"]


def register_master(payload):
    return api(
        "POST",
        "evidence_items?on_conflict=storage_path",
        extra_headers={"Prefer": "resolution=merge-duplicates,return=representation"},
        data=json.dumps(payload),
    )


def process(job):
    group = job["capture_360_groups"]
    sources = evidence_records(group["source_evidence_ids"])
    if len(sources) < 2:
        raise RuntimeError("The dual-lens capture is incomplete")

    with tempfile.TemporaryDirectory(prefix="mdai-360-") as temp:
        root = Path(temp)
        local_inputs = []
        for source in sources:
            target = root / source["original_filename"]
            s3.download_file(source["storage_bucket"], source["storage_path"], str(target))
            local_inputs.append(target)

        output = root / "vr-master-hevc.mp4"
        command = [STITCH_COMMAND]
        for source in local_inputs:
            command += ["--input", str(source)]
        command += [
            "--output", str(output),
            "--width", str(MASTER_WIDTH),
            "--height", str(MASTER_HEIGHT),
            "--bitrate", str(MASTER_BITRATE),
            "--models", MODELS_DIR,
        ]
        patch_job(job["id"], stage="Optical-flow stitching and FlowState", progress=10)

        process_handle = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        # The SDK explains its own failures, and throwing that away is why a
        # failed capture used to read "stitching failed" and nothing else. Keep
        # the tail so the reason travels back to the screen with the job.
        tail = []
        for line in process_handle.stdout or []:
            print(line, end="", flush=True)
            tail.append(line.rstrip())
            del tail[:-12]
            # Tolerant of spacing: a formatting change must not silently freeze
            # the progress bar the operator is watching.
            match = re.search(r'"progress"\s*:\s*(\d+)', line)
            if match:
                sdk_progress = int(match.group(1))
                patch_job(job["id"], stage="Creating 5.7K HEVC VR master", progress=min(92, 10 + int(sdk_progress * 0.82)))
        code = process_handle.wait()
        if code != 0 or not output.exists():
            reason = next(
                (t for t in reversed(tail) if t and not t.startswith("{")),
                f"exit code {code}",
            )
            raise RuntimeError(f"Insta360 MediaSDK stitching failed: {reason[:180]}")

        patch_job(job["id"], stage="Trimming the camera handling", progress=93)
        master, trim = trim_master(output)

        object_key = f"processed/360/{job['property_id']}/{job['capture_group_id']}/vr-master-hevc.mp4"
        patch_job(job["id"], stage="Securing VR master", progress=94)
        s3.upload_file(str(master), OUTPUT_BUCKET, object_key, ExtraArgs={"ContentType": "video/mp4"})

        # Without this row the master exists in the bucket and nowhere in the
        # product: the Studio lists evidence, not bucket keys.
        patch_job(job["id"], stage="Publishing the capture to the record", progress=97)
        payload = master_evidence_payload(
            job, group, sources, object_key, master.stat().st_size, registering_user(job, sources), trim
        )
        registered = register_master(payload)
        master_id = registered[0]["id"] if registered else None

        manifest = {
            "vr_master": {
                "bucket": OUTPUT_BUCKET,
                "object_key": object_key,
                "evidence_id": master_id,
                "projection": "equirectangular",
                "width": MASTER_WIDTH,
                "height": MASTER_HEIGHT,
                "codec": "hevc",
                "trim": trim,
            },
            "source_count": len(sources),
            "sdk": SDK_LABEL,
        }
        patch_job(job["id"], state="completed", stage="VR master ready", progress=100, output_manifest=manifest, error_code=None)
        set_group_state(job["capture_group_id"], "vr_ready")


def main():
    idle_polls = 0
    attempted = set()
    claimed_count = completed_count = failed_count = 0
    report_run(state="working", step="Watching the queue")
    while True:
        job = None
        try:
            job = claim_job(attempted)
            if job:
                attempted.add(job["id"])
            if job:
                idle_polls = 0
                claimed_count += 1
                capture = job.get("capture_360_groups") or {}
                report_run(
                    state="working",
                    step=f"Stitching {capture.get('capture_key') or 'a capture'}",
                    jobs_claimed=claimed_count,
                )
                process(job)
                completed_count += 1
                report_run(state="working", step="Watching the queue", jobs_completed=completed_count)
            else:
                idle_polls += 1
                if MAX_IDLE_POLLS and idle_polls >= MAX_IDLE_POLLS:
                    print(f"queue empty for {idle_polls} polls, exiting", flush=True)
                    report_run(state="working", step="Queue empty, nothing left to stitch")
                    return 0
                time.sleep(POLL_SECONDS)
        except Exception as error:
            print(f"worker error: {error}", flush=True)
            if job:
                failed_count += 1
                patch_job(job["id"], state="failed", stage="Processing failed", error_code=str(error)[:300])
                report_run(
                    state="working",
                    step="Watching the queue",
                    jobs_failed=failed_count,
                    message=str(error)[:300],
                )
                # Leave the group back on 'ready' so a retry can claim it rather
                # than stranding the capture in 'stitching' forever.
                try:
                    set_group_state(job["capture_group_id"], "ready")
                except Exception as reset_error:
                    print(f"could not reset capture group: {reset_error}", flush=True)
            idle_polls = 0
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    raise SystemExit(main())
