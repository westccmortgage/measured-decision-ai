/* WHICH EXECUTOR DOES A ROLE'S WORK IS A ROUTING DECISION, NOT A PRODUCT ONE.
 *
 * The router takes a role, what independence the assignment needs, and which
 * independence domains have already read the subject, and answers with an
 * executor family, its domain and a configuration identifier — or refuses.
 * Families are abstract; the domain is the registry's, not the table's.
 *
 * Independence fails closed. A blind assignment for which no domain distinct
 * from every domain that already read the subject is available is not
 * routed, and the caller does not run it. Distinct family names are not
 * independence; two aliases of one executor are one domain and the router
 * says so.
 */
import type { RoutingProfile } from "./contracts.ts";
import { INDEPENDENCE_GROUPS } from "./domain.ts";
import type { ExecutorRegistry, ExecutorSelection } from "./executors.ts";
import type { RoleRegistry } from "./roles.ts";

export type RoutingRequest = {
  roleKey: string;
  requiresVisualInput: boolean;
  independenceGroup: string | null;
  /* Independence domains that already read this subject. */
  usedDomains: string[];
};

export type RoutingOutcome = { ok: true; selection: ExecutorSelection } | { ok: false; reason: string };

export type RoutingTable = Record<RoutingProfile, { family: string; configuration: string; visual: boolean }[]>;

export const DEFAULT_ROUTING_TABLE: RoutingTable = {
  general_analysis: [
    { family: "reader-family-one", configuration: "reader-family-one/general@2", visual: true },
    { family: "reader-family-two", configuration: "reader-family-two/general@2", visual: true },
    { family: "reader-family-three", configuration: "reader-family-three/general@2", visual: false },
  ],
  visual_analysis: [
    { family: "reader-family-one", configuration: "reader-family-one/visual@2", visual: true },
    { family: "reader-family-two", configuration: "reader-family-two/visual@2", visual: true },
  ],
  evidence_criticism: [
    { family: "critic-family-one", configuration: "critic-family-one/criticism@2", visual: true },
    { family: "critic-family-two", configuration: "critic-family-two/criticism@2", visual: true },
  ],
  high_reasoning_arbitration: [
    { family: "arbiter-family-one", configuration: "arbiter-family-one/arbitration@2", visual: true },
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

  select(request: RoutingRequest, roles: RoleRegistry, executors: ExecutorRegistry): RoutingOutcome {
    const role = roles.role(request.roleKey);
    if (role.executorKind === "deterministic") {
      const domain = executors.domainOf("deterministic");
      if (!domain) return { ok: false, reason: "no deterministic executor is registered" };
      return { ok: true, selection: { executorFamily: "deterministic", independenceDomain: domain, modelConfiguration: "code", reason: `${role.roleKey} is code; it is never routed to a model`, cacheReuseAllowed: true } };
    }
    const candidates = (this.table[role.routingProfile] ?? [])
      .filter((c) => !request.requiresVisualInput || c.visual)
      .filter((c) => executors.has(c.family));
    if (candidates.length === 0) return { ok: false, reason: `no registered executor family serves ${role.routingProfile}${request.requiresVisualInput ? " with visual input" : ""}` };

    /* Each blind group starts the table at its own position, so two readers
       dispatched in one tick are steered to two families before any attempt
       row exists — and the domain check below decides whether that was enough. */
    const start = Math.max(0, INDEPENDENCE_GROUPS.indexOf(request.independenceGroup ?? ""));
    const rotated = candidates.map((_, i) => candidates[(start + i) % candidates.length]);
    const used = new Set(request.usedDomains);

    if (request.independenceGroup) {
      const fresh = rotated.find((c) => !used.has(executors.domainOf(c.family)!));
      if (!fresh) {
        return { ok: false, reason: `every executor domain serving ${role.routingProfile} has already read this subject (${[...new Set(rotated.map((c) => executors.domainOf(c.family)))].length} distinct); independence cannot be preserved` };
      }
      return { ok: true, selection: { executorFamily: fresh.family, independenceDomain: executors.domainOf(fresh.family)!, modelConfiguration: fresh.configuration, reason: `independent reading ${request.independenceGroup}: a domain that has not read this subject`, cacheReuseAllowed: false } };
    }
    /* A critic or an arbiter must also be independent of what it judges:
       a domain that made a claim does not verify that claim. */
    const pick = rotated.find((c) => !used.has(executors.domainOf(c.family)!)) ?? null;
    if (!pick && used.size) return { ok: false, reason: `every executor domain serving ${role.routingProfile} took part in what it would judge` };
    const chosen = pick ?? rotated[0];
    return { ok: true, selection: { executorFamily: chosen.family, independenceDomain: executors.domainOf(chosen.family)!, modelConfiguration: chosen.configuration, reason: `first family serving ${role.routingProfile}`, cacheReuseAllowed: true } };
  }
}
