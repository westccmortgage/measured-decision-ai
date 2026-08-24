/* Starting the 360 machine when there is work for it.
 *
 * The machine stops itself when the queue empties — a GPU left running is the
 * only expensive mistake this project can make. Starting it again used to mean
 * a person in the AWS console, and that person was the reason the product felt
 * unfinished: a capture uploaded at midnight waited until somebody remembered.
 *
 * Three rules keep an automatic starter from becoming an automatic bill:
 *
 *   1. It never starts a machine that is already running.
 *   2. It never starts one with nothing queued — the cost has to buy something.
 *   3. It never starts one twice inside the cooldown, however many uploads
 *      arrive at once. Ten files dropped together are one machine, not ten.
 *
 * Every attempt is recorded, refusals included, so a machine that woke nine
 * times in an hour is visible before it is a surprise on the invoice.
 *
 * With no instance configured the whole thing is inert and says so. That is
 * deliberate: this ships turned off, and turning it on is a decision somebody
 * makes with an instance id and an IAM policy in front of them.
 */
import {
  DescribeInstancesCommand,
  EC2Client,
  StartInstancesCommand,
} from "npm:@aws-sdk/client-ec2@3";

/* Long enough that a burst of uploads is one machine, short enough that a
   capture arriving just after a shutdown does not wait out a coffee break. */
const COOLDOWN_MINUTES = 10;

/* States AWS reports for an instance that is on its way up or already up.
   Starting one of these is at best a no-op and at worst an error. */
const AWAKE = new Set(["pending", "running", "stopping", "shutting-down"]);

export type WakeReason = "upload" | "person" | "schedule";

export interface WakeResult {
  outcome:
    | "started"
    | "already_awake"
    | "nothing_queued"
    | "too_soon"
    | "not_configured"
    | "failed";
  detail: string;
  queuedJobs: number;
  instanceId: string | null;
}

function ec2Client() {
  const instanceId = Deno.env.get("AWS_360_INSTANCE_ID");
  if (!instanceId) return null;
  /* A key that may start a machine is a different privilege from a key that may
     read a bucket, so it can be a different key. Falling back to the object
     store's key keeps a single-key deployment working, but the split is there
     for anybody who wants it. */
  const accessKeyId = Deno.env.get("AWS_360_ACCESS_KEY_ID") ||
    Deno.env.get("AWS_ACCESS_KEY_ID");
  const secretAccessKey = Deno.env.get("AWS_360_SECRET_ACCESS_KEY") ||
    Deno.env.get("AWS_SECRET_ACCESS_KEY");
  const region = Deno.env.get("AWS_360_REGION") || Deno.env.get("AWS_S3_REGION");
  if (!accessKeyId || !secretAccessKey || !region) return null;
  return {
    instanceId,
    client: new EC2Client({ region, credentials: { accessKeyId, secretAccessKey } }),
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function record(
  admin: any,
  reason: WakeReason,
  actor: string | null,
  result: WakeResult,
) {
  const { error } = await admin.from("machine_wake_events").insert({
    requested_by_kind: reason,
    requested_by: actor,
    instance_id: result.instanceId,
    outcome: result.outcome,
    queued_jobs: result.queuedJobs,
    detail: result.detail.slice(0, 500),
  });
  /* A record that cannot be written must not stop the machine from starting —
     but it must not pass unnoticed either. */
  if (error) console.error("machine wake could not be recorded", error);
  return result;
}

export async function wake360Machine(
  admin: any,
  reason: WakeReason,
  actor: string | null = null,
): Promise<WakeResult> {
  return await wakeWithMachine(admin, reason, actor, ec2Client());
}

/* The decision, separated from where the machine credentials come from, so
   every branch below can be driven in a test without an AWS account. Six
   outcomes and five of them are refusals — the refusals are the part worth
   testing, because they are what stands between this and a runaway bill. */
export async function wakeWithMachine(
  admin: any,
  reason: WakeReason,
  actor: string | null,
  configured: { instanceId: string; client: any } | null,
): Promise<WakeResult> {
  if (!configured) {
    return await record(admin, reason, actor, {
      outcome: "not_configured",
      detail: "No 360 machine is configured for this deployment, so nothing was started.",
      queuedJobs: 0,
      instanceId: null,
    });
  }
  const { instanceId, client } = configured;

  /* Rule 2: the cost has to buy something. Counting the queue first also means
     a wake triggered by an upload that turned out not to need stitching costs
     one cheap query rather than an hour of GPU. */
  const { count, error: countError } = await admin
    .from("capture_360_jobs")
    .select("id", { count: "exact", head: true })
    .in("state", ["waiting_for_sdk", "queued", "failed"]);
  if (countError) {
    return await record(admin, reason, actor, {
      outcome: "failed",
      detail: "The queue could not be read, so nothing was started.",
      queuedJobs: 0,
      instanceId,
    });
  }
  const queuedJobs = count || 0;
  if (!queuedJobs) {
    return await record(admin, reason, actor, {
      outcome: "nothing_queued",
      detail: "Nothing is waiting to be stitched, so the machine was left alone.",
      queuedJobs: 0,
      instanceId,
    });
  }

  /* Rule 3: ten files dropped together are one machine. The cooldown counts
     only starts — a refusal a minute ago is no reason to refuse again. */
  const since = new Date(Date.now() - COOLDOWN_MINUTES * 60_000).toISOString();
  const { data: recent } = await admin
    .from("machine_wake_events")
    .select("created_at")
    .eq("outcome", "started")
    .gte("created_at", since)
    .limit(1);
  if (recent?.length) {
    return await record(admin, reason, actor, {
      outcome: "too_soon",
      detail: `The machine was started within the last ${COOLDOWN_MINUTES} minutes and is still coming up.`,
      queuedJobs,
      instanceId,
    });
  }

  try {
    /* Rule 1: ask before acting. StartInstances on a running machine is not an
       error, which is exactly why it has to be checked — otherwise "started"
       would be recorded for a machine that was already working. */
    const described = await client.send(
      new DescribeInstancesCommand({ InstanceIds: [instanceId] }),
    );
    const state = described.Reservations?.[0]?.Instances?.[0]?.State?.Name || "";
    if (AWAKE.has(state)) {
      return await record(admin, reason, actor, {
        outcome: "already_awake",
        detail: `The machine is ${state} and takes the queue in order.`,
        queuedJobs,
        instanceId,
      });
    }

    await client.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
    return await record(admin, reason, actor, {
      outcome: "started",
      detail: `${queuedJobs} capture${queuedJobs === 1 ? "" : "s"} waiting — the machine is starting.`,
      queuedJobs,
      instanceId,
    });
  } catch (error) {
    console.error("360 machine could not be started", error);
    return await record(admin, reason, actor, {
      outcome: "failed",
      detail: "AWS refused to start the machine.",
      queuedJobs,
      instanceId,
    });
  }
}
