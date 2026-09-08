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
import type { AgentResultEnvelope, ProviderFacts, ReconciliationOutcome, WorkPacket } from "./contracts.ts";
import { sha256 } from "./ids.ts";

export type ExecutionContext = {
  attemptId: string;
  taskId: string;
  signal: AbortSignal;
  /* Where an executor puts what it saw of the thing that answered it. The
     kernel writes whatever arrives here onto the attempt in the same commit
     as the result, so the record holds the answer and the facts about it
     together. An executor that reports nothing leaves the attempt as it was;
     reporting twice merges, and a fact already reported is not rewritten. */
  report(facts: ProviderFacts): void;
};

export type { ProviderFacts, ReconciliationOutcome };

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

  /* One instance, one domain, whatever it is called.

     A caller that can name an instance in a way that outlives the process
     passes that name, and the domain is derived from it. That matters at a
     restart: the record says which domain read a subject, and a fresh
     registry that invented new domain ids would call every domain unused and
     let one reader read the same subject twice under two names. A caller
     with nothing durable to say leaves it out and gets a domain unique to
     this registry, which is the honest answer for an executor that exists
     only while this process does. Two different instances may not claim one
     durable name: that would be two opinions wearing one domain. */
  register(executor: AgentExecutor, families: string[], durableIdentity?: string): string {
    let domain = this.domains.get(executor);
    if (!domain) {
      domain = `domain:${sha256(durableIdentity ? `durable-executor:${durableIdentity}` : `${this.nonce}:${this.domains.size}`).slice(0, 12)}`;
      for (const [other, taken] of this.domains) {
        if (taken === domain && other !== executor) throw new Error(`core-v2: two executors claim the durable identity ${durableIdentity}, and one identity is one domain`);
      }
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
