# What each provider actually did in the Core V2 canary — and which roles it should be given next

Everything below comes from the records the paid canary left behind:
`agent_attempts`, `attempt_cost_reservations`, `evidence_claims`,
`evidence_anchors`, `claim_assessments`, `disagreements` and `decisions`. No
provider was asked to assess itself, and nothing here is taken from a vendor's
own description of its models. Where the record does not establish something,
this document says **not yet proven** rather than filling the gap.

Read once, plainly: **the canary did not run a fair contest.** The three
providers were given *different jobs*. Two read records; one criticised and
composed. Nothing here supports the sentence "provider X is best", and this
document does not contain it.

---

## 1 · Who was asked to do what

Core V2 addresses model families, not vendors. The canary bound them like this:

| Family in the record | Provider | Roles it was ever given |
|---|---|---|
| `reader-family-one` | **Anthropic** | `region_discoverer`, `table_reader`, `note_reader` |
| `reader-family-two` | **OpenAI** | `table_reader`, `note_reader` |
| `critic-family-one`, `arbiter-family-one` | **Google** | `evidence_critic`, `disagreement_verifier`, `decision_composer` |

Consequences that matter for every number below:

- Only Anthropic ever performed **discovery**. OpenAI and Google were never
  asked to segment a sheet, so nothing is known about them there.
- Only Anthropic and OpenAI ever performed **blind extraction**, and they
  performed it on the *same* segments, which is what makes their readings
  comparable to each other and to the fixture's own truth.
- Only Google ever performed **criticism, verification or composition**, so its
  numbers are not comparable to the readers' at all — different task, different
  packet, different failure surface.

---

## 2 · The two measurement windows

The brief asks for the measurements twice, and the difference is large enough
that reporting only one would be misleading.

**Window A — every canary attempt.** Includes the period when the adapters were
still wrong: a doubled path segment in one base URL, a JSON-Schema dialect one
provider's schema parser does not accept, an output ceiling set too low, task
leases that outlived the process holding them, and role contracts that were a
phrase rather than a specification.

**Window B — after that provider's adapter and contract became stable.** Two
workflows meet this test, and only two:

| Workflow | Seed |
|---|---|
| `b27a2a44-0188-5b20-bb3f-6c5e50286071` | `core-v2-canary-1-g18` |
| `7cbcb7ce-f7f2-5e09-8f80-c0442dcb4fe2` | `core-v2-canary-1-g19` |

Window B is **small** — 6 Anthropic attempts, 4 OpenAI, 6 Google. It is clean,
and it is not enough to establish a rate. Every confidence rating in section 9
is held down by that fact.

---

## 3 · Attempts, by provider and window

Counts are of model attempts only; deterministic (code) executors are excluded
throughout, and never cost anything.

| Provider | Window | Attempts | Succeeded | Failed, known | Outcome unknown | Never sent |
|---|---|---:|---:|---:|---:|---:|
| Anthropic | A (all) | 48 | 31 | 6 | 6 | 5 |
| Anthropic | B (stable) | 6 | **6** | 0 | 0 | 0 |
| OpenAI | A (all) | 28 | 16 | 2 | 2 | 8 |
| OpenAI | B (stable) | 4 | **4** | 0 | 0 | 0 |
| Google | A (all) | 12 | 3 | 7 | 1 submitted, never resolved | 1 prepared |
| Google | B (stable) | 6 | 3 | 1 | 1 | 1 |

"Never sent" is a cancellation before submission — the engine stopping work it
had not yet bought. It is not a failure of anything, and it cost $0.

Two rows deserve to be read slowly:

- **All three of Google's successes are in window B.** Before the schema dialect
  was fixed it had none. Its window-A record is almost entirely a record of our
  request builder.
- **Google still has one attempt in `submitted` and one in `prepared` inside a
  stable generation.** The `submitted` one is an attempt that may have been
  served and whose answer nobody ever saw. The engine is behaving correctly by
  leaving it there — it is never bought again by a machine — but it means
  Google's clean-window denominator is 6 attempts of which only 4 ever reached a
  verdict.

---

## 4 · Failures, separated honestly

The brief is explicit: a failure our own URL, schema, ceiling or timeout caused
is an integration defect, not evidence that a model reasoned poorly. Every
failure in the record is classified below, with the provider's own words where
the provider spoke.

### Integration defects — ours, not the model's

| Provider | Count | What the record says | Whose fault |
|---|---:|---|---|
| Anthropic | 1 | `400 — tools.0.custom: For 'object' type, 'additionalProperties: object' is not supported` | our tool schema |
| Anthropic | 1 | `400 — The compiled grammar is too large … simplify your tool schemas` | our tool schema |
| Anthropic | 1 | `404 — Not found` (a doubled path segment in the base URL) | our route |
| Anthropic | 3 | `lease_expired_after_submission` — "the worker holding this attempt did not come back" | our clock |
| Anthropic | 3 | `provider_outcome_unknown` | our clock |
| OpenAI | 2 | `lease_expired_after_submission` | our clock |
| Google | 2 | `400 — Unknown name "type" … Proto field is not repeating, cannot start list` | our schema dialect |
| Google | 1 | `output_ceiling_reached` — the answer stopped at 4096 tokens and is incomplete | our ceiling |
| Google | 1 | `material_refused` — material for a segment this assignment names did not come back | our fixture wiring |

That is **15 of the 23 non-success outcomes in the whole canary** — the other
eight being four briefing defects and four model behaviours, below. The single
largest cause of lost readings was arithmetic about time, not model quality:
eight attempts were lost to the clock — five to a task lease that outlived the
process holding it, three recorded only as an unknown provider outcome. That
class of failure is what `workers/core-v2-runner/clock.ts` exists to make
impossible.

### Briefing defects — our contract, not the model's reasoning

These are answers the model gave in good faith that our validator rejected for a
convention nobody had told it:

| Provider | Count | The validator's words |
|---|---:|---|
| Anthropic | 1 | `claim entry-E-001-quantity: subject E-001 is not an entry` |
| Anthropic | 1 | `segment sheet-1-table-1: box is not normalised 0..1` |
| OpenAI | 1 | `claim E-001: an entry names its category` |
| OpenAI | 1 | `anchor E-001 lies outside the segment it names` |

All four were fixed by writing the rule into the role's own `outputContract`
rather than leaving it in the validator. None recurred afterwards.

### Model-behaviour failures — the residue

What is left after both classes above are removed:

| Provider | Count | What happened |
|---|---:|---|
| Anthropic | 1 | `answer_without_outcome` — the answer did not say how it ended |
| Google | 1 | `assessment names claim A, which the packet did not present` |
| Google | 1 | `assessment of A cites anchor …, which the envelope does not carry` |
| Google | 1 | `decision_composer may not return assessments` — in a **stable** generation |

Four attempts across the whole canary. Three of the four are Google's, and all
three are the same shape: **the critic reached for something outside the packet
it was handed.** Two invented a reference; one answered in the wrong role's
vocabulary. That is a real, specific, repeated behaviour and it is the single
most important qualitative finding about Google in this record.

---

## 5 · Latency

Wire latency, `submitted_at` → `received_at`, successes only, milliseconds.

| Provider | Window | n | Mean | Min | Median | Max |
|---|---|---:|---:|---:|---:|---:|
| Anthropic | A | 31 | 19 314 | 5 972 | 10 811 | 55 565 |
| Anthropic | B | 6 | 38 546 | 18 201 | 41 699 | 55 565 |
| OpenAI | A | 16 | 11 283 | 5 890 | 11 115 | 16 801 |
| OpenAI | B | 4 | 11 586 | 5 890 | 12 492 | 15 470 |
| Google | A = B | 3 | 20 763 | 16 066 | 18 853 | 27 371 |

Three things the table says:

1. **OpenAI is the tightest distribution in the record** — 5.9 s to 16.8 s
   across sixteen answers, and the stable window did not move it. A budget can
   be written around that.
2. **Anthropic got slower in the stable window, not faster.** Its median went
   from 10.8 s to 41.7 s. This is expected and is ours: window B is where the
   role contracts became long and specific, so the same reader is doing more
   work per call. It is still worth stating plainly, because a 55-second answer
   inside a 150-second process is exactly the arithmetic that broke the canary.
3. **Google's three successes are all in the 16–27 s band**, but three points do
   not make a distribution.

---

## 6 · Tokens, and what was paid

From `attempt_cost_reservations.normalized_usage` (`core-v2.usage.1`) and
`settled_cost`. Window A here means *before* the stable generations, so the two
columns add up to the provider's whole record.

| Provider | Window | Uncached input | Cache read | Visible output | Reasoning output | Settled | Still held |
|---|---|---:|---:|---:|---:|---:|---:|
| Anthropic | before B | 110 170 | 0 | 21 402 | **0** | $1.085900 | $1.658880 |
| Anthropic | B | 24 781 | 0 | 5 244 | **0** | $0.255005 | $0 |
| OpenAI | before B | 22 581 | 9 810 | 4 472 | 4 669 | $0.277068 | $0.245760 |
| OpenAI | B | 6 082 | 3 254 | 1 208 | 957 | $0.068930 | $0 |
| Google | before B | 6 105 | 0 | 972 | 7 951 | $0.119286 | $0.131072 |
| Google | B | 7 253 | 0 | 2 385 | 10 248 | $0.166102 | $0.114688 |

**Whole canary: $1.972291 settled across 59 reservations. $2.150400 is still
held against 14 attempts that never came back with an outcome, and $0.065536 was
released unspent.** Money held against an unknown outcome stays held; that is
the design, and "free" and "unknown" are deliberately different facts in this
record.

Hidden reasoning relative to visible output:

| Provider | Reasoning ÷ visible output (whole canary) | Reasoning ÷ visible output (window B) |
|---|---:|---:|
| Anthropic | **0.00** — never reported a reasoning token | 0.00 |
| OpenAI | 0.99 | 0.79 |
| Google | **5.42** | **4.30** |

Google spent between four and five hidden tokens for every visible one. On the
critic role — the role where the visible output is three short assessments —
that is where its money went. Anthropic's zero is a fact about what this
canary's adapter received and recorded, not proof that no internal reasoning
occurred; it means no reasoning tokens were ever *reported* to us, so none could
ever be priced.

**Only OpenAI ever showed a cache read** (13 064 tokens across the canary).
Neither of the other two returned a cached-input figure our normaliser could
record, so prompt-cache economics are **not yet proven** for them here.

---

## 7 · Did the readers get it right?

This is the part that is actually about reading, and it is the strongest signal
in the whole record.

The fixture is deterministic in its seed, so the truth of each generation is
computable, not opinion:

| Generation | Truth |
|---|---|
| `…g18` | E-001 beta 5 kg · E-002 gamma 2 each · E-003 beta 40 kg |
| `…g19` | E-001 gamma 5 each · E-002 beta 39 kg · E-003 beta 15 kg |

In the stable window, Anthropic and OpenAI each read all three entries of both
generations, blind to each other. **All twelve readings match the truth exactly
— quantity, unit and category.** Twelve of twelve, two independent readers,
zero corrections.

And the corollary, which is just as important: across the *entire* canary,
`disagreements` contains **fourteen rows and not one of them is a value
disagreement.** Every one is `coverage` or `missing` — a reading that never
arrived because a lease expired or a request was rejected. The two readers never
once disagreed about what a record said. The adjudication path has therefore
**never been exercised on a real disagreement**, and its behaviour is **not yet
proven**.

### Anchor discipline

Forty-nine anchors were produced by models: 43 attached to claims (21 Anthropic,
22 OpenAI) and 6 attached to assessments (Google). **Every one of the 49 carries
verbatim quoted text**, and no model claim was ever recorded without an anchor.
This held in both windows and for all three providers. It is the one discipline
the canary establishes for every provider it touched.

### The note that could not be read — and what both readers did about it

Our own fixture renders each note as a ~170-byte PNG. It is not legible; no
model could read it. Every stable `note_reader` attempt succeeded, and every one
of them returned zero claims with `outcome: insufficient_evidence` and said why:

> "was supplied as a 167-byte PNG image that renders as a blank/illegible strip;
> no text could be read from it … Because no text could be read, no entry
> identifier and no revision status could be observed, so no claims are made."
> — Anthropic

> "The note image for segment … is too small and unreadable to identify an entry
> or revision status reliably. Human review of the source image is needed."
> — OpenAI

Both readers were handed unreadable material and **neither invented a reading**.
Anthropic went further and named the byte count, the failure mode, and the
contract clause it was obeying. Across the whole canary, exactly one
`revision_status` claim was ever recorded, and it is `unresolved`. So: note
reading is an **integration defect of ours that is not yet fixed**, and the
extraction-refusal behaviour of both readers is the clearest positive evidence
in the record.

---

## 8 · Provider by provider

### Anthropic

- **Roles actually performed:** discovery (`region_discoverer`), blind table
  extraction, blind note extraction.
- **Successful attempts:** 31 of 48 overall; 6 of 6 in the stable window.
- **Known failures:** 6, of which 3 are our URL or tool schema, 2 are our
  briefing, and 1 is a model behaviour (`answer_without_outcome`).
- **Unknown outcomes:** 6, all caused by our lease arithmetic. $1.658880 is
  still held against them.
- **Latency:** median 10.8 s overall, 41.7 s under the fuller stable contract,
  max 55.6 s.
- **Tokens:** 134 951 input, 26 646 visible output, **0 reasoning reported**,
  no cache reads recorded.
- **Settled cost:** $1.340905.
- **Structured output:** 34 answers reached the validator; 3 were rejected
  (≈9%), none in the stable window.
- **Evidence discipline:** 21 anchors, all verbatim, no unanchored claim.
- **Useful qualitative behaviour:** the most explicit refusals in the record —
  it named the byte count of the unreadable material, the fact it had no
  coordinates to give, and the contract clause it was following.
- **Protocol limitations found:** rejects `additionalProperties` as an object;
  refuses over-large compiled grammars, which caps how baroque a role's output
  schema may be.
- **Recommended primary roles:** discovery and segmentation; blind table
  extraction.
- **Roles it should not receive yet:** criticism and decision composition — it
  has never performed them here.
- **Configuration required:** strict tool schemas with `additionalProperties:
  false` and no unions; a per-role output schema small enough to compile; an
  answer window of at least 60 s, because 55.6 s is inside its observed range.

### OpenAI

- **Roles actually performed:** blind table extraction, blind note extraction.
- **Successful attempts:** 16 of 28 overall; 4 of 4 in the stable window.
- **Known failures:** 2, both our briefing.
- **Unknown outcomes:** 2, both our lease arithmetic. $0.245760 still held.
- **Latency:** the tightest band measured — 5.9 s to 16.8 s, median 11.1 s,
  unchanged by the stable window.
- **Tokens:** 28 663 uncached input, **13 064 cache reads — the only cache
  economics in the record**, 5 680 visible output, 5 626 reasoning.
- **Settled cost:** $0.345998.
- **Structured output:** 18 answers reached the validator; 2 were rejected
  (≈11%), none in the stable window.
- **Evidence discipline:** 22 anchors, all verbatim, no unanchored claim.
- **Useful qualitative behaviour:** concise, correctly-scoped refusals, and it
  volunteered the right next step ("human review of the source image is
  needed") rather than only reporting failure.
- **Protocol limitations found:** none attributable to it. Both its rejections
  were rules we had not written down.
- **Recommended primary roles:** blind extraction at volume, and the
  latency-sensitive half of any comparison pair.
- **Roles it should not receive yet:** discovery, criticism, composition — never
  attempted here.
- **Configuration required:** stable prompt prefixes so the cache reads keep
  happening; an answer window of 30 s is generous against everything observed.

### Google

- **Roles actually performed:** evidence criticism, disagreement verification,
  decision composition.
- **Successful attempts:** 3 of 12 overall — **all three in the stable window**:
  two `evidence_critic`, and one `decision_composer` whose envelope was empty.
- **Known failures:** 7. Four are ours (two schema-dialect 400s, one output
  ceiling, one fixture wiring). Three are model behaviour: two assessments that
  reached outside the packet, and one — in a stable generation — that answered
  in the wrong role. Five of the seven were `evidence_critic` attempts.
- **Unknown outcomes:** one attempt submitted and never resolved; one prepared
  and never sent. $0.245760 still held between them.
- **Latency:** three successes, 16.1 s / 18.9 s / 27.4 s.
- **Tokens:** 13 358 input, 3 357 visible output, **18 199 reasoning** — 5.4
  hidden tokens per visible token.
- **Settled cost:** $0.285388.
- **Structured output:** the weakest measured. Of 7 answers that reached the
  validator, 3 were rejected outright and 1 was truncated at our ceiling.
- **Evidence discipline:** its 6 assessment anchors all quote the source row
  verbatim — e.g. `E-002     beta       39        kg` — and its explanations
  name the values it confirmed. When it stayed inside the packet, its criticism
  was exactly what the role asks for.
- **Useful qualitative behaviour:** the successful critic responses are the best
  worked evidence in the record: one anchor per claim, quoted, with a
  reason code and a one-line explanation that restates the confirmed values.
- **Protocol limitations found:** its schema parser does not accept the
  JSON-Schema dialect we sent (union `type` arrays are rejected as
  "Proto field is not repeating"); and 4096 output tokens is not enough for the
  critic role.
- **Recommended primary roles:** evidence criticism, as a **secondary** with a
  packet-bounds check in front of it.
- **Roles it should not receive yet:** decision composition — see below — and
  disagreement verification, which has one attempt and zero successes.
- **Configuration required:** a proto-compatible schema translation; an output
  ceiling of at least 16 384; and a validator that refuses out-of-packet
  references *before* they cost anything, which is what its three real failures
  all needed.

#### Decision composition did not happen

Four `decision_composer` attempts: one rejected for returning assessments, two
that never resolved, and one "success" whose envelope was **empty** —
`outcome: completed`, zero decisions, zero claims, zero anchors.

Meanwhile all 30 `accept_claim` decisions in the record carry
`authority = deterministic_rule`, and the 14 `hold` decisions carry
`authority = adjudicator, status = needs_human`. No decision in this database
was composed by a model.

**Model-composed decision-making is entirely unproven.** Production Runner V1
should not route it to anyone yet.

---

## 9 · The plain answers

**Which AI was most reliable at structured extraction?**
On this evidence they are indistinguishable, and both are excellent. Anthropic
and OpenAI each read 6 of 6 stable segments correctly, each produced verbatim
anchors for every claim, and each rejected ≈1 in 8 answers *before* the contract
was written properly and none after. OpenAI did it in a third of the time.
Calling a winner on 6 versus 4 clean attempts would be an invented result.

**Which handled discovery and segmentation best?**
Anthropic, because it is the only provider that ever tried: 15 of 20 attempts
succeeded overall, 2 of 2 in the stable window, and its five failures were three
of our defects, one of our briefing, and one malformed answer. For the other two
providers, discovery is **not yet proven**.

**Which was strongest as an evidence critic?**
Google is the only candidate, and its record is mixed rather than strong: two
clean criticisms against two out-of-packet failures, with three further critic
attempts lost to our schema, our ceiling and our fixture. When it stayed inside the packet its
assessments were exemplary — quoted, reason-coded, value-restating. When it did
not, it cited a claim the packet never presented. **Best available, not proven
good.**

**Which consumed the most hidden reasoning relative to visible output?**
Google, decisively — 5.4 reasoning tokens per visible token across the canary,
4.3 in the stable window. OpenAI ran at about 1.0. Anthropic reported none at
all, so none could be priced.

**Which role allocation should Production Runner V1 use first?**
Section 10.

**What must the next clean acceptance run measure?**
Section 11.

---

## 10 · Routing table for Production Runner V1

| Core V2 role | Primary provider | Secondary provider | Why | Confidence |
|---|---|---|---|---|
| Discovery / segmentation | **Anthropic** | none yet | Only provider ever to do it; 2/2 clean, 15/20 overall, every failure traced to our route, schema or briefing | **Low–moderate** — no alternative has ever been measured |
| Blind extraction (reader A) | **Anthropic** | OpenAI | 6/6 correct against computed truth; most explicit refusals in the record | **Moderate** — correct on every clean attempt, but only six of them |
| Blind extraction (reader B) | **OpenAI** | Anthropic | 6/6 correct, tightest latency band (5.9–16.8 s), only provider showing cache reads | **Moderate** — same small denominator |
| Comparison / independence | *kernel, deterministic* | — | Every comparison in the canary was made by the kernel; the 14 disagreements are all coverage gaps, never value conflicts | **Not yet proven** for any model — the path has never seen a real disagreement |
| Critic / evidence verification | **Google** | none yet | The only provider measured on it; verbatim anchors and clean reason codes when inside the packet | **Low** — 2 clean criticisms, 2 out-of-packet failures; needs a bounds check in front |
| Derivation | *kernel, deterministic* | — | `category_totaliser` ran as code and cost nothing; no model was asked | **Not applicable** — deliberately not a model role |
| Decision composition | **none — hold for a person** | — | Four attempts, one empty "success", zero decisions ever composed by a model; every real decision came from a deterministic rule or a human hold | **Not yet proven** |

The runner should start with exactly this table: two readers, an Anthropic
discoverer, deterministic derivation, Google as a critic behind a packet-bounds
check, and **no model composing decisions at all**.

---

## 11 · What the next clean acceptance run has to measure

Everything below is currently unproven, and each is unproven for a reason the
record names.

1. **A real value disagreement.** Zero have ever occurred. Until two readers
   genuinely differ, adjudication, `disagreement_verifier` and the whole
   arbitration path are untested against anything but coverage gaps.
2. **Note reading, on legible material.** Our fixture renders notes as ~170-byte
   PNGs. Fix the material, then measure — one `revision_status` claim in the
   entire canary is not a measurement.
3. **A rate, not a sample.** Six and four clean attempts cannot support a
   reliability figure. Enough generations to give each reader tens of clean
   attempts per role.
4. **Google inside its packet.** Re-run the critic with the proto-compatible
   schema, a 16 384 output ceiling, and a bounds check, and count how often it
   still reaches outside.
5. **Decision composition, or its formal abandonment.** Either a model composes
   a decision with evidence, or the role is declared deterministic-plus-human
   and the packet stops being built for it.
6. **Latency under the fuller contracts.** Anthropic's median went from 10.8 s
   to 41.7 s when the contracts got specific. The runner's clock is built
   around a 60-second answer window; the next run should confirm that window is
   right rather than assume it.
7. **Cache economics for Anthropic and Google.** Only OpenAI ever returned a
   cache read. Whether that is the provider, the adapter or the prompt shape is
   unknown, and it is the single largest available cost reduction.
8. **The held money.** $2.150400 sits against 14 attempts with unknown
   outcomes. A clean run should reconcile them against each provider's own
   record and measure how much of an unknown outcome is genuinely unknowable.
