/* WHAT CODE CAN SETTLE BEFORE ANYONE IS ASKED TO JUDGE.
 *
 * Two readers read the same region blind. Before any model is paid to say who
 * was right, this lines their claims up by subject and predicate and says —
 * mechanically — where they agree, where they differ, and where only one of
 * them saw a thing at all. Normalisation is casing, whitespace, mark
 * punctuation and unit spelling. It is never semantic; a model rewording a
 * claim is not normalisation.
 *
 * It returns agreement groups and disagreements. It does not return a winner,
 * a score, or a ranking of readers. Agreement is recorded; it is not proof.
 */
import type {
  ClaimValue, DisagreementKind, DisagreementSeverity, ObservationBasis, ProposedDisagreement, SubjectType,
} from "./contracts.ts";

/* The least a claim needs to be compared. A packet claim and a stored claim
   both satisfy it; neither carries a provider. */
export type ComparableClaim = {
  claimId: string;
  independenceGroup: string | null;
  subjectType: SubjectType;
  subjectKey: string;
  predicate: string;
  value: ClaimValue;
  unit: string | null;
  observationBasis: ObservationBasis;
  scope: Record<string, string>;
};
import { shortId } from "./hash.ts";

export type AgreementGroup = { signature: Record<string, string>; claimIds: string[]; groups: string[] };

export type ComparisonResult = {
  agreements: AgreementGroup[];
  disagreements: ProposedDisagreement[];
  /* Subjects seen by only one reader — recorded as `missing` disagreements. */
  singletons: string[];
};

const UNIT_ALIASES: Record<string, string> = {
  "ea": "each", "each": "each", "pcs": "each", "pc": "each", "nos": "each",
  "ft": "ft", "feet": "ft", "foot": "ft", "'": "ft", "lf": "ft",
  "in": "in", "inch": "in", "inches": "in", "\"": "in",
  "sf": "sqft", "sqft": "sqft", "sq ft": "sqft",
};

export function normaliseKey(text: string): string {
  return text.toUpperCase().replace(/[\s\-_./]+/g, "").trim();
}

export function normaliseUnit(unit: string | null): string | null {
  if (unit === null || unit === undefined) return null;
  const key = unit.toLowerCase().trim();
  return UNIT_ALIASES[key] ?? key;
}

export function normaliseScope(scope: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(scope).sort()) out[k.toLowerCase()] = normaliseKey(String(scope[k]));
  return out;
}

export function signatureOf(claim: ComparableClaim): Record<string, string> {
  return {
    subject_type: claim.subjectType,
    subject_key: normaliseKey(claim.subjectKey),
    predicate: claim.predicate.toLowerCase(),
    scope: JSON.stringify(normaliseScope(claim.scope ?? {})),
  };
}

function valueEqual(a: ComparableClaim, b: ComparableClaim): boolean {
  if (a.value.known !== b.value.known) return false;
  if (!a.value.known) return true;
  if (a.value.quantity !== null || b.value.quantity !== null) return a.value.quantity === b.value.quantity;
  return normaliseKey(a.value.text ?? "") === normaliseKey(b.value.text ?? "");
}

/* Compare the claims of two or more independence groups for one subject.
   `readerGroups` names every group that read — including one that came back
   with nothing, which the claims alone could never show. */
export function compareClaims(workflowId: string, subjectKey: string, claims: ComparableClaim[], readerGroups: string[] = []): ComparisonResult {
  const groups = [...new Set([...readerGroups, ...claims.map((c) => c.independenceGroup ?? "single")])].sort();
  const bySignature = new Map<string, ComparableClaim[]>();
  for (const c of claims) {
    const sig = JSON.stringify(signatureOf(c));
    bySignature.set(sig, [...(bySignature.get(sig) ?? []), c]);
  }

  const agreements: AgreementGroup[] = [];
  const disagreements: ProposedDisagreement[] = [];
  const singletons: string[] = [];

  for (const [sigText, members] of bySignature) {
    const signature = JSON.parse(sigText) as Record<string, string>;
    const present = new Set(members.map((m) => m.independenceGroup ?? "single"));
    const key = (kind: DisagreementKind) => shortId("dis", workflowId, subjectKey, sigText, kind);

    if (groups.length > 1 && present.size < groups.length) {
      singletons.push(sigText);
      disagreements.push({
        disagreementKey: key("missing"), kind: "missing", severity: "material",
        subjectSignature: signature, claimIds: members.map((m) => m.claimId),
      });
      continue;
    }
    /* One reader saying a thing twice is one reader. Agreement takes two. */
    if (members.length < 2 || present.size < 2) continue;

    const first = members[0];
    let kind: DisagreementKind | null = null;
    for (const other of members.slice(1)) {
      if (other.observationBasis !== first.observationBasis) { kind = "count_basis"; break; }
      if (normaliseUnit(other.unit) !== normaliseUnit(first.unit)) { kind = "unit"; break; }
      if (!valueEqual(first, other)) { kind = "value"; break; }
    }
    if (kind === null) {
      agreements.push({ signature, claimIds: members.map((m) => m.claimId), groups: [...present].sort() });
      continue;
    }
    const severity: DisagreementSeverity = kind === "count_basis" ? "critical" : "material";
    disagreements.push({
      disagreementKey: key(kind), kind, severity, subjectSignature: signature,
      claimIds: members.map((m) => m.claimId),
    });
  }

  return { agreements, disagreements, singletons };
}
