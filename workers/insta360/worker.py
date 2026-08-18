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
OUTPUT_BUCKET = os.getenv("OUTPUT_BUCKET", os.environ["AWS_S3_BUCKET"])
# Overridable so the pipeline can be exercised end to end before the licensed
# SDK is installed. The substitute must accept the same arguments.
STITCH_COMMAND = os.getenv("STITCH_COMMAND", "/usr/local/bin/stitch360")
MASTER_WIDTH = int(os.getenv("MASTER_WIDTH", "5760"))
MASTER_HEIGHT = int(os.getenv("MASTER_HEIGHT", "2880"))
MASTER_BITRATE = int(os.getenv("MASTER_BITRATE", "80000000"))
SDK_LABEL = os.getenv("SDK_LABEL", "Insta360 MediaSDK")

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


def set_group_state(group_id, state):
    api("PATCH", f"capture_360_groups?id=eq.{group_id}", data=json.dumps({"state": state}))


def claim_job():
    """Claim exactly one job. The state filter is part of the write, so two
    workers racing for the same row cannot both win it."""
    select = (
        "id,organization_id,property_id,capture_group_id,"
        "capture_360_groups!inner(source_evidence_ids,capture_key,space_id,processing_profile)"
    )
    rows = api("GET", f"capture_360_jobs?state=in.(waiting_for_sdk,queued)&select={select}&order=created_at.asc&limit=1")
    if not rows:
        return None
    job = rows[0]
    claimed = api(
        "PATCH",
        f"capture_360_jobs?id=eq.{job['id']}&state=in.(waiting_for_sdk,queued)",
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


def master_metadata(capture_key, source_count):
    return {
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


def master_evidence_payload(job, group, sources, object_key, byte_size, created_by):
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
        "source_metadata": master_metadata(group.get("capture_key"), len(sources)),
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
        ]
        patch_job(job["id"], stage="Optical-flow stitching and FlowState", progress=10)

        process_handle = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        for line in process_handle.stdout or []:
            # Tolerant of spacing: a formatting change must not silently freeze
            # the progress bar the operator is watching.
            match = re.search(r'"progress"\s*:\s*(\d+)', line)
            if match:
                sdk_progress = int(match.group(1))
                patch_job(job["id"], stage="Creating 5.7K HEVC VR master", progress=min(92, 10 + int(sdk_progress * 0.82)))
        if process_handle.wait() != 0 or not output.exists():
            raise RuntimeError("Insta360 MediaSDK stitching failed")

        object_key = f"processed/360/{job['property_id']}/{job['capture_group_id']}/vr-master-hevc.mp4"
        patch_job(job["id"], stage="Securing VR master", progress=94)
        s3.upload_file(str(output), OUTPUT_BUCKET, object_key, ExtraArgs={"ContentType": "video/mp4"})

        # Without this row the master exists in the bucket and nowhere in the
        # product: the Studio lists evidence, not bucket keys.
        patch_job(job["id"], stage="Publishing the capture to the record", progress=97)
        payload = master_evidence_payload(
            job, group, sources, object_key, output.stat().st_size, registering_user(job, sources)
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
            },
            "source_count": len(sources),
            "sdk": SDK_LABEL,
        }
        patch_job(job["id"], state="completed", stage="VR master ready", progress=100, output_manifest=manifest, error_code=None)
        set_group_state(job["capture_group_id"], "vr_ready")


def main():
    while True:
        job = None
        try:
            job = claim_job()
            if job:
                process(job)
            else:
                time.sleep(POLL_SECONDS)
        except Exception as error:
            print(f"worker error: {error}", flush=True)
            if job:
                patch_job(job["id"], state="failed", stage="Processing failed", error_code=str(error)[:300])
                # Leave the group back on 'ready' so a retry can claim it rather
                # than stranding the capture in 'stitching' forever.
                try:
                    set_group_state(job["capture_group_id"], "ready")
                except Exception as reset_error:
                    print(f"could not reset capture group: {reset_error}", flush=True)
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
