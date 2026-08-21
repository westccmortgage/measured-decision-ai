#!/bin/bash
# Measured Decision · 360 worker, unattended.
#
# LAUNCH THIS ON:  Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 22.04)
#                  owner 898082745236 (AWS) · free · g4dn is a supported family
#                  NVIDIA driver, Docker and nvidia-container-toolkit preinstalled
#
#                  22.04 rather than 24.04 because the Insta360 MediaSDK is built
#                  for 22.04 with CUDA 11.7, and so is the image this worker
#                  runs in. Either host works — this one matches the vendor.
#
# Eight machines failed before this file was rewritten, and every one of them
# that left a log failed the same way: the distribution driver installer chose
# nvidia-headless-no-dkms-*-server-open, a package family that ships no
# nvidia-smi. The machine held a working T4 it could not see, the container
# toolkit had nothing to inject, and every CUDA job died without explaining
# itself. Installing the driver from NVIDIA's own repository fixed that and
# introduced a worse one: apt stopped to ask which services to restart, and in
# cloud-init nobody answers, so the boot script waited forever and left no trace.
#
# So this file no longer installs a driver at all. AWS publishes an image with
# the driver, Docker and the container toolkit already in it, and using it
# removes every failure this project has actually had. There is no reboot and no
# systemd unit either: with nothing to install that needs one, the whole run
# happens here, which also removes the failure where logs never appeared because
# the second boot never came.
#
# The machine now also says what it is doing, into the same record the Studio
# reads. Every earlier machine was silent until someone fetched a log by hand,
# so "nothing is happening" and "it stopped an hour ago" looked identical.
#
# Replace PASTE_SERVICE_ROLE_KEY_HERE below. Nothing else needs changing.

SUPABASE_SERVICE_ROLE_KEY="PASTE_SERVICE_ROLE_KEY_HERE"

set -x
exec > >(tee -a /var/log/mdai-worker.log) 2>&1
export DEBIAN_FRONTEND=noninteractive
# Cheap insurance: this script still runs apt for git and the AWS CLI, and these
# are what hung the previous version.
export NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1 UCF_FORCE_CONFOLD=1

MDAI_VERSION="2026-08-21.3 · AWS GPU image (Ubuntu 22.04), no driver install, no reboot"
SUPABASE_URL="https://hbqlhplgqwuesrovbiye.supabase.co"
AWS_REGION="us-east-2"
AWS_S3_BUCKET="measured-decision-production-808454010303"

TOKEN="$(curl -sS --max-time 10 -X PUT http://169.254.169.254/latest/api/token \
  -H 'X-aws-ec2-metadata-token-ttl-seconds: 300' || true)"
INSTANCE_ID="$(curl -sS --max-time 10 -H "X-aws-ec2-metadata-token: $TOKEN" \
  http://169.254.169.254/latest/meta-data/instance-id || echo unknown)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_KEY="worker-logs/${STAMP}-${INSTANCE_ID}-worker.log"
LOG_URL="s3://${AWS_S3_BUCKET}/${LOG_KEY}"

# The service role key is never traced and never logged. It used to be: the
# previous version sourced an env file under `set -x`, which printed the key
# into a log that is uploaded to S3 and dumped to the serial console, where
# anyone who can read either could take it. xtrace is off inside this function
# for that reason, and the log is filtered once more on the way out.
RUN_ID=""
MDAI_STATE="starting"
report() {
  { set +x; } 2>/dev/null
  local state="$1" text="$2" code="$3" msg="$4" now body out
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  text="$(printf '%s' "$text" | tr -d '"\\' | tr '\n' ' ')"
  msg="$(printf '%s' "$msg" | tr -d '"\\' | tr '\n' ' ')"
  body="\"state\":\"${state}\",\"step\":\"${text}\",\"last_seen_at\":\"${now}\""
  [ -n "$code" ] && body="${body},\"exit_code\":${code}"
  [ -n "$msg" ] && body="${body},\"message\":\"${msg}\""
  case "$state" in
    finished|stopped) body="${body},\"finished_at\":\"${now}\",\"log_url\":\"${LOG_URL}\"" ;;
  esac
  if [ -z "$RUN_ID" ]; then
    out="$(curl -sS --max-time 15 -X POST "${SUPABASE_URL}/rest/v1/worker_machine_runs" \
      -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
      -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
      -H 'Content-Type: application/json' -H 'Prefer: return=representation' \
      -d "{\"instance_id\":\"${INSTANCE_ID}\",\"region\":\"${AWS_REGION}\",\"worker_version\":\"${MDAI_VERSION}\",${body}}" 2>/dev/null || true)"
    RUN_ID="$(printf '%s' "$out" | sed -n 's/.*"id":"\([0-9a-f-]\{36\}\)".*/\1/p' | head -n1)"
  else
    curl -sS --max-time 15 -X PATCH "${SUPABASE_URL}/rest/v1/worker_machine_runs?id=eq.${RUN_ID}" \
      -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
      -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
      -H 'Content-Type: application/json' -d "{${body}}" >/dev/null 2>&1 || true
  fi
  set -x
}

step() { echo "MDAI STEP: $*" | tee /dev/console; report "$MDAI_STATE" "$*" "" ""; }
stop() { echo "MDAI STOP: $1" | tee /dev/console; report stopped "Stopped before the queue" "${2:-90}" "$1"; exit "${2:-90}"; }
step "starting · ${MDAI_VERSION}"

# A GPU that never stops is the expensive failure here, so the deadline is set
# before anything else can go wrong.
shutdown -h +180

mkdir -p /opt/mdai
cat > /opt/mdai/worker.env <<ENV
SUPABASE_URL=${SUPABASE_URL}
SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}
AWS_REGION=${AWS_REGION}
AWS_S3_BUCKET=${AWS_S3_BUCKET}
MAX_IDLE_POLLS=20
ENV
chmod 600 /opt/mdai/worker.env
export AWS_REGION AWS_S3_BUCKET

# The log is the only thing anyone can look at afterwards, so it leaves by two
# routes: the bucket, and the serial console the EC2 page reads back with one
# button and no credentials. It is filtered on the way out — a copy of the log
# is made rather than edited in place, because the running shell still holds the
# original open and an in-place edit would silently truncate what gets uploaded.
finish() {
  local code=$?
  echo "=== finished with status ${code} ==="
  { set +x; } 2>/dev/null
  sed "s|${SUPABASE_SERVICE_ROLE_KEY}|REDACTED|g" /var/log/mdai-worker.log > /tmp/mdai-upload.log 2>/dev/null || true
  set -x
  if [ "${code}" = "0" ]; then report finished "Queue worked to the end" 0 ""
  else report stopped "Stopped with status ${code}" "${code}" ""; fi
  aws s3 cp /tmp/mdai-upload.log "${LOG_URL}" --region "${AWS_REGION}" || true
  {
    echo "===== MDAI log (tail) · exit ${code} ====="
    tail -n 200 /tmp/mdai-upload.log 2>/dev/null
    echo "===== MDAI end ====="
  } > /dev/console 2>&1 || true
  shutdown -h now
}
trap finish EXIT

# ---------------------------------------------------------------- prerequisites
step "checking what the image already provides"
command -v docker >/dev/null || stop "this image has no Docker — it is not the AWS GPU image" 96
command -v git >/dev/null || apt-get -o DPkg::Lock::Timeout=600 -y install -y git
command -v aws >/dev/null || {
  curl -fsSL --max-time 300 "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip &&
    unzip -q /tmp/awscliv2.zip -d /tmp && /tmp/aws/install --update
}
command -v aws >/dev/null || stop "no AWS CLI, so neither the SDK nor the log can move" 90

# The GPU is checked on the host and inside a container before anything is
# claimed. A queue emptied into failures by an invisible GPU is worse than a
# queue not started, and that is exactly what happened on 19 August.
step "GPU check"
nvidia-smi || stop "this machine cannot see its GPU. Launch on the Deep Learning Base OSS Nvidia Driver GPU AMI, owner 898082745236. No capture was touched." 94
docker run --rm --gpus all nvidia/cuda:11.7.1-base-ubuntu22.04 nvidia-smi ||
  stop "the driver works but Docker cannot reach the GPU. No capture was touched." 95

aws sts get-caller-identity --region "$AWS_REGION" ||
  stop "this instance has no working AWS identity — check its IAM role" 91
aws s3 ls "s3://${AWS_S3_BUCKET}/private-sdk/" --region "$AWS_REGION" ||
  stop "the role cannot read s3://${AWS_S3_BUCKET}/private-sdk/" 92

# ------------------------------------------------------------------- the SDK
MDAI_STATE="preparing"
step "fetching the licensed Insta360 SDK"
rm -rf /opt/mdai/private /opt/mdai/sdk /opt/mdai/insta360-sdk.tar
mkdir -p /opt/mdai/private /opt/mdai/sdk
aws s3 cp --recursive "s3://${AWS_S3_BUCKET}/private-sdk/" /opt/mdai/private/ --region "$AWS_REGION"

# The bucket may hold the vendor download in any of its shapes — the .deb beside
# models/, or the .tar.xz that wraps both, next to CameraSDK archives that are a
# different product. Pack what matters into one predictable input.
SDK_ARCHIVE="$(find /opt/mdai/private -name 'libMediaSDK*.tar*' -print -quit)"
if [ -n "$SDK_ARCHIVE" ]; then tar -xf "$SDK_ARCHIVE" -C /opt/mdai/sdk
else cp -a /opt/mdai/private/. /opt/mdai/sdk/; fi
find /opt/mdai/sdk -name 'libMediaSDK*' -print -quit | grep -q . ||
  stop "no libMediaSDK found in private-sdk/ — check what that folder holds" 93
tar -cf /opt/mdai/insta360-sdk.tar -C /opt/mdai/sdk .

# ------------------------------------------------------------------- the worker
step "building the worker image"
rm -rf /opt/mdai/repo
git clone --depth 1 https://github.com/westccmortgage/measured-decision-ai.git /opt/mdai/repo
cd /opt/mdai/repo/workers/insta360 || stop "the repository layout changed" 97
# The build reads the SDK from its own context. It stays on this machine and
# dies with it. A BuildKit secret cannot carry it: secrets are capped at 500KiB
# and this is 230MB, which is what "tar: Cannot open" meant on 19 August.
cp /opt/mdai/insta360-sdk.tar ./insta360-sdk.tar
DOCKER_BUILDKIT=1 docker build -t measured-decision/insta360-worker:3.1.1 . ||
  stop "the worker image did not build" 98

step "self-test before touching the queue"
python3 test_worker.py || stop "the worker failed its own test; the queue was not touched" 99

# Past this line the machine is allowed to touch captures, and it keeps saying so
# itself: the worker updates the same row with the capture it is stitching.
MDAI_STATE="working"
step "running the queue"
[ -n "$RUN_ID" ] && echo "MDAI_RUN_ID=${RUN_ID}" >> /opt/mdai/worker.env
docker run --rm --gpus all --env-file /opt/mdai/worker.env \
  measured-decision/insta360-worker:3.1.1
