#!/bin/bash
# Measured Decision · 360 worker, unattended.
#
# LAUNCH THIS ON:  Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04)
#                  owner 898082745236 · free · driver 570.172.08 preinstalled
#                  Docker and nvidia-container-toolkit preinstalled
#                  g4dn is a supported instance family for this image
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
# Replace PASTE_SERVICE_ROLE_KEY_HERE below. Nothing else needs changing.

SUPABASE_SERVICE_ROLE_KEY="PASTE_SERVICE_ROLE_KEY_HERE"

set -x
exec > >(tee -a /var/log/mdai-worker.log) 2>&1
export DEBIAN_FRONTEND=noninteractive
# Cheap insurance: this script still runs apt for git and the AWS CLI, and these
# are what hung the previous version.
export NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1 UCF_FORCE_CONFOLD=1

MDAI_VERSION="2026-08-21.1 · runs on the AWS GPU image, no driver install, no reboot"
step() { echo "MDAI STEP: $*" | tee /dev/console; }
stop() { echo "MDAI STOP: $*" | tee /dev/console; exit "${2:-90}"; }
step "starting · ${MDAI_VERSION}"

# A GPU that never stops is the expensive failure here, so the deadline is set
# before anything else can go wrong.
shutdown -h +180

mkdir -p /opt/mdai
cat > /opt/mdai/worker.env <<ENV
SUPABASE_URL=https://hbqlhplgqwuesrovbiye.supabase.co
SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}
AWS_REGION=us-east-2
AWS_S3_BUCKET=measured-decision-production-808454010303
MAX_IDLE_POLLS=20
ENV
chmod 600 /opt/mdai/worker.env
set -a; . /opt/mdai/worker.env; set +a

TOKEN="$(curl -sS --max-time 10 -X PUT http://169.254.169.254/latest/api/token \
  -H 'X-aws-ec2-metadata-token-ttl-seconds: 300' || true)"
INSTANCE_ID="$(curl -sS --max-time 10 -H "X-aws-ec2-metadata-token: $TOKEN" \
  http://169.254.169.254/latest/meta-data/instance-id || echo unknown)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# The log is the only thing anyone can look at afterwards, so it leaves by two
# routes: the bucket, and the serial console the EC2 page reads back with one
# button and no credentials.
finish() {
  local code=$?
  echo "=== finished with status ${code} ==="
  aws s3 cp /var/log/mdai-worker.log \
    "s3://${AWS_S3_BUCKET}/worker-logs/${STAMP}-${INSTANCE_ID}-worker.log" \
    --region "${AWS_REGION}" || true
  {
    echo "===== MDAI log (tail) · exit ${code} ====="
    tail -n 200 /var/log/mdai-worker.log 2>/dev/null
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
nvidia-smi || stop "this machine cannot see its GPU. Launch on the Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04). No capture was touched." 94
docker run --rm --gpus all nvidia/cuda:11.7.1-base-ubuntu22.04 nvidia-smi ||
  stop "the driver works but Docker cannot reach the GPU. No capture was touched." 95

aws sts get-caller-identity --region "$AWS_REGION" ||
  stop "this instance has no working AWS identity — check its IAM role" 91
aws s3 ls "s3://${AWS_S3_BUCKET}/private-sdk/" --region "$AWS_REGION" ||
  stop "the role cannot read s3://${AWS_S3_BUCKET}/private-sdk/" 92

# ------------------------------------------------------------------- the SDK
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

step "running the queue"
docker run --rm --gpus all --env-file /opt/mdai/worker.env \
  measured-decision/insta360-worker:3.1.1

step "queue finished, shutting down"
