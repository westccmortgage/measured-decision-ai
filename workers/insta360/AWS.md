# Running the 360 worker on AWS

One page, no options. Eight machines failed before this was written; the reason
every one of them failed is at the bottom.

## The machine

| | |
|---|---|
| **AMI** | `Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04)` |
| **AMI owner** | `898082745236` (AWS) — free, you pay only for EC2 |
| **Instance type** | `g4dn.xlarge` |
| **Region** | `us-east-2` (Ohio) — the bucket and the quota are there |
| **IAM role** | `measured-decision-worker` |
| **Storage** | 120 GB gp3 |
| **User data** | `workers/insta360/user-data.sh` from `main`, with the service role key filled in |

That image already carries NVIDIA driver 570.172.08, Docker and the NVIDIA
container toolkit. AWS lists g4dn as a supported family for it. Nothing about
the driver is installed, configured or rebooted by us, which is the entire point.

## Finding the AMI in the console

Launch instances → **Application and OS Images** → **Browse more AMIs** →
search `Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04)`.

Take the result under **Quickstart AMIs** or **My AMIs / AWS owned**, owner
`898082745236`. Do not take a Marketplace listing: those are third-party
repackagings billed per hour on top of EC2.

## What the machine does

Boots once, no reboot. Checks the GPU on the host and inside a container, checks
its AWS identity and its access to `private-sdk/`, pulls the licensed Insta360
SDK, builds the worker image, runs the worker's own self-test, works the queue,
uploads its log, stops itself.

It stops itself in every case: when the queue empties, when a check fails, and
in the worst case on a three-hour deadline set in the first seconds.

## Reading what happened

Two routes, either is enough:

- **S3** → `measured-decision-production-808454010303` → `worker-logs/`
- **EC2** → the instance → Actions → Monitor and troubleshoot → **Get system log**,
  and read the lines starting `MDAI`.

Every stage announces itself: `MDAI STEP: …`. A refusal announces itself too,
with the reason and an exit code:

| code | meaning |
|---|---|
| 90 | no AWS CLI, so nothing can move |
| 91 | no working AWS identity — check the instance role |
| 92 | the role cannot read `private-sdk/` |
| 93 | no `libMediaSDK` in `private-sdk/` |
| 94 | the machine cannot see its GPU — wrong AMI |
| 95 | the driver works but Docker cannot reach the GPU |
| 96 | no Docker — not the AWS GPU image |
| 98 | the worker image did not build |
| 99 | the worker failed its own self-test |

In every one of those cases **no capture is touched**. A queue emptied into
failures is worse than a queue not started.

## Why the earlier machines failed

Every instance that left a log failed the same way. `ubuntu-drivers install
--gpgpu` selected `nvidia-headless-no-dkms-*-server-open`, a package family that
ships no `nvidia-smi`. The machine held a working T4 it could not see, the
container toolkit had nothing to inject, and CUDA work died without explaining
itself — on 19 August that emptied a queue of eight captures into failures.

Installing the driver from NVIDIA's own repository fixed that and introduced a
worse failure: `needrestart` stops apt to ask which services to restart, nobody
answers in cloud-init, and the boot script waited forever — leaving no log at
all, because logs only left after a reboot that never came.

Both problems are the same mistake: installing a GPU driver at boot on a machine
nobody can watch. AWS publishes an image with the driver already in it, so this
setup no longer installs one.
