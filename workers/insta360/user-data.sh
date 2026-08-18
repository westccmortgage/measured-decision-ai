#!/bin/bash
# Measured Decision · 360 worker, unattended, on stock Ubuntu 22.04.
#
# Paste this into EC2 → Launch instance → Advanced details → User data, on a
# g4dn.xlarge running the plain "Ubuntu Server 22.04 LTS" image from the Quick
# Start tab. Nothing else is needed: this installs the NVIDIA driver, Docker and
# the container toolkit itself, then pulls the licensed SDK from the private
# bucket, builds the worker, stitches and trims every queued capture, writes its
# log back to the bucket and stops the instance.
#
# The deep-learning marketplace images are deliberately not used: the ones the
# console offers are third-party repackagings billed per hour on top of EC2.
#
# Replace PASTE_SERVICE_ROLE_KEY_HERE below. Everything else is already correct
# for this account.

SUPABASE_SERVICE_ROLE_KEY="PASTE_SERVICE_ROLE_KEY_HERE"

set -x
exec > >(tee -a /var/log/mdai-setup.log) 2>&1
export DEBIAN_FRONTEND=noninteractive

# A GPU that never stops is the expensive failure here, so the shutdown is
# scheduled before anything else can go wrong. Both stages set it again.
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

# Cloud-init races with unattended-upgrades for the dpkg lock on a fresh boot,
# so every apt call waits instead of failing.
APT="apt-get -o DPkg::Lock::Timeout=600 -y"
$APT update
$APT install -y git curl gnupg awscli ubuntu-drivers-common

# The T4 driver. --gpgpu picks the headless server build, which is what a
# machine with no display wants.
ubuntu-drivers install --gpgpu || $APT install -y nvidia-driver-535-server

# Docker from Docker's own repository, not Ubuntu's: the build needs BuildKit
# and the buildx plugin for --secret, and only this package ships them.
curl -fsSL https://get.docker.com | sh

install -m 0755 -d /usr/share/keyrings
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey |
  gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list |
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  > /etc/apt/sources.list.d/nvidia-container-toolkit.list
$APT update
$APT install -y nvidia-container-toolkit
nvidia-ctk runtime configure --runtime=docker

cat > /opt/mdai/run.sh <<'RUN'
#!/bin/bash
set -x
exec > >(tee -a /var/log/mdai-worker.log) 2>&1
set -a; . /opt/mdai/worker.env; set +a
shutdown -h +180

TOKEN="$(curl -sS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')"
INSTANCE_ID="$(curl -sS -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

finish() {
  echo "=== finished with status $? ==="
  # The log is the only thing anyone can look at afterwards, so it goes to the
  # bucket before the machine stops.
  for file in /var/log/mdai-setup.log /var/log/mdai-worker.log; do
    aws s3 cp "$file" "s3://${AWS_S3_BUCKET}/worker-logs/${STAMP}-${INSTANCE_ID}-$(basename "$file")" \
      --region "$AWS_REGION" || true
  done
  shutdown -h now
}
trap finish EXIT

nvidia-smi
docker run --rm --gpus all nvidia/cuda:11.7.1-base-ubuntu22.04 nvidia-smi

mkdir -p /opt/mdai/private
aws s3 cp --recursive "s3://${AWS_S3_BUCKET}/private-sdk/" /opt/mdai/private/ --region "$AWS_REGION"
ls -R /opt/mdai/private

rm -rf /opt/mdai/repo
git clone --depth 1 https://github.com/westccmortgage/measured-decision-ai.git /opt/mdai/repo
cd /opt/mdai/repo/workers/insta360

DOCKER_BUILDKIT=1 docker build \
  --secret id=insta360_sdk,src=/opt/mdai/private \
  -t measured-decision/insta360-worker:3.1.1 .

# Proves claiming, progress, trimming and publishing before a real capture is
# touched. If this fails the build is wrong and the queue must not be run.
python3 test_worker.py

docker run --rm --gpus all --env-file /opt/mdai/worker.env \
  measured-decision/insta360-worker:3.1.1
RUN
chmod +x /opt/mdai/run.sh

# The driver's kernel module is only guaranteed to be loaded after a restart, so
# the job runs on the second boot rather than gambling on modprobe here.
cat > /etc/systemd/system/mdai-worker.service <<'UNIT'
[Unit]
Description=Measured Decision 360 worker
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/opt/mdai/run.sh
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
UNIT
systemctl enable mdai-worker.service

shutdown -r now
