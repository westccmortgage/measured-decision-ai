# Running the 360 worker on AWS g4dn.xlarge

The instance type is chosen by a constraint, not by price. MediaSDK 3.1.1 is
built for CUDA 11.7, which does not support `sm_89` — so Ada cards (RTX 4090,
L4) are out no matter how cheap they rent. `g4dn` carries an NVIDIA T4
(`sm_75`), squarely inside what CUDA 11.7 targets, and it sits in the same
region as the evidence bucket, so downloading originals costs nothing.

| | |
| --- | --- |
| Instance | `g4dn.xlarge` — 4 vCPU, 16 GB RAM, 1× T4 16 GB |
| Region | `us-east-2` — the same region as `measured-decision-production-…` |
| AMI | Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 22.04) |
| Root volume | 120 GB gp3 |

The Deep Learning Base AMI already carries the NVIDIA driver, Docker and the
NVIDIA Container Toolkit. On a plain Ubuntu image all three must be installed by
hand, which is the usual reason a first attempt fails with
`could not select device driver "" with capabilities: [[gpu]]`.

## Before launching: the GPU quota

Most accounts start with a limit of **0** vCPUs for G instances, and the launch
fails with *"You have requested more vCPU capacity than your current vCPU limit
of 0"*. `g4dn.xlarge` needs 4.

**Service Quotas** → **AWS services** → **Amazon EC2** → search **Running
On-Demand G and VT instances** → **Request increase at account level** → 8 →
submit. Approval takes anywhere from minutes to a day, so do it first.

This account's quota was approved on 18 August 2026: *[US East (Ohio)]: EC2
Instances / All G and VT instances, New Limit = 8*, effective within thirty
minutes of the approval mail. Eight vCPUs is two `g4dn.xlarge` at once, or one
`g4dn.2xlarge`. The quota is per region — a launch in any region other than
`us-east-2` still fails at a limit of 0.

## Launch

From the EC2 dashboard in **us-east-2**, **Launch instance**:

| Field | Value |
| --- | --- |
| Name | `mdai-360-worker` |
| AMI | **Browse more AMIs** → search *Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 22.04)* |
| Instance type | `g4dn.xlarge` |
| Key pair | any existing one, or *Proceed without a key pair* — Session Manager does not use it |
| Network → Auto-assign public IP | **Enable** |
| Configure storage | **120** GiB, gp3 |
| Advanced details → IAM instance profile | `measured-decision-worker` |
| Advanced details → Shutdown behavior | **Stop** |

Auto-assign public IP matters: without it, and without VPC endpoints for SSM,
the instance cannot reach Session Manager and Connect stays greyed out.

Shutdown behavior matters because the batch run ends with `shutdown -h now`. Set
to *Terminate*, that command destroys the machine and everything installed on it.

## Connect

Use **Session Manager**, not SSH: no key pair to lose, no port 22 open to the
internet, and a terminal in the browser. It has one prerequisite that catches
everyone — the instance needs an IAM role. Create the role first, then launch.

### 1. Create the role (once)

1. Open the **IAM** console → **Roles** → **Create role**.
2. Trusted entity type: **AWS service**. Use case: **EC2**. **Next**.
3. Search for and tick **`AmazonSSMManagedInstanceCore`**. **Next**.
4. Role name: `measured-decision-worker`. **Create role**.
5. Open the new role → **Add permissions** → **Create inline policy** → **JSON**
   → paste, replacing the bucket name if yours differs:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::measured-decision-production-808454010303/*"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::measured-decision-production-808454010303"
    }
  ]
}
```

6. Name it `evidence-bucket-access` → **Create policy**.

That single role does two jobs: it lets Session Manager in, and it gives the
worker its S3 credentials. Leave `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY` unset — boto3 picks the role up on its own, so no keys
are ever stored on the machine.

### 2. Attach it to the instance

While launching, in **Advanced details** → **IAM instance profile**, choose
`measured-decision-worker`.

On an instance that is already running: select it → **Actions** → **Security**
→ **Modify IAM role** → choose the role → **Update IAM role**. It takes a
minute or two before Session Manager notices.

### 3. Connect

EC2 console → tick the instance → **Connect** button at the top → **Session
Manager** tab → **Connect**. A terminal opens in the browser tab.

You land as `ssm-user`. Switch to the normal account before working:

```bash
sudo su - ubuntu
```

### If the Connect button is greyed out

- The role is missing or was attached less than two minutes ago.
- The instance is in a private subnet with no NAT and no VPC endpoints for SSM.
  A default VPC public subnet has neither problem.
- The SSM agent is not running. Official Ubuntu and Deep Learning AMIs ship it;
  check with `snap services amazon-ssm-agent`.

Nothing needs to be opened in the security group — Session Manager works over
the instance's outbound HTTPS, which the default group already allows.

### SSH instead, if preferred

```bash
ssh -i /path/key.pem ubuntu@<public-dns>
```

This needs a key pair at launch and port 22 open to your address, which is the
part Session Manager exists to avoid.

## Verify the GPU before anything else

```bash
nvidia-smi
docker run --rm --gpus all nvidia/cuda:11.7.1-base-ubuntu22.04 nvidia-smi
```

The second command is the one that matters: it proves Docker can reach the GPU.

## Getting the SDK onto the instance

Session Manager gives a terminal, not a file transfer: there is no `scp` without
a key pair and an open port 22. The licensed package must not go into git
either. Route it through the private bucket the instance can already read.

**From the Mac, in the browser:** S3 console → the
`measured-decision-production-…` bucket → **Create folder** `private-sdk` →
open it → **Upload** → add the `libMediaSDK-dev-*-amd64.deb` **and** the whole
`models` folder (Upload accepts a dragged folder) → **Upload**.

**On the instance:**

```bash
mkdir -p /home/ubuntu/private
aws s3 cp --recursive s3://measured-decision-production-808454010303/private-sdk/ /home/ubuntu/private/
ls -R /home/ubuntu/private
```

The instance role already allows `s3:GetObject` on this bucket, so nothing else
needs configuring. Delete the `private-sdk/` prefix from the bucket once the
image is built — a licensed package has no reason to sit next to evidence.

If a key pair was set at launch, `scp` still works and is fine:

```bash
scp -i /path/key.pem \
  ~/Downloads/Linux_CameraSDK-2.1.1_MediaSDK-3.1.1/libMediaSDK-dev-*-amd64/libMediaSDK-dev-*-amd64.deb \
  ubuntu@<public-dns>:/home/ubuntu/private/
scp -i /path/key.pem -r \
  ~/Downloads/Linux_CameraSDK-2.1.1_MediaSDK-3.1.1/libMediaSDK-dev-*-amd64/models \
  ubuntu@<public-dns>:/home/ubuntu/private/
```

## Build

The build needs the package and the AI weights together in one directory (the
`models/` folder is not inside the `.deb`):

```bash
git clone https://github.com/westccmortgage/measured-decision-ai.git
cd measured-decision-ai/workers/insta360
DOCKER_BUILDKIT=1 docker build \
  --secret id=insta360_sdk,src=/home/ubuntu/private \
  -t measured-decision/insta360-worker:3.1.1 .
```

The build stops with a named error if the package is wrong — a CameraSDK
archive, or one with no `libMediaSDK` on the loader path.

Before pointing the image at real captures, run the worker's own test from the
clone. It stubs the stitcher, ffmpeg and ffprobe, so it proves claiming,
progress, trimming and publishing without touching a capture or the database:

```bash
python3 ~/measured-decision-ai/workers/insta360/test_worker.py
```

## Run one batch, then stop

`MAX_IDLE_POLLS` makes the worker exit once the queue is empty instead of
polling forever on a metered GPU:

```bash
docker run --rm --gpus all \
  -e SUPABASE_URL=... \
  -e SUPABASE_SERVICE_ROLE_KEY=... \
  -e AWS_REGION=us-east-2 \
  -e AWS_S3_BUCKET=measured-decision-production-808454010303 \
  -e MAX_IDLE_POLLS=20 \
  measured-decision/insta360-worker:3.1.1
```

With `POLL_SECONDS=15`, twenty empty polls is five minutes of quiet before it
gives up. To have the instance stop itself when the batch is done:

```bash
docker run --rm --gpus all --env-file /home/ubuntu/private/worker.env \
  measured-decision/insta360-worker:3.1.1 && sudo shutdown -h now
```

Set the instance's *shutdown behavior* to **stop**, not terminate, or that
command destroys the machine you just built.

## What it costs

A stopped instance costs only its EBS volume — around $10 a month for 120 GB.
Running is roughly $0.53 an hour, and a 30-second 5.7K capture stitches in a few
minutes, so the seven Hutton Pl captures are well under a dollar. The expensive
mistake is leaving it running: about $380 a month for an idle GPU.
