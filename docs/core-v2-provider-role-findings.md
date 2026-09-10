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

And three rules this document holds itself to throughout:

- **A count of successful calls is not a ranking of models.** Every count is a
  count of what we asked for, under which adapter and which contract version.
- **A rule we never told a model is not that model's defect.** Where the record
  cannot show the rule was in the contract, the answer is recorded exactly and
  left unattributed.
- **A technically accepted answer is not a completed assignment.** Calls, table
  rows and segments are counted separately, and an empty envelope is counted as
  an empty envelope.

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

**A COUNT OF SUCCESSFUL CALLS IS NOT A RANKING OF MODELS.** Every number in
that table is a count of *our* invocations: how many times we asked, under
which adapter, with which schema, at which contract version, on which role.
Anthropic has the most successes because it was given the most work and the
most roles; Google has the fewest because it was given six attempts, four of
which our own request builder made unanswerable. Read the rows as a record of
what this system did, never as a score any provider earned. Nothing in this
document ranks providers against each other, and no row here would support it
if it tried.

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
eight being four briefing defects and four answers our checker refused, below,
which the record cannot attribute. The single
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

### Answers our checker refused — and what the record can and cannot say about why

Four attempts are left after both classes above. They are recorded here
exactly, and then *not* attributed, because the record does not contain the
one thing attribution would need.

| Provider | Count | What the checker said | What the answer actually contained |
|---|---:|---|---|
| Anthropic | 1 | `answer_without_outcome` — the answer does not say how it ended | an envelope with no outcome field |
| Google | 1 | `assessment names claim A, which the packet did not present` | 3 assessments, **0 anchors** |
| Google | 1 | `assessment of A cites anchor …, which the envelope does not carry` | 3 assessments, **0 anchors** |
| Google | 1 | `decision_composer may not return assessments` (stable generation) | 3 assessments **with 3 quoted anchors**, outcome `completed` |

Two things follow, and the second is the more important.

**The two Google reference errors are one error.** Both answers carried three
assessments and an empty `anchors` array. They did not invent a source; they
named anchor keys they had not also returned. The checker is right to refuse
that, and the refusal reads as "cited something that is not here" whichever
way round the omission happened.

**None of these four can be called a model defect on this evidence.** The rule
each answer broke — an outcome field is required; an assessment names an anchor
you also return; a composer returns decisions and not assessments — has to have
been *in the contract the role was handed* before a violation of it is the
model's error rather than ours. Prompts are deliberately not retained, and the
role contracts of that generation are not in the record either. What *is* in
the record is that the contracts of that era were one-line phrases: the repair
that stopped four other refusals recurring was writing the rule into the role's
own `outputContract`, and it worked every time it was applied. The reasonable
reading is therefore that these are the same class — **rules we enforced but had
not stated** — and the honest label is **not yet proven either way**.

The last row deserves saying plainly: the composer produced three assessments
with three verbatim anchors, which is substantive work, and it was refused on
which field that work arrived in.

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

**These rows are not comparable to each other and must not be read as speed.**
Every provider answered a different mixture of roles, on different material,
under a different contract version, with different output ceilings. The one
comparison the record could support — the same role, the same segments, the
same contract — is the blind-extraction pair, and even there the two readers
were handed *different* role contracts at different times. Until a run holds
role, material and contract version fixed, no statement of the form "X is N
times faster than Y" is supported by anything here, and this document does not
make one.

What the rows do say, each about itself:

1. **OpenAI's own distribution is tight** — 5.9 s to 16.8 s across sixteen
   answers, and the stable window did not move it. A timeout can be written
   around its own numbers.
2. **Anthropic got slower in the stable window, not faster.** Its median went
   from 10.8 s to 41.7 s. This is ours: window B is where the role contracts
   became long and specific, so the same reader is doing more work per call —
   which is also why its window-B latency cannot be compared with anyone
   else's window-B latency. It matters because a 55-second answer inside a
   150-second process is exactly the arithmetic that broke the canary.
3. **Google's three successes are all in the 16–27 s band**, on the critic role
   only, and three points do not make a distribution.

---

## 6 · Tokens, and what was paid

From `attempt_cost_reservations.normalized_usage` (`core-v2.usage.1`) and
`settled_cost`. Window A here means *before* the stable generations, so the two
columns add up to the provider's whole record.

| Provider | Window | Uncached input | Cache read | Visible output | Reasoning output | Settled | Still held |
|---|---|---:|---:|---:|---:|---:|---:|
| Anthropic | before B | 110 170 | 0 | 21 402 | **not reported separately** | $1.085900 | $1.658880 |
| Anthropic | B | 24 781 | 0 | 5 244 | **not reported separately** | $0.255005 | $0 |
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
| Anthropic | **unknown** | **unknown** |
| OpenAI | 0.99 | 0.79 |
| Google | **5.42** | **4.30** |

**Anthropic's reasoning figure is unknown, and a zero in that column would be a
false reading of our own normaliser.** For that adapter the whole of the output
arrives as one count, and the runtime records it under `visible_output_tokens`
because that is the only honest place to put a number nobody has split. An
empty `reasoning_output_tokens` field therefore means *this adapter did not
receive a separate reasoning figure* — not that no thinking happened, and
certainly not that any thinking was free. Whatever Anthropic's models thought
was inside the 26 646 output tokens that were counted, and it was paid for at
the output rate along with everything else.

What the record does support: **OpenAI reported roughly one hidden token per
visible one, and Google reported between four and five.** For Google that is
where the money went, on a role whose visible output is three short
assessments. For Anthropic the ratio is not a small number — it is a number the
canary never collected, and section 11 lists collecting it as work.

**Only OpenAI ever showed a cache read** (13 064 tokens across the canary).
Neither of the other two returned a cached-input figure our normaliser could
record. As with reasoning, that is a fact about what our adapters received and
recorded — whether the cause is the provider, our adapter or the shape of our
prompts is **not yet proven**, and is the same investigation.

---

## 7 · Did the readers get it right?

This is the part that is actually about reading, and it is the strongest signal
in the whole record.

**First, what is being counted.** A call, a table row and a segment are three
different units and this document keeps them apart:

| Unit | What it counts | Whole canary |
|---|---|---:|
| model call submitted | one request that actually left for a provider | **74** |
| answer accepted | a call whose envelope passed the checker | **50** |
| answer that produced something | an accepted envelope carrying at least one claim, assessment, segment or decision | **31** |
| answer that refused, with a stated reason | an accepted envelope carrying no output and at least one limitation | **18** |
| answer that was simply empty | accepted, no output, no reason given | **1** |
| table row read | one entry of one table, read by one reader — the unit every "6 of 6" in this document counts | **43** claims |
| segment reported | one table or note located inside a sheet by a discovery | **28** |

Three of those lines need saying out loud.

**A refusal with a reason is not an empty answer.** Eighteen accepted answers
carried no claims because there was nothing legible to claim, and every one of
them said so. That is the assignment being done correctly, and it is counted
separately from both success and failure precisely so it cannot be quietly
folded into either.

**One accepted answer was genuinely empty.** The `decision_composer` attempt
that "succeeded" returned `outcome: completed` with no decisions, no claims, no
assessments, no anchors and no limitations. It was a technical success and it
did none of the assignment. Counting it as a completed role would misdescribe
the only decision-composition success in the record, so it is counted as a
call, as an accepted answer, and as nothing else.

**Calls, rows and segments never divide into one another.** 74 calls did not
produce 74 units of anything; 43 rows were read by two readers over a handful
of tables; 28 segments came from a smaller number of discoveries. Any ratio
built across these columns would be a statement about our task graph, not about
a provider.

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

**And "6 of 6" below means SIX TABLE ROWS, not six calls.** Each reader read
three entries in each of two stable generations, which is six checked values
per reader. Those twelve values came from **four** submitted calls between them
— two `table_reader` calls each. Counting calls where rows are meant, or the
other way round, is exactly the confusion this document's third rule exists to
stop; the two numbers are different sizes and neither divides into the other.

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
- **Successful attempts:** 31 of 48 calls overall; 6 of 6 calls in the stable
  window (of which two were `table_reader` calls, carrying the six checked
  row values below).
- **Known failures:** 6, of which 3 are our URL or tool schema, 2 are our
  briefing, and 1 an answer the checker refused that the record cannot
  attribute (`answer_without_outcome`).
- **Unknown outcomes:** 6, all caused by our lease arithmetic. $1.658880 is
  still held against them.
- **Latency:** median 10.8 s overall, 41.7 s under the fuller stable contract,
  max 55.6 s.
- **Tokens:** 134 951 input, 26 646 output — recorded as visible because this
  adapter receives one output count and nobody has split it. **How much of that
  was thinking is unknown**, and it was paid for either way. No cache reads
  recorded.
- **Settled cost:** $1.340905.
- **Structured output:** 34 answers reached the checker; 3 were refused (≈9%),
  none in the stable window; two of the three were rules our contracts had not
  stated, and the third is unattributed (section 4).
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
- **Structured output:** 18 answers reached the checker; 2 were refused (≈11%),
  none in the stable window, and both were rules we had not written down.
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
- **Successful attempts:** 3 of 12 overall — **all three in the stable window**.
  Two were `evidence_critic` answers that did the work: three assessments each,
  each anchored to a verbatim source row. The third was the `decision_composer`
  envelope that was accepted and empty. So: **two substantive answers, one
  technical one.**
- **Known failures:** 7. Four are unambiguously ours (two schema-dialect 400s,
  one output ceiling, one fixture wiring). Three were refused by our checker
  and are **not attributed** — see section 4; two of them are one omission, and
  the third contained three anchored assessments refused for arriving in the
  wrong field. Five of the seven were `evidence_critic` attempts.
- **Unknown outcomes:** one attempt submitted and never resolved; one prepared
  and never sent. $0.245760 still held between them.
- **Latency:** three successes, 16.1 s / 18.9 s / 27.4 s.
- **Tokens:** 13 358 input, 3 357 visible output, **18 199 reasoning** — 5.4
  hidden tokens per visible token.
- **Settled cost:** $0.285388.
- **Structured output:** of 7 answers that reached the checker, 3 were refused
  and 1 was truncated at our own 4096-token ceiling. Two of the three refusals
  are the same omission — assessments returned with an empty `anchors` array —
  and none of the three can be attributed on this evidence (section 4). This is
  the shortest record of the three providers, on the newest adapter, under a
  contract we never rewrote.
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
- **Recommended primary role:** evidence criticism — the role it holds today,
  which it keeps. A reference check in front of the decision it feeds is a
  sensible guard and is described below for what it is.
- **Roles it should not receive yet:** decision composition — see below — and
  disagreement verification, which has one attempt and zero successes.
- **Configuration required:** a proto-compatible schema translation; an output
  ceiling of at least 16 384; and role contracts that state, in the contract,
  the rules our checker enforces — the same repair that stopped four other
  refusals recurring for the two readers.

**A reference check is a guard on the decision, not a refund on the call.** It
is worth saying because the opposite is easy to assume. Checking that every
anchor an assessment names is actually in the envelope protects what happens
*after* generation: nothing unfounded reaches a decision. It does not recover
the money — the call was made, the tokens were counted, the reservation was
settled. Three of Google's twelve attempts were paid for and then refused at
the checker. Guards belong before the request, in the contract, wherever the
same defect can be prevented rather than caught.

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
The record does not separate them, and the counts must not be read as a
ranking. In the stable window each reader got **6 of 6 table-row values right**
— three entries in each of two generations, from two `table_reader` calls
apiece — and each anchored every claim verbatim; each had
around one refusal in eight *before* the contracts were written properly and
none after. Six and four clean attempts cannot distinguish two readers, and
their differing totals reflect how much work we gave each one.

**Which handled discovery and segmentation best?**
Anthropic is the only provider that ever tried: 15 of 20 attempts accepted,
2 of 2 in the stable window, 28 segments reported. Its five failures were three
of our defects, one of our briefing, and one unattributed malformed envelope.
For OpenAI and Google, discovery is **not yet proven** — not weaker, unmeasured.

**Which was strongest as an evidence critic?**
Google is the only provider that has ever held the role. Its record is two
substantive criticisms — three assessments each, every one anchored to a
verbatim row with a reason code — against three attempts our own request
builder, ceiling and fixture ruined, and two refused for an omission we cannot
show we told it to avoid. That is a thin record, not a poor one, and it is the
record of the newest adapter under the one role contract nobody rewrote.

**Which consumed the most hidden reasoning relative to visible output?**
Of the providers that report the figure, **Google**, at four to five hidden
tokens per visible one; OpenAI reported about one to one. **Anthropic's ratio is
unknown** — our normaliser receives one undivided output count for that adapter,
so an empty reasoning field there means "not measured", never "none" and never
"free".

**Which role allocation should Production Runner V1 use first?**
The one it already has, unchanged: Anthropic discovers and reads first, OpenAI
reads second and independently, Google criticises the evidence. This is a
**working configuration, not a proven ranking**, and none of the three is being
moved or dropped on this evidence. Section 10.

**What must the next clean acceptance run measure?**
Section 11.

---

## 10 · Routing table for Production Runner V1

The allocation the canary ran under, kept as it is. Confidence describes how
much the record proves about the assignment — never how the providers compare.

| Core V2 role | Primary provider | Secondary provider | Why | Confidence |
|---|---|---|---|---|
| Discovery / segmentation | **Anthropic** | none assigned yet | The only provider ever given the role; 2/2 clean, 15/20 overall, 28 segments; every failure traced to our route, schema or briefing | **Low–moderate** — the role works, no alternative has been measured |
| Blind extraction (reader A) | **Anthropic** | OpenAI | **6 of 6 table-row values** correct against computed truth, from 2 calls; every claim anchored verbatim; the most explicit refusals in the record | **Moderate** — every checked value right, but only six values from two calls |
| Blind extraction (reader B) | **OpenAI** | Anthropic | **6 of 6 table-row values** correct, from 2 calls; every claim anchored verbatim; its own latency band is tight and its cache reads are the only ones recorded | **Moderate** — same small denominator |
| Comparison / independence | *kernel, deterministic* | — | Every comparison in the canary was made by the kernel; the 14 disagreements are all coverage gaps, never value conflicts | **Not yet proven** for any model — the path has never seen a real disagreement |
| Critic / evidence verification | **Google** | none assigned yet | Two substantive criticisms with verbatim anchors and reason codes; the role stays where it is while its adapter and contract get the repair the readers already had | **Low** — thin record, most of it spent on our defects |
| Derivation | *kernel, deterministic* | — | `category_totaliser` ran as code and cost nothing; no model was asked | **Not applicable** — deliberately not a model role |
| Decision composition | **held for a person** | — | Four attempts: one accepted-and-empty, one refused on a field rule, two never resolved. No decision in the database was composed by a model | **Not yet proven** |

Two things this table is not. It is not a ranking: three providers held three
different assignments and no row compares one with another. And it is not a
verdict on Google — the critic role stays with Google, and what changes is the
schema translation, the output ceiling and the role contract, all of which are
ours.

## 11 · What is not yet proven, and what the next clean run has to measure

Two statements to keep together, because leaving either one out misleads.

**Not yet proven:** that two independent readers ever genuinely disagree about
a value, and that a model composes a decision anybody would want. Fourteen
disagreements were recorded and every one is a coverage gap — a reading that
never arrived — so the adjudication path has never been exercised on a real
conflict. Four decision-composition attempts produced one accepted-and-empty
envelope and no decisions at all.

**Already a full result:** the thirty decisions that were taken. They carry
`authority = deterministic_rule` because a machine rule decided them on
anchored, corroborated readings, and that is the system working as designed —
not a placeholder for a model that has not arrived. A decision taken by a rule
on evidence is a decision.

What the next clean run has to measure:

1. **A real value disagreement.** Zero have ever occurred. Until two readers
   genuinely differ, adjudication and `disagreement_verifier` are untested
   against anything but coverage gaps.
2. **Note reading, on legible material.** Our fixture renders notes as ~170-byte
   PNGs. Fix the material, then measure — one `revision_status` claim in the
   entire canary is not a measurement.
3. **A rate, not a sample.** Six and four clean attempts cannot support a
   reliability figure for anybody. Enough generations to give each reader tens
   of clean attempts per role.
4. **Google inside a contract it was given.** Re-run the critic with the
   proto-compatible schema, a 16 384 output ceiling, and the rule about anchors
   written into the role's own `outputContract` — the repair that stopped four
   equivalent refusals for the readers. Then count what is left.
5. **Anthropic's reasoning, separately.** The adapter records one undivided
   output count, so the split is unknown and unpriceable. Until it is
   collected, no statement about that provider's hidden-token cost is possible
   in either direction.
6. **Decision composition, or its formal abandonment.** Either a model composes
   a decision with evidence, or the role is declared deterministic-plus-human
   and the packet stops being built for it.
7. **The same role, material and contract on two providers at once.** Nothing in
   this document compares providers, because nothing in the canary held those
   three fixed. One generation that does would make the first honest
   like-for-like measurement this project has.
8. **Latency under the fuller contracts.** Anthropic's median went from 10.8 s
   to 41.7 s when its contracts got specific. The runner's clock is built
   around a 60-second answer window; the next run should confirm that window
   rather than assume it.
9. **Cache economics for Anthropic and Google.** Only OpenAI ever returned a
   cache read. Whether that is the provider, the adapter or the prompt shape is
   unknown, and it is the single largest available cost reduction.
10. **The held money.** $2.150400 sits against 14 attempts with unknown
    outcomes. A clean run should reconcile them against each provider's own
    record and measure how much of an unknown outcome is genuinely unknowable.
