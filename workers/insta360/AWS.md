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

## Connect

Use **Session Manager**, not SSH. No key pair to lose, no port 22 open to the
internet, and it works from the browser.

1. Attach an IAM role to the instance with the policies
   `AmazonSSMManagedInstanceCore` and read/write access to the evidence bucket.
2. EC2 console → select the instance → **Connect** → **Session Manager** →
   **Connect**.

The same role gives the worker its S3 credentials, so no access keys are stored
on the machine. Leave `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` unset and
boto3 picks the role up on its own.

If SSH is preferred anyway:

```bash
ssh -i /path/key.pem ubuntu@<public-dns>
```

## Verify the GPU before anything else

```bash
nvidia-smi
docker run --rm --gpus all nvidia/cuda:11.7.1-base-ubuntu22.04 nvidia-smi
```

The second command is the one that matters: it proves Docker can reach the GPU.

## Build

Copy the MediaSDK package to the instance (from your Mac):

```bash
scp -i /path/key.pem \
  ~/Downloads/Linux_CameraSDK-2.1.1_MediaSDK-3.1.1/libMediaSDK-dev-*-amd64/libMediaSDK-dev-*-amd64.deb \
  ubuntu@<public-dns>:/home/ubuntu/private/
```

Send the `models/` directory as well — the AI weights are not inside the `.deb`:

```bash
scp -i /path/key.pem -r \
  ~/Downloads/Linux_CameraSDK-2.1.1_MediaSDK-3.1.1/libMediaSDK-dev-*-amd64/models \
  ubuntu@<public-dns>:/home/ubuntu/private/
```

Then build with the folder as the secret, so the package and the weights are
picked up together:

```bash
git clone https://github.com/westccmortgage/measured-decision-ai.git
cd measured-decision-ai/workers/insta360
DOCKER_BUILDKIT=1 docker build \
  --secret id=insta360_sdk,src=/home/ubuntu/private \
  -t measured-decision/insta360-worker:3.1.1 .
```

The build stops with a named error if the package is wrong — a CameraSDK
archive, or one with no `libMediaSDK` on the loader path.

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
