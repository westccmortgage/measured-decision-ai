/* THE ONE DOOR AN ASSIGNMENT LEAVES THROUGH.
 *
 * An executor takes a packet and returns an envelope. That is the whole
 * contract, and it is the seam a real provider adapter fits behind later. In
 * this PR two executors exist — code for the deterministic roles and a mock
 * for the agent roles — and a registry that will hand out nothing else.
 *
 * The registry also counts. Every execution is recorded by family, so a test
 * can prove that no provider family was ever invoked.
 */
import type { AgentResultEnvelope, WorkPacket } from "../contracts.ts";
import type { ExecutorSelection } from "../router.ts";

export interface AgentExecutor {
  readonly family: string;
  execute(packet: WorkPacket): Promise<AgentResultEnvelope>;
}

export class ExecutorRegistry {
  private executors = new Map<string, AgentExecutor>();
  invocations: { family: string; taskId: string; roleKey: string }[] = [];
  /* Every packet that reached an executor, kept so a test can inspect what
     each role was actually shown. */
  packetsSeen: WorkPacket[] = [];

  register(executor: AgentExecutor, families: string[]) {
    for (const f of families) this.executors.set(f, executor);
  }

  /* No family registered means no execution — never a silent fallback to
     something that costs money. */
  resolve(selection: ExecutorSelection): AgentExecutor {
    const executor = this.executors.get(selection.executorFamily);
    if (!executor) throw new Error(`core-v2: no executor is registered for family ${selection.executorFamily} — nothing is called`);
    return executor;
  }

  async run(selection: ExecutorSelection, packet: WorkPacket): Promise<AgentResultEnvelope> {
    const executor = this.resolve(selection);
    this.invocations.push({ family: selection.executorFamily, taskId: packet.taskId, roleKey: packet.roleKey });
    this.packetsSeen.push(packet);
    return executor.execute(packet);
  }
}
