/* WHO ACTUALLY DOES THE WORK, AND HOW THE KERNEL KNOWS TWO OF THEM APART.
 *
 * An executor is code, a model behind an adapter, or a person behind a form.
 * The registry maps abstract families to executors and assigns every
 * executor instance an independence domain of its own at registration: two
 * families registered against one instance share one domain, and a label in
 * a routing table or an envelope cannot change that. Independence is decided
 * on domains, never on names.
 *
 * Execution takes an AbortSignal. A timed-out attempt is aborted; whether the
 * executor honours that is the executor's business, and until its promise
 * settles the kernel keeps counting it against concurrency.
 */
import { randomBytes } from "node:crypto";
import type { AgentResultEnvelope, ReconciliationOutcome, WorkPacket } from "./contracts.ts";
import { sha256 } from "./ids.ts";

export type ExecutionContext = {
  attemptId: string;
  taskId: string;
  signal: AbortSignal;
};

export type { ReconciliationOutcome };

export interface AgentExecutor {
  readonly family: string;
  execute(packet: WorkPacket, context: ExecutionContext): Promise<AgentResultEnvelope>;
  /* What became of an attempt whose outcome this kernel never saw. An
     executor that cannot say answers "unknown", and the attempt stays so. */
  reconcile?(attemptId: string): Promise<ReconciliationOutcome>;
}

export type ExecutorSelection = {
  executorFamily: string;
  independenceDomain: string;
  modelConfiguration: string;
  reason: string;
  cacheReuseAllowed: boolean;
};

export type Invocation = { family: string; independenceDomain: string; taskId: string; roleKey: string; attemptId: string };

export class ExecutorRegistry {
  private byFamily = new Map<string, AgentExecutor>();
  private domains = new Map<AgentExecutor, string>();
  private nonce = randomBytes(8).toString("hex");
  invocations: Invocation[] = [];
  packetsSeen: WorkPacket[] = [];

  /* One instance, one domain, whatever it is called. */
  register(executor: AgentExecutor, families: string[]): string {
    let domain = this.domains.get(executor);
    if (!domain) {
      domain = `domain:${sha256(`${this.nonce}:${this.domains.size}`).slice(0, 12)}`;
      this.domains.set(executor, domain);
    }
    for (const family of families) {
      if (this.byFamily.has(family) && this.byFamily.get(family) !== executor) throw new Error(`core-v2: family ${family} is already served by another executor`);
      this.byFamily.set(family, executor);
    }
    return domain;
  }

  has(family: string): boolean { return this.byFamily.has(family); }
  families(): string[] { return [...this.byFamily.keys()]; }

  resolve(family: string): { executor: AgentExecutor; domain: string } {
    const executor = this.byFamily.get(family);
    if (!executor) throw new Error(`core-v2: no executor serves family ${family}`);
    return { executor, domain: this.domains.get(executor)! };
  }

  domainOf(family: string): string | null {
    const executor = this.byFamily.get(family);
    return executor ? this.domains.get(executor)! : null;
  }

  async run(selection: ExecutorSelection, packet: WorkPacket, context: ExecutionContext): Promise<AgentResultEnvelope> {
    const { executor, domain } = this.resolve(selection.executorFamily);
    if (domain !== selection.independenceDomain) throw new Error(`core-v2: family ${selection.executorFamily} is not in domain ${selection.independenceDomain}`);
    this.invocations.push({ family: selection.executorFamily, independenceDomain: domain, taskId: packet.taskId, roleKey: packet.roleKey, attemptId: context.attemptId });
    this.packetsSeen.push(packet);
    return executor.execute(packet, context);
  }

  async reconcile(family: string, attemptId: string): Promise<ReconciliationOutcome> {
    const executor = this.byFamily.get(family);
    if (!executor || !executor.reconcile) return "unknown";
    return executor.reconcile(attemptId);
  }
}
