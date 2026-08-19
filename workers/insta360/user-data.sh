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
$APT install -y git curl gnupg unzip ubuntu-drivers-common
$APT install -y awscli || true

# Everything this machine does depends on reaching the bucket: the SDK comes
# from it and the log goes back to it. If the distribution package is missing or
# broken the run is blind, so the official installer is the fallback rather than
# an afterthought.
if ! command -v aws >/dev/null; then
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip &&
    unzip -q /tmp/awscliv2.zip -d /tmp && /tmp/aws/install --update
fi
command -v aws || echo "MDAI: aws CLI could not be installed"

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
  # A run whose log upload fails is a run nobody can explain: no aws CLI, no
  # bucket write, no terminal. The serial console needs no credentials at all
  # and the EC2 console reads it back with one button, so the story survives
  # even when everything else is unavailable.
  {
    echo "===== MDAI worker log (tail) ====="
    tail -n 250 /var/log/mdai-worker.log 2>/dev/null
    echo "===== MDAI setup log (tail) ====="
    tail -n 150 /var/log/mdai-setup.log 2>/dev/null
    echo "===== MDAI end of logs ====="
  } > /dev/console 2>&1 || true
  shutdown -h now
}
trap finish EXIT

nvidia-smi
docker run --rm --gpus all nvidia/cuda:11.7.1-base-ubuntu22.04 nvidia-smi

# Check the two things the whole run rests on, and say plainly which one is
# missing. Grinding through a 20-minute build to fail on an empty secret wastes
# GPU time and explains nothing.
if ! command -v aws >/dev/null; then
  echo "MDAI STOP: the aws CLI is not installed, so neither the SDK nor the log can move" > /dev/console
  exit 90
fi
aws sts get-caller-identity --region "$AWS_REGION" ||
  { echo "MDAI STOP: this instance has no working AWS identity — check its IAM role" > /dev/console; exit 91; }
aws s3 ls "s3://${AWS_S3_BUCKET}/private-sdk/" --region "$AWS_REGION" ||
  { echo "MDAI STOP: the role cannot read s3://${AWS_S3_BUCKET}/private-sdk/ — check the role's S3 policy" > /dev/console; exit 92; }

mkdir -p /opt/mdai/private
aws s3 cp --recursive "s3://${AWS_S3_BUCKET}/private-sdk/" /opt/mdai/private/ --region "$AWS_REGION"
ls -R /opt/mdai/private

# The build takes exactly one file as its secret, and the bucket may hold the
# vendor download in any of its shapes — the .deb beside models/, or the .tar.xz
# that wraps both, next to CameraSDK archives that are a different product. Pack
# what matters into one tar so the build has a single, predictable input.
rm -rf /opt/mdai/sdk /opt/mdai/insta360-sdk.tar
mkdir -p /opt/mdai/sdk
SDK_ARCHIVE="$(find /opt/mdai/private -name 'libMediaSDK*.tar*' -print -quit)"
if [ -n "$SDK_ARCHIVE" ]; then
  tar -xf "$SDK_ARCHIVE" -C /opt/mdai/sdk
else
  cp -a /opt/mdai/private/. /opt/mdai/sdk/
fi
tar -cf /opt/mdai/insta360-sdk.tar -C /opt/mdai/sdk .
ls -R /opt/mdai/sdk | head -50
# An empty secret builds nothing but takes the full image pull to find out.
if ! find /opt/mdai/sdk -name 'libMediaSDK*' -print -quit | grep -q .; then
  echo "MDAI STOP: no libMediaSDK found in the bucket folder — check what private-sdk/ holds" > /dev/console
  exit 93
fi

rm -rf /opt/mdai/repo
git clone --depth 1 https://github.com/westccmortgage/measured-decision-ai.git /opt/mdai/repo
cd /opt/mdai/repo/workers/insta360
# The build reads the SDK from its own context, so the packed archive goes next
# to the Dockerfile. It stays on this machine and dies with it.
cp /opt/mdai/insta360-sdk.tar ./insta360-sdk.tar

DOCKER_BUILDKIT=1 docker build -t measured-decision/insta360-worker:3.1.1 .

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
