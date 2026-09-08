/* WHAT CODE CAN SETTLE BEFORE ANYONE IS ASKED TO JUDGE.
 *
 * Two readers read the same segment blind. Before any model is paid to say
 * who was right, this lines their claims up by subject and predicate and says
 * — mechanically — where they agree, where they differ, and where only one of
 * them saw a thing at all. Normalisation is the domain pack's, and it is never
 * semantic; a model rewording a claim is not normalisation.
 *
 * It returns agreement groups and disagreements. It does not return a winner,
 * a score, or a ranking of readers. Agreement is recorded; it is not proof.
 * Every material attribute of a value is compared: two readings that agree on
 * a quantity and differ on an attribute differ.
 */
import type {
  ClaimValue, DisagreementKind, DisagreementSeverity, ObservationBasis, ProposedDisagreement,
} from "./contracts.ts";
import { canonical, entityId } from "./ids.ts";

export type ComparableClaim = {
  claimId: string;
  independenceGroup: string | null;
  subjectType: string;
  subjectKey: string;
  predicate: string;
  value: ClaimValue;
  unit: string | null;
  observationBasis: ObservationBasis;
  scope: Record<string, string>;
};

export type Normalisers = {
  unit(unit: string | null): string | null;
  key(key: string): string;
};

export const DEFAULT_NORMALISERS: Normalisers = {
  unit: (u) => (u === null || u === undefined ? null : u.toLowerCase().trim()),
  key: (k) => k.toUpperCase().replace(/[\s\-_./]+/g, "").trim(),
};

export type AgreementGroup = { signature: Record<string, string>; claimIds: string[]; groups: string[] };

export type ComparisonResult = {
  agreements: AgreementGroup[];
  disagreements: ProposedDisagreement[];
  singletons: string[];
};

export function normaliseScope(scope: Record<string, string>, n: Normalisers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(scope ?? {}).sort()) out[k.toLowerCase()] = n.key(String(scope[k]));
  return out;
}

export function signatureOf(claim: ComparableClaim, n: Normalisers): Record<string, string> {
  return {
    subject_type: claim.subjectType,
    subject_key: n.key(claim.subjectKey),
    predicate: claim.predicate.toLowerCase(),
    scope: JSON.stringify(normaliseScope(claim.scope ?? {}, n)),
  };
}

function attributesOf(v: ClaimValue, n: Normalisers): string {
  const attrs = v.attributes ?? {};
  const out: Record<string, string | number | null> = {};
  for (const k of Object.keys(attrs).sort()) {
    const a = attrs[k];
    out[k.toLowerCase()] = typeof a === "string" ? n.key(a) : a;
  }
  return canonical(out);
}

function valueEqual(a: ComparableClaim, b: ComparableClaim, n: Normalisers): boolean {
  if (a.value.known !== b.value.known) return false;
  if (!a.value.known) return true;
  if (attributesOf(a.value, n) !== attributesOf(b.value, n)) return false;
  if (a.value.quantity !== null || b.value.quantity !== null) return a.value.quantity === b.value.quantity;
  return n.key(a.value.text ?? "") === n.key(b.value.text ?? "");
}

/* Compare the claims of two or more independence groups for one subject.
   `readerGroups` names every group that read — including one that came back
   with nothing, which the claims alone could never show. */
export function compareClaims(
  workflowId: string, subjectKey: string, claims: ComparableClaim[], readerGroups: string[] = [], n: Normalisers = DEFAULT_NORMALISERS,
): ComparisonResult {
  const groups = [...new Set([...readerGroups, ...claims.map((c) => c.independenceGroup ?? "single")])].sort();
  const bySignature = new Map<string, ComparableClaim[]>();
  for (const c of claims) {
    const sig = JSON.stringify(signatureOf(c, n));
    bySignature.set(sig, [...(bySignature.get(sig) ?? []), c]);
  }

  const agreements: AgreementGroup[] = [];
  const disagreements: ProposedDisagreement[] = [];
  const singletons: string[] = [];

  for (const [sigText, members] of bySignature) {
    const signature = JSON.parse(sigText) as Record<string, string>;
    const present = new Set(members.map((m) => m.independenceGroup ?? "single"));
    const key = (kind: DisagreementKind) => entityId("disagreement-key", workflowId, subjectKey, sigText, kind);

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
      if (other.observationBasis !== first.observationBasis) { kind = "basis"; break; }
      if (n.unit(other.unit) !== n.unit(first.unit)) { kind = "unit"; break; }
      if (!valueEqual(first, other, n)) { kind = "value"; break; }
    }
    if (kind === null) {
      agreements.push({ signature, claimIds: members.map((m) => m.claimId), groups: [...present].sort() });
      continue;
    }
    const severity: DisagreementSeverity = kind === "basis" ? "critical" : "material";
    disagreements.push({
      disagreementKey: key(kind), kind, severity, subjectSignature: signature,
      claimIds: members.map((m) => m.claimId),
    });
  }

  return { agreements, disagreements, singletons };
}
