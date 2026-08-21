# Running the 360 worker on AWS

One page, no options. Eight machines failed before this was written; the reason
every one of them failed is at the bottom.

## The machine

| | |
|---|---|
| **AMI** | `Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 22.04)` |
| **AMI owner** | `898082745236` (AWS) — free, you pay only for EC2 |
| **AMI id in us-east-2** | `ami-00047abb80935cca4` (build 20260714 — a newer build is fine) |
| **Instance type** | `g4dn.xlarge` |
| **Region** | `us-east-2` (Ohio) — the bucket and the quota are there |
| **IAM role** | `measured-decision-worker` |
| **Storage** | 120 GB gp3 |
| **User data** | `workers/insta360/user-data.sh` from `main`, with the service role key filled in |

That image already carries the NVIDIA driver, Docker and the NVIDIA container
toolkit. AWS lists g4dn among its supported instance families. Nothing about
the driver is installed, configured or rebooted by us, which is the entire point.

## Finding the AMI in the console

Launch instances → **Application and OS Images** → **Browse more AMIs** → search
`898082745236`, the AWS account that publishes these images.

The results land under the **Community AMIs** tab. That tab warns that anyone can
publish, which is true and is why the publisher is what matters, not the tab.
Take the entry that carries all three: name beginning `Deep Learning Base OSS
Nvidia Driver GPU AMI`, `Owner 898082745236` / `OwnerAlias amazon`, and the
**Verified provider** badge. G4dn must appear in its supported-instance list.

Do not take an **AWS Marketplace** listing. Those are third-party repackagings
billed per hour on top of EC2 — that is the trap this project fell into early on.

Ubuntu 22.04 is preferred over 24.04 here: the Insta360 MediaSDK is built for
22.04 with CUDA 11.7, and so is the container the worker runs in. Either host
works, but this one matches the vendor.

## What the machine does

Boots once, no reboot. Checks the GPU on the host and inside a container, checks
its AWS identity and its access to `private-sdk/`, pulls the licensed Insta360
SDK, builds the worker image, runs the worker's own self-test, works the queue,
uploads its log, stops itself.

It stops itself in every case: when the queue empties, when a check fails, and
in the worst case on a three-hour deadline set in the first seconds.

## Reading what happened

**The first place to look is the Studio.** The machine opens a row for itself
before it does anything else and updates it at every step, so the Spatial
evidence card says which of these is true, in the machine's own words:

- *The 360 machine is running — building the worker image*
- *The 360 machine stopped 1 hour ago — this machine cannot see its GPU (code 94). No capture was touched.*
- *The 360 machine last reported 41 minutes ago, at "building the worker image", and has said nothing since*
- *The 360 machine finished 20 minutes ago — 6 captures stitched*

Nothing writes that row except the machine, so a state shown there was reported
by the machine and by nothing else. When the record has never heard from it, the
Studio says exactly that instead of guessing.

The logs are still there when the sentence is not enough. Two routes, either is
enough:

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

The same code and reason are written to the machine's row, so the Studio shows
them without anyone opening a bucket.

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

## The service role key

It goes in one place: line 34 of `user-data.sh`, replacing
`PASTE_SERVICE_ROLE_KEY_HERE`, pasted into the EC2 **User data** field at launch.
Never into a chat, a commit, or a ticket.

Until 21 August the script sourced its environment file under `set -x`, which
printed the key into a log that is uploaded to S3 and dumped to the serial
console. Anyone who could read either could take it. The key is now never traced,
and the log is filtered once more on its way out of the machine.

**If any machine before 21 August ran to the point of uploading a log, treat that
key as exposed:** rotate the service role key in the Supabase dashboard, and
delete the old objects under `worker-logs/`.
