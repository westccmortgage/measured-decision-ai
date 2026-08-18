# Measured Decision Insta360 GPU worker

Private runtime for paired X3 INSV sources. The licensed Insta360 package is intentionally excluded from GitHub and must be supplied as a Docker BuildKit secret.

## Runtime target

- x86_64 Ubuntu 22.04
- NVIDIA GPU with CUDA 11.7-compatible driver and NVIDIA Container Toolkit
- Insta360 MediaSDK 3.1.1 `.deb`
- access to the private evidence S3 bucket and Supabase service role

## Build

```bash
DOCKER_BUILDKIT=1 docker build \
  --secret id=insta360_sdk,src=/private/libMediaSDK-dev-3.1.1.0-amd64.tar.xz \
  -t measured-decision/insta360-worker:3.1.1 .
```

The secret may be any form the Insta360 portal hands over, because
`install-sdk.sh` detects which one it is:

- a `.deb` package,
- a `.tar.xz` (or `.tar.gz`) wrapping that `.deb`,
- a `.tar.xz` holding `lib/` and `include/` directly,
- an already extracted directory.

The build stops with a clear message if the package contains no
`libMediaSDK*.so` or no `ins_stitcher.h` — which is what happens if the
**CameraSDK** is supplied by mistake. CameraSDK controls a connected camera and
cannot stitch a file; only MediaSDK can, and only on x86_64.

Never copy, commit, or publish the SDK archive, `.deb`, libraries, headers, or model files.

## Run

Provide `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, and `AWS_S3_BUCKET` through the host secret manager, then run with GPU access:

```bash
docker run --rm --gpus all --env-file /private/mdai-worker.env measured-decision/insta360-worker:3.1.1
```

The worker claims prepared capture jobs, downloads both protected originals, creates a 5760×2880 2:1 HEVC master using optical-flow stitching, FlowState and direction lock, uploads the derivative, and updates Studio progress from 0–100%.

It then **registers the master as an evidence item** pointing at the S3 object,
with `projection: equirectangular` and `vr.playback_ready: true`, descending from
the first lens original through `derivative_of`. Without that row the master
exists in the bucket and nowhere in the product — the Studio lists evidence, not
bucket keys — so the 360 viewer and the Vision Pro link would stay dark after a
successful stitch. Registration is keyed on `storage_path`, so a re-run updates
the same row instead of creating a second one.

A claim is a conditional write (`state=in.(waiting_for_sdk,queued)` on the PATCH
itself), so two workers cannot take the same capture. A failed job releases its
capture group back to `ready` rather than stranding it in `stitching`.

## Optional environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `STITCH_COMMAND` | `/usr/local/bin/stitch360` | Substitute the stitcher, for testing without the SDK |
| `MASTER_WIDTH` / `MASTER_HEIGHT` | `5760` / `2880` | Master size; must stay 2:1 |
| `MASTER_BITRATE` | `80000000` | Encoder bitrate |
| `SDK_LABEL` | `Insta360 MediaSDK` | Recorded in the evidence metadata and manifest |
| `POLL_SECONDS` | `15` | Idle poll interval |

## Verify without the SDK

```bash
python3 workers/insta360/test_worker.py
```

Supabase and S3 are replaced with recorders and the stitcher with `stub_stitch.py`,
which speaks the same arguments and the same progress protocol. The test asserts
that both originals are downloaded, the master is uploaded, exactly one evidence
row is written with the right projection and provenance, progress climbs, and the
capture group ends at `vr_ready`. It proves the parts this project owns; it cannot
prove the stitch itself, which needs the licensed library and a GPU.
