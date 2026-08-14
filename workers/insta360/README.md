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
  --secret id=insta360_deb,src=/private/libMediaSDK-dev-3.1.1.0-amd64.deb \
  -t measured-decision/insta360-worker:3.1.1 .
```

Never copy, commit, or publish the SDK archive, `.deb`, libraries, headers, or model files.

## Run

Provide `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, and `AWS_S3_BUCKET` through the host secret manager, then run with GPU access:

```bash
docker run --rm --gpus all --env-file /private/mdai-worker.env measured-decision/insta360-worker:3.1.1
```

The worker claims prepared capture jobs, downloads both protected originals, creates a 5760×2880 2:1 HEVC master using optical-flow stitching, FlowState and direction lock, uploads the derivative, and updates Studio progress from 0–100%.
