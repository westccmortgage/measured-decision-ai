"""Exercises the worker without the licensed SDK, a GPU, S3, or Supabase.

    python3 workers/insta360/test_worker.py

Supabase and S3 are replaced with recorders and the stitcher with a stub that
speaks the same argument and progress protocol, so the parts this project owns
— claiming, progress, publishing the master as evidence — stay verifiable.
"""

import json, sys, types, os, pathlib

# The worker imports boto3 and requests at module load; neither is needed to
# exercise its logic, so both are replaced before the import.
uploads = []
downloads = []
class FakeS3:
    def download_file(self, bucket, key, target):
        downloads.append((bucket, key))
        pathlib.Path(target).write_bytes(b"\x00" * 128)
    def upload_file(self, path, bucket, key, ExtraArgs=None):
        uploads.append({"bucket": bucket, "key": key, "size": pathlib.Path(path).stat().st_size, "args": ExtraArgs})
boto3_stub = types.ModuleType("boto3"); boto3_stub.client = lambda *a, **k: FakeS3()
sys.modules["boto3"] = boto3_stub
requests_stub = types.ModuleType("requests"); requests_stub.request = lambda *a, **k: None
sys.modules["requests"] = requests_stub

os.environ.update({
    "SUPABASE_URL": "https://example.supabase.co", "SUPABASE_SERVICE_ROLE_KEY": "service",
    "AWS_S3_BUCKET": "measured-decision-production", "AWS_REGION": "us-east-2",
    "STITCH_COMMAND": str(pathlib.Path(__file__).with_name("stub_stitch.py")),
    "SDK_LABEL": "stub-stitcher",
})
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import worker

calls = []
def fake_api(method, path, extra_headers=None, **kwargs):
    body = json.loads(kwargs["data"]) if "data" in kwargs else None
    calls.append({"method": method, "path": path, "body": body, "prefer": (extra_headers or {}).get("Prefer")})
    if method == "GET" and path.startswith("evidence_items?id=in."):
        return [
            {"id": "src-00", "original_filename": "VID_20250222_043654_00_027.insv",
             "storage_bucket": "measured-decision-production", "storage_path": "organizations/o/properties/p/evidence/a.insv",
             "captured_at": "2026-02-22T04:36:54Z", "created_by": "user-1"},
            {"id": "src-10", "original_filename": "VID_20250222_043654_10_027.insv",
             "storage_bucket": "measured-decision-production", "storage_path": "organizations/o/properties/p/evidence/b.insv",
             "captured_at": "2026-02-22T04:36:54Z", "created_by": "user-1"},
        ]
    if method == "POST" and path.startswith("evidence_items"):
        return [{"id": "master-1"}]
    return []
worker.api = fake_api
worker.s3 = FakeS3()

job = {"id": "job-1", "organization_id": "org-1", "property_id": "prop-1", "capture_group_id": "grp-1",
       "capture_360_groups": {"source_evidence_ids": ["src-00", "src-10"], "capture_key": "vid_20250222_043654_027",
                              "space_id": "space-garage", "processing_profile": {}}}
worker.process(job)

print("DOWNLOADED:", len(downloads), "originals")
print("UPLOADED  :", uploads[0]["key"], "| content-type:", uploads[0]["args"])
posts = [c for c in calls if c["method"] == "POST"]
assert len(posts) == 1, "the master must be registered exactly once"
payload = posts[0]["body"]
print("EVIDENCE ROW:")
for key in ("space_id", "storage_provider", "storage_bucket", "original_filename", "media_type", "mime_type", "derivative_of", "created_by"):
    print(f"  {key} = {payload[key]}")
print("  byte_size =", payload["byte_size"])
print("  source_metadata.projection =", payload["source_metadata"]["projection"])
print("  source_metadata.vr.playback_ready =", payload["source_metadata"]["vr"]["playback_ready"])
print("  storage_path =", payload["storage_path"])
print("ON CONFLICT :", posts[0]["path"], "|", posts[0]["prefer"])
progress = [c["body"]["progress"] for c in calls if c["method"] == "PATCH" and "capture_360_jobs" in c["path"] and "progress" in (c["body"] or {})]
print("PROGRESS    :", progress)
states = [(c["path"].split("?")[0], c["body"].get("state")) for c in calls if c["method"] == "PATCH" and c["body"] and "state" in c["body"]]
print("STATES      :", states)
manifest = [c for c in calls if c["method"] == "PATCH" and c["body"] and c["body"].get("state") == "completed"][0]["body"]["output_manifest"]
print("MANIFEST    :", json.dumps(manifest["vr_master"]))
assert payload["source_metadata"]["projection"] == "equirectangular"
assert payload["derivative_of"] == "src-00", "the master must descend from the first lens original"
assert ("capture_360_groups", "vr_ready") in states
print("\nOK: master reaches the record, not just the bucket")
