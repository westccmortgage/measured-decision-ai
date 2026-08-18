# Measured Decision Insta360 GPU worker

Private runtime for paired X3 INSV sources. The licensed Insta360 package is intentionally excluded from GitHub and must be supplied as a Docker BuildKit secret.

## What the vendor documents

The `ReadMe.md` shipped with MediaSDK 3.1.1 states:

- install with `apt-get install ./libMediaSDK-dev*-amd64.deb`, remove with
  `apt-get remove libMediaSDK-dev`;
- verify by running `stitcherSDKTest`, which the package provides;
- build against it with `g++ main.cc -std=c++11 -lMediaSDK -lpthread` — no
  include or library flags, because the package installs into system paths;
- built for **CUDA 11.7** and **g++ 11.4.0 (Ubuntu 22.04)**.

This image matches all of it: `nvidia/cuda:11.7.1-devel-ubuntu22.04` carries
g++ 11.4.0, and `stitch360.cc` is compiled with `-std=c++11` rather than a newer
standard the vendor never tested its headers against. `install-sdk.sh` fails the
build if `libMediaSDK` is not on the loader path afterwards, so a bad package is
caught at build time instead of at the link step.

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

### AI model files

The download folder holds a `models/` directory beside the `.deb`
(`ai_stitcher_v1.ins`, `ai_stitcher_v2.ins`, `colorplus_model.ins`, deflicker,
defringe, denoise, and the `coolingshell/` profiles). Those weights are **not**
inside the package. A build that installs only the `.deb` leaves them behind and
the AI passes fail at runtime rather than at build time, so `install-sdk.sh`
copies them to `/usr/local/share/insta360/models`.

Point the secret at the whole vendor folder and both the package and the models
are picked up in one step:

```bash
DOCKER_BUILDKIT=1 docker build \
  --secret id=insta360_sdk,src=/private/libMediaSDK-dev-3.1.1.0-amd64.tar.xz \
  -t measured-decision/insta360-worker:3.1.1 .
```

The vendor example settles how the SDK finds them: `ins::SetModelFileRootDir()`
is an explicit call, and the demo's own help text defaults it to `./models/`.
Nothing is implicit. `stitch360.cc` therefore calls it with `--models`, the
worker passes `MODELS_DIR` (default `/app/models`), and the image places the
weights there beside the worker's `WORKDIR`.

The same example shows two calls that are equally mandatory and equally silent
when omitted: `ins::InitEnv()` starts the SDK, and `ins::SetLogLevel()` sets its
verbosity. Constructing a `VideoStitcher` does not imply either.

Never copy, commit, or publish the SDK archive, `.deb`, libraries, headers, or model files.

Host setup, connecting, and the stop-when-idle batch run are in
[`AWS.md`](AWS.md).

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
| `MAX_IDLE_POLLS` | `0` (never) | Exit after this many empty polls, so a rented GPU can shut down between batches |

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

## Camera handling window

After stitching, the worker cuts the operator's entry and exit out of the master
with `ffmpeg -ss … -t … -c copy` — a stream copy, so nothing is re-encoded and
no quality is lost. The window follows the same policy as the Studio
(`studio/trim360.js`): ten seconds off each end, five when ten would not leave
enough, nothing under fifteen seconds of remaining footage. `FFMPEG_COMMAND`,
`FFPROBE_COMMAND`, `TRIM_PREFERRED_SECONDS`, `TRIM_MINIMUM_SECONDS` and
`TRIM_KEEP_AT_LEAST_SECONDS` override it.

The protected INSV originals are never touched. If ffprobe or ffmpeg fails the
whole master is published and the window is recorded on the evidence instead, so
the Studio still opens the capture inside it.

`python3 workers/insta360/test_worker.py` exercises the cut with stubs for the
stitcher, ffmpeg and ffprobe — no SDK, GPU, S3 or Supabase.
