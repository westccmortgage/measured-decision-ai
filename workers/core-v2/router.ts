/* WHICH EXECUTOR DOES A ROLE'S WORK IS A ROUTING DECISION, NOT A PRODUCT ONE.
 *
 * The router takes a role, a task type, and what independence the assignment
 * needs, and answers with an executor family and a configuration identifier.
 * Families here are abstract — `reader-family-one`, not a vendor — because
 * this PR connects to no provider and the product never shows one. A later
 * routing table maps a family to a real model configuration; nothing above the
 * router changes when it does.
 *
 * Two rules the router itself holds:
 *   · code roles route to code, whatever the table says;
 *   · an independent reading is given the family its blind group is paired
 *     with — reader-a the first family, reader-b the second — so two readers
 *     routed at the same moment never land on one family; it is not given a
 *     family that already read the subject; and it is never allowed to reuse
 *     a cached attempt.
 */
import type { RoutingProfile } from "./contracts.ts";
import { INDEPENDENCE_GROUPS } from "./graph-builder.ts";
import { roleDefinition } from "./role-registry.ts";

export type RoutingRequest = {
  roleKey: string;
  taskType: string;
  requiresVisualInput: boolean;
  independenceGroup: string | null;
  previousExecutorFamilies: string[];
  estimatedInputSize: number;
};

export type ExecutorSelection = {
  executorFamily: string;
  modelConfiguration: string;
  reason: string;
  preservesIndependence: boolean;
  /* An independent reading may never be served from a prior attempt. */
  cacheReuseAllowed: boolean;
};

export type RoutingTable = Record<RoutingProfile, { family: string; configuration: string; visual: boolean }[]>;

/* Abstract families. The names deliberately say nothing about who they are. */
export const DEFAULT_ROUTING_TABLE: RoutingTable = {
  general_extraction: [
    { family: "reader-family-one", configuration: "reader-family-one/general@1", visual: true },
    { family: "reader-family-two", configuration: "reader-family-two/general@1", visual: true },
    { family: "reader-family-three", configuration: "reader-family-three/general@1", visual: false },
  ],
  visual_extraction: [
    { family: "reader-family-one", configuration: "reader-family-one/visual@1", visual: true },
    { family: "reader-family-two", configuration: "reader-family-two/visual@1", visual: true },
  ],
  evidence_criticism: [
    { family: "critic-family-one", configuration: "critic-family-one/criticism@1", visual: true },
    { family: "critic-family-two", configuration: "critic-family-two/criticism@1", visual: true },
  ],
  high_reasoning_arbitration: [
    { family: "arbiter-family-one", configuration: "arbiter-family-one/arbitration@1", visual: true },
  ],
  deterministic: [
    { family: "deterministic", configuration: "code", visual: false },
  ],
};

export class AgentRouter {
  table: RoutingTable;

  constructor(table: RoutingTable = DEFAULT_ROUTING_TABLE) {
    this.table = table;
  }

  select(request: RoutingRequest): ExecutorSelection {
    const role = roleDefinition(request.roleKey);
    if (role.executorKind === "deterministic") {
      return {
        executorFamily: "deterministic", modelConfiguration: "code",
        reason: `${role.roleKey} is code; it is never routed to a model`,
        preservesIndependence: true, cacheReuseAllowed: true,
      };
    }
    const candidates = (this.table[role.routingProfile] ?? [])
      .filter((c) => !request.requiresVisualInput || c.visual);
    if (candidates.length === 0) {
      throw new Error(`core-v2: no executor family serves ${role.routingProfile}${request.requiresVisualInput ? " with visual input" : ""}`);
    }
    const previous = new Set(request.previousExecutorFamilies);
    /* Each blind group starts the table at its own position, so the choice
       for reader-b does not depend on reader-a's attempt having been written
       yet — two readers dispatched in one tick still get two families. */
    const start = Math.max(0, INDEPENDENCE_GROUPS.indexOf(request.independenceGroup ?? ""));
    const rotated = candidates.map((_, i) => candidates[(start + i) % candidates.length]);
    const fresh = rotated.filter((c) => !previous.has(c.family));

    if (request.independenceGroup) {
      if (fresh.length === 0) {
        const fallback = candidates[0];
        return {
          executorFamily: fallback.family, modelConfiguration: fallback.configuration,
          reason: `every family serving ${role.routingProfile} has already read this subject; ` +
            `independence cannot be preserved by family and is recorded as such`,
          preservesIndependence: false, cacheReuseAllowed: false,
        };
      }
      const pick = fresh[0];
      return {
        executorFamily: pick.family, modelConfiguration: pick.configuration,
        reason: `independent reading ${request.independenceGroup}: a family that has not read this subject`,
        preservesIndependence: true, cacheReuseAllowed: false,
      };
    }
    const pick = candidates[0];
    return {
      executorFamily: pick.family, modelConfiguration: pick.configuration,
      reason: `first family serving ${role.routingProfile}`,
      preservesIndependence: true, cacheReuseAllowed: true,
    };
  }
}
