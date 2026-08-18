#!/bin/bash
# Measured Decision · 360 worker, unattended.
#
# Paste this into EC2 → Launch instance → Advanced details → User data. The
# instance then does the whole job on its own: pulls the licensed SDK from the
# private bucket, builds the image, stitches and trims every queued capture,
# writes its log back to the bucket, and stops itself. No terminal, no SSH, no
# access keys.
#
# Replace PASTE_SERVICE_ROLE_KEY_HERE before launching. Everything else is
# already correct for this account.

set -x
exec > >(tee -a /var/log/mdai-worker.log) 2>&1

BUCKET="measured-decision-production-808454010303"
REGION="us-east-2"
export SUPABASE_URL="https://hbqlhplgqwuesrovbiye.supabase.co"
export SUPABASE_SERVICE_ROLE_KEY="PASTE_SERVICE_ROLE_KEY_HERE"

# A GPU that never stops is the expensive failure here, so the shutdown is
# scheduled before anything else can go wrong. The normal path stops the
# instance sooner; this is only the backstop.
shutdown -h +180

INSTANCE_ID="$(TOKEN=$(curl -sS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 300') \
  && curl -sS -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_KEY="worker-logs/${STAMP}-${INSTANCE_ID:-unknown}.log"

finish() {
  local status=$1
  echo "=== finished with status ${status} ==="
  # The log is the only thing anyone can look at afterwards, so it goes to the
  # bucket before the machine stops.
  aws s3 cp /var/log/mdai-worker.log "s3://${BUCKET}/${LOG_KEY}" --region "$REGION" || true
  shutdown -h now
}
trap 'finish $?' EXIT

command -v aws >/dev/null || { apt-get update -y && apt-get install -y awscli; }
command -v git >/dev/null || { apt-get update -y && apt-get install -y git; }

# The Deep Learning AMI starts Docker itself, but user data can run before it is
# up. Waiting is cheaper than failing on the build.
for _ in $(seq 1 60); do
  systemctl is-active --quiet docker && break
  sleep 5
done
docker run --rm --gpus all nvidia/cuda:11.7.1-base-ubuntu22.04 nvidia-smi

install -d -o ubuntu -g ubuntu /home/ubuntu/private
aws s3 cp --recursive "s3://${BUCKET}/private-sdk/" /home/ubuntu/private/ --region "$REGION"
ls -R /home/ubuntu/private

cd /home/ubuntu
rm -rf measured-decision-ai
git clone --depth 1 https://github.com/westccmortgage/measured-decision-ai.git
cd measured-decision-ai/workers/insta360

DOCKER_BUILDKIT=1 docker build \
  --secret id=insta360_sdk,src=/home/ubuntu/private \
  -t measured-decision/insta360-worker:3.1.1 .

# Proves claiming, progress, trimming and publishing before a real capture is
# touched. If this fails the build is wrong and the queue must not be run.
python3 test_worker.py

docker run --rm --gpus all \
  -e SUPABASE_URL \
  -e SUPABASE_SERVICE_ROLE_KEY \
  -e AWS_REGION="$REGION" \
  -e AWS_S3_BUCKET="$BUCKET" \
  -e MAX_IDLE_POLLS=20 \
  measured-decision/insta360-worker:3.1.1
