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

# Ubuntu 22.04 and later ship needrestart, which interrupts apt to ask which
# services should be restarted. In an interactive shell that is a prompt; in
# cloud-init there is nobody to answer it and the whole boot script waits
# forever. Installing a driver churns enough shared libraries to trigger it, and
# a machine stuck here never reboots, never runs the worker, and never uploads a
# log — which is exactly the silence this produced.
export NEEDRESTART_MODE=a
export NEEDRESTART_SUSPEND=1
export UCF_FORCE_CONFOLD=1

# Printed first so a log always says which version of this file produced it.
# Half of the confusion in this project came from a machine quietly running an
# older script than the one being discussed.
MDAI_USER_DATA_VERSION="2026-08-20.2 · needrestart disarmed, staged console markers, setup log uploaded before reboot"
echo "MDAI user-data ${MDAI_USER_DATA_VERSION}" | tee /dev/console

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
APT="apt-get -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold -y"

# Every stage says where it got to, on the serial console, which the EC2 page
# reads back with one button and no credentials. A machine that dies mid-setup
# used to leave nothing at all: the log only reaches the bucket after the
# reboot, so a setup that never finished was indistinguishable from a setup that
# never started.
step() { echo "MDAI STEP: $*" | tee /dev/console; }
step "base packages"
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

# ---------------------------------------------------------------- the T4 driver
#
# This is the step that has failed every time, so it is written to be checked
# rather than hoped over. `ubuntu-drivers install --gpgpu` installs a driver but
# deliberately stops short of the user tools: the machine ends up holding a GPU
# it cannot see, nvidia-smi is missing, the container toolkit has nothing to
# inject, and every CUDA job dies without explaining itself. That is exactly
# what happened on 19 August and it cost a whole queue.
#
# NVIDIA's own CUDA repository is tried first because it is what NVIDIA
# documents for cloud instances: cuda-drivers pulls the proprietary driver, its
# DKMS module and nvidia-smi together, so there is no half-installed state to
# discover later. The distribution route stays as the fallback.
install_nvidia_driver() {
  local codename="ubuntu2404"
  . /etc/os-release 2>/dev/null
  case "${VERSION_ID:-24.04}" in
    22.04) codename="ubuntu2204" ;;
    24.04) codename="ubuntu2404" ;;
  esac

  curl -fsSL "https://developer.download.nvidia.com/compute/cuda/repos/${codename}/x86_64/cuda-keyring_1.1-1_all.deb" \
    -o /tmp/cuda-keyring.deb && dpkg -i /tmp/cuda-keyring.deb && $APT update || true

  # The branch is pinned rather than left to apt. The unversioned metapackage
  # resolves to whatever is newest, and the newest branch is where support for
  # older cards gets dropped — a T4 is Turing, and finding out on the machine
  # that its driver no longer covers it is not a discovery worth making here.
  # 570 and 580 are current datacenter branches that carry Turing; 550 is the
  # long-standing fallback. Every one of them ships the DKMS module and
  # nvidia-smi in the same install, which is the whole point.
  for branch in 570 580 550; do
    if $APT install -y "cuda-drivers-${branch}"; then
      echo "MDAI: installed NVIDIA driver branch ${branch} from NVIDIA's repository"
      return 0
    fi
  done

  echo "MDAI: NVIDIA's own repository did not work, falling back to the distribution driver"
  ubuntu-drivers install --gpgpu || $APT install -y nvidia-driver-535-server
  # The distribution route needs the utils asked for by name; this is the exact
  # omission that produced a blind machine last time.
  local branch
  branch="$(dpkg-query -W -f='${Package}\n' 'nvidia-compute-utils-*-server' 2>/dev/null | grep -oE '[0-9]+' | head -1)"
  [ -n "$branch" ] && $APT install -y "nvidia-utils-${branch}-server"
  command -v nvidia-smi >/dev/null || $APT install -y nvidia-utils-570-server ||
    $APT install -y nvidia-utils-535-server
}

step "NVIDIA driver — this is the long one, several minutes"
$APT install -y linux-headers-"$(uname -r)" || true
# Bounded: a driver install that hangs must not hold the machine forever with
# nothing to show for it.
timeout 2400 bash -c "$(declare -f install_nvidia_driver); APT=\"$APT\"; install_nvidia_driver" ||
  echo "MDAI: driver install did not finish inside its time budget" | tee /dev/console
modprobe nvidia 2>/dev/null || true

# Say plainly, in the log and on the console, whether this machine can see its
# own GPU. A run that discovers this later has already spent twenty minutes and
# a queue of captures to learn it.
if nvidia-smi; then
  echo "MDAI: driver installed and the GPU answers"
else
  {
    echo "MDAI WARNING: nvidia-smi does not run after installing the driver."
    echo "  installed nvidia packages:"
    dpkg-query -W -f='    ${Package} ${Version}\n' 'nvidia*' 'cuda-drivers*' 2>/dev/null
    echo "  running kernel: $(uname -r)"
    echo "  loaded modules: $(lsmod | grep -c nvidia) nvidia entries"
    echo "  The machine will retry after the reboot; if it still fails the run stops"
    echo "  before claiming any capture."
  } | tee /dev/console
fi

# Docker from Docker's own repository, not Ubuntu's: the build needs BuildKit
# and the buildx plugin for --secret, and only this package ships them.
step "docker"
curl -fsSL --connect-timeout 20 --max-time 600 https://get.docker.com | sh

install -m 0755 -d /usr/share/keyrings
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey |
  gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -fsSL https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list |
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  > /etc/apt/sources.list.d/nvidia-container-toolkit.list
$APT update
step "container toolkit"
$APT install -y nvidia-container-toolkit
nvidia-ctk runtime configure --runtime=docker
systemctl restart docker || true

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

# Everything after this needs the GPU. Discovering that twenty minutes later,
# after a full image build and with eight captures already marked failed, is the
# most expensive way to learn it — so the run stops here instead.
#
# One recovery is worth attempting first: a module that exists but was never
# loaded, or a DKMS build that did not run for the kernel this machine actually
# booted into. Both are cheap to fix and both have the same symptom.
if ! nvidia-smi >/dev/null 2>&1; then
  echo "MDAI: the GPU did not answer on first try, attempting to load the driver" > /dev/console
  modprobe nvidia 2>/dev/null || true
  command -v dkms >/dev/null && dkms autoinstall 2>/dev/null || true
  modprobe nvidia 2>/dev/null || true
fi

if ! nvidia-smi; then
  {
    echo "MDAI STOP: this machine cannot see its GPU, so nothing was claimed from the queue."
    echo "  nvidia-smi: $(command -v nvidia-smi || echo 'not installed')"
    echo "  kernel: $(uname -r)"
    echo "  nvidia kernel modules loaded: $(lsmod | grep -c nvidia)"
    echo "  installed:"
    dpkg-query -W -f='    ${Package} ${Version}\n' 'nvidia*' 'cuda-drivers*' 2>/dev/null | head -30
    echo "  Every capture is untouched. Terminate this instance and launch a new one"
    echo "  with the current user-data from the repository."
  } | tee /dev/console
  exit 94
fi

if ! docker run --rm --gpus all nvidia/cuda:11.7.1-base-ubuntu22.04 nvidia-smi; then
  {
    echo "MDAI STOP: the driver works but Docker cannot reach the GPU."
    echo "  The container toolkit is installed but not wired into the daemon."
    echo "  docker runtimes: $(docker info --format '{{json .Runtimes}}' 2>/dev/null)"
    echo "  Nothing was claimed from the queue; every capture is untouched."
  } | tee /dev/console
  exit 95
fi

echo "MDAI: GPU visible on the host and inside a container — starting the queue" > /dev/console

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

# The setup log goes up now, not only after the worker has run. Waiting until
# then means a setup that never finished leaves no trace anywhere, which is the
# hardest failure of all to explain.
step "setup finished, uploading the setup log and rebooting"
TOKEN="$(curl -sS --max-time 10 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 300' || true)"
INSTANCE_ID="$(curl -sS --max-time 10 -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/instance-id || echo unknown)"
aws s3 cp /var/log/mdai-setup.log \
  "s3://${AWS_S3_BUCKET}/worker-logs/$(date -u +%Y%m%dT%H%M%SZ)-${INSTANCE_ID}-setup-before-reboot.log" \
  --region "${AWS_REGION}" || echo "MDAI: could not upload the setup log" | tee /dev/console

shutdown -r now
