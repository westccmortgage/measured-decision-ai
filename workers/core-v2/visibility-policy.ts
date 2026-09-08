/* WHO MAY SEE WHAT, AND WHY IT IS ENFORCED IN THE PACKET.
 *
 * Blindness is not a prompt instruction. A second reader that is told "do not
 * look at the first reader's answer" while the answer sits in its packet is
 * not blind. So the policy is applied when the packet is built: an extractor's
 * packet carries no other reader's claims; a critic's packet carries the
 * disputed claims under letters and nothing that says who wrote them; nobody's
 * packet carries a provider name, a cost, or a majority count dressed as proof.
 *
 * `assertPacketRespectsVisibility` is the check a test can run over any packet
 * the engine produces, and the scheduler runs it over every packet before an
 * executor sees it.
 */
import type { AgentRoleDefinition, PacketClaim, WorkPacket } from "./contracts.ts";

export type Visibility = {
  /* May the packet carry any claims from other tasks at all? */
  claims: "none" | "own_dependencies" | "anonymized_competing" | "all_relevant";
  assessments: boolean;
  disagreements: boolean;
  validation: boolean;
  /* Extractors run blind by definition: their own dependency claims (a legend
     read before a locator runs) are the only claims they may carry. */
  blind: boolean;
};

export function visibilityFor(role: AgentRoleDefinition): Visibility {
  switch (role.roleKey) {
    case "deterministic_comparator":
      return { claims: "all_relevant", assessments: false, disagreements: false, validation: false, blind: false };
    case "evidence_critic":
      return { claims: "anonymized_competing", assessments: false, disagreements: false, validation: false, blind: false };
    case "disagreement_verifier":
      return { claims: "anonymized_competing", assessments: false, disagreements: true, validation: false, blind: false };
    case "evidence_arbiter":
      return { claims: "anonymized_competing", assessments: true, disagreements: true, validation: true, blind: false };
    case "deterministic_counter":
    case "assembly_calculator":
    case "relationship_builder":
    case "decision_composer":
      return { claims: "all_relevant", assessments: true, disagreements: true, validation: true, blind: false };
    default:
      return { claims: "own_dependencies", assessments: false, disagreements: false, validation: false, blind: true };
  }
}

/* Provider identifiers, as whole words, anywhere in the packet — a label, a
   quoted text, an explanation. Not "model" or "provider": a window schedule
   has a MODEL column and a schedule reader is allowed to read it. */
const PROVIDER_WORDS = ["openai", "anthropic", "gemini", "claude", "gpt-?\\d", "chatgpt", "vertex", "bedrock"];
/* The engine's own labels for who did the work. A reader that echoes its group
   into a claim, or a critic that names a family, has written authorship into
   evidence; an anonymised packet may carry none of it. */
export const AUTHORSHIP_WORDS = ["reader-a", "reader-b", "reader-c", "reader-family", "critic-family", "arbiter-family", "executor family", "independence group"];

/* What must never appear anywhere in a packet: a provider name, a credential,
   a signed URL, a cost or a vote count offered as proof. */
export function forbiddenContent(packet: WorkPacket): string[] {
  const problems: string[] = [];
  const text = JSON.stringify(packet).toLowerCase();
  for (const word of PROVIDER_WORDS) {
    if (new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(text)) problems.push(`packet names a provider: ${word.replace("-?\\d", "")}`);
  }
  if (/https?:\/\//.test(text)) problems.push("packet carries a URL");
  if (/x-amz-signature|[?&]signature=|[?&]token=|api[_-]?key|access[_-]?token|"secret[_a-z]*"\s*:|bearer [a-z0-9]/.test(text)) problems.push("packet carries a credential or signed link");
  if (/"(cost_usd|price_usd|usd|majority|votes|winner)"\s*:/.test(text)) problems.push("packet carries cost or a majority as proof");
  return problems;
}

/* An anonymised packet carries no authorship at all: no reader group, no
   family, no claim or attempt id — not in a ref, not in a scope, not in a
   quoted text. Task ids may appear: they name work, not who did it. */
export function authorshipContent(packet: WorkPacket): string[] {
  const problems: string[] = [];
  const text = JSON.stringify({ ...packet, taskId: "", parentTaskId: "", dependencies: packet.dependencies.map((d) => ({ ...d, taskId: "" })) }).toLowerCase();
  for (const word of AUTHORSHIP_WORDS) if (text.includes(word)) problems.push(`anonymised packet carries authorship: ${word}`);
  if (/\b(claim|attempt)_[0-9a-f]{16}\b/.test(text)) problems.push("anonymised packet carries a claim or attempt id");
  return problems;
}

export function assertPacketRespectsVisibility(packet: WorkPacket, role: AgentRoleDefinition): string[] {
  const rules = visibilityFor(role);
  const problems: string[] = [...forbiddenContent(packet)];
  const claims = packet.context.claims;

  if (rules.blind && !packet.blindContext) problems.push(`${role.roleKey} packets must be blind`);
  if (role.roleKey !== "deterministic_comparator" && packet.dependencies.some((d) => d.independenceGroup !== null)) {
    problems.push(`${role.roleKey} packet says which blind group a dependency read under`);
  }
  if (rules.claims === "none" && claims.length) problems.push(`${role.roleKey} may see no claims`);
  if (rules.claims === "own_dependencies") {
    const allowed = new Set(packet.dependencies.flatMap((d) => d.claimIds));
    for (const c of claims) {
      if (!allowed.has(c.ref)) problems.push(`${role.roleKey} packet carries a claim that is not one of its dependencies: ${c.ref}`);
    }
  }
  if (rules.claims === "anonymized_competing") {
    for (const c of claims) {
      if (!/^[A-Z]{1,3}$/.test(c.ref)) problems.push(`${role.roleKey} packet shows a claim under its id rather than a letter: ${c.ref}`);
      if (c.independenceGroup !== null) problems.push(`${role.roleKey} packet says which reader made ${c.ref}`);
    }
    for (const d of packet.dependencies) if (d.claimIds.length) problems.push(`${role.roleKey} packet lists dependency claim ids`);
    problems.push(...authorshipContent(packet));
  }
  if (!rules.assessments && packet.context.assessments.length) problems.push(`${role.roleKey} may not see assessments`);
  if (!rules.disagreements && packet.context.disagreements.length) problems.push(`${role.roleKey} may not see disagreements`);
  if (!rules.validation && packet.context.validation.length) problems.push(`${role.roleKey} may not see validation notes`);
  if (packet.sources.length > packet.limits.maximumSources) problems.push(`packet carries ${packet.sources.length} sources, limit ${packet.limits.maximumSources}`);
  for (const action of packet.allowedActions) {
    if (!role.allowedActions.includes(action)) problems.push(`packet permits ${action}, which the role does not`);
  }
  return problems;
}

/* A, B … Z, AA, AB … — as many as there are claims. */
export function letterFor(index: number): string {
  let n = index;
  let out = "";
  do { out = String.fromCharCode(65 + (n % 26)) + out; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return out;
}

/* Letters, in a stable order that does not reveal reading order or group:
   claims are sorted by the hash that is their id, which says nothing about
   who made them or when. */
export function anonymize(claims: PacketClaim[]): { claims: PacketClaim[]; map: Record<string, string> } {
  const sorted = [...claims].sort((a, b) => a.ref.localeCompare(b.ref));
  const map: Record<string, string> = {};
  const out = sorted.map((c, i) => {
    const letter = letterFor(i);
    map[letter] = c.ref;
    return { ...c, ref: letter, independenceGroup: null, scope: scrubScope(c.scope), anchors: c.anchors.map((a) => ({ ...a, locator: scrubLocator(a.locator) })) };
  });
  return { claims: out, map };
}

/* A reader may write anything into a scope or a locator, including who it is.
   The manifest's own locator keys are kept; anything else a reader added is
   dropped from an anonymised packet. */
const LOCATOR_KEYS = new Set(["sheet", "page_index", "region", "mark", "tile", "image", "direction"]);
const SCOPE_KEYS = new Set(["sheet", "building", "level", "space", "system", "revision", "detail"]);
export function scrubLocator(locator: Record<string, string | number>): Record<string, string | number> {
  return Object.fromEntries(Object.entries(locator).filter(([k]) => LOCATOR_KEYS.has(k)));
}
export function scrubScope(scope: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(scope).filter(([k]) => SCOPE_KEYS.has(k)));
}
