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

headers = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}", "Content-Type": "application/json"}
s3 = boto3.client(
    "s3",
    region_name=os.getenv("AWS_REGION"),
    endpoint_url=os.getenv("AWS_S3_ENDPOINT") or None,
)


def api(method, path, **kwargs):
    response = requests.request(method, f"{SUPABASE_URL}/rest/v1/{path}", headers=headers, timeout=60, **kwargs)
    response.raise_for_status()
    return response.json() if response.content else None


def patch_job(job_id, **values):
    values["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    api("PATCH", f"capture_360_jobs?id=eq.{job_id}", data=json.dumps(values))


def claim_job():
    select = "id,property_id,capture_group_id,capture_360_groups!inner(source_evidence_ids,capture_key,processing_profile)"
    rows = api("GET", f"capture_360_jobs?state=in.(waiting_for_sdk,queued)&select={select}&order=created_at.asc&limit=1")
    if not rows:
        return None
    job = rows[0]
    patch_job(job["id"], state="processing", stage="Downloading protected originals", progress=8)
    return job


def evidence_records(ids):
    joined = ",".join(ids)
    return api("GET", f"evidence_items?id=in.({joined})&select=id,original_filename,storage_bucket,storage_path&order=original_filename.asc")


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
        command = ["/usr/local/bin/stitch360"]
        for source in local_inputs:
            command += ["--input", str(source)]
        command += ["--output", str(output), "--width", "5760", "--height", "2880", "--bitrate", "80000000"]
        patch_job(job["id"], stage="Optical-flow stitching and FlowState", progress=10)

        process_handle = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        for line in process_handle.stdout or []:
            match = re.search(r'"progress":(\d+)', line)
            if match:
                sdk_progress = int(match.group(1))
                patch_job(job["id"], stage="Creating 5.7K HEVC VR master", progress=min(92, 10 + int(sdk_progress * 0.82)))
        if process_handle.wait() != 0 or not output.exists():
            raise RuntimeError("Insta360 MediaSDK stitching failed")

        object_key = f"processed/360/{job['property_id']}/{job['capture_group_id']}/vr-master-hevc.mp4"
        patch_job(job["id"], stage="Securing VR master", progress=94)
        s3.upload_file(str(output), OUTPUT_BUCKET, object_key, ExtraArgs={"ContentType": "video/mp4"})
        manifest = {
            "vr_master": {"bucket": OUTPUT_BUCKET, "object_key": object_key, "projection": "equirectangular", "width": 5760, "height": 2880, "codec": "hevc"},
            "source_count": len(sources),
            "sdk": "Insta360 MediaSDK 3.1.1",
        }
        patch_job(job["id"], state="completed", stage="VR master ready", progress=100, output_manifest=manifest, error_code=None)
        api("PATCH", f"capture_360_groups?id=eq.{job['capture_group_id']}", data=json.dumps({"state": "vr_ready"}))


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
            time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
