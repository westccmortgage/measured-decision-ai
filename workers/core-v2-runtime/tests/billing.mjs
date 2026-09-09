/* WHAT THE COUNTS MEAN, AND WHY ADDING THEM UP IS WRONG.
 *
 * Every provider reports what a call used, and no two mean the same thing by
 * it. One counts cache reads BESIDE its input count; two count them INSIDE
 * it. One bills its reasoning inside the output count; two report it beside.
 * A runtime that adds input + cached + output + reasoning charges twice for
 * the same tokens on two of the three, and nothing about the total shows it.
 *
 * This file holds the rules that replaced that sum. For each provider it
 * checks the components against the fixture's own documented reading, and
 * then checks the thing that actually matters: that the components add back
 * up to exactly what the provider said — no token counted twice, none lost.
 *
 * It also holds the two refusals. A provider that reported nothing usable
 * does not settle at zero: "free" and "unknown" are different facts, and only
 * one of them may be written down as a number. And a component the operator
 * never priced is not guessed at when guessing could cost money.
 */
import { readFileSync } from "node:fs";
import { harness, closeNetwork } from "../../core-v2/tests/harness.mjs";
import { NORMALIZATION_VERSION, billableRecord, priceUsage } from "../budget/usage.ts";
import { knownBillingDialects, normalizeUsage } from "../providers/usage-dialects.ts";
import { CEILING_RULE, authorizedProviders, ceilingRates, configurationProblems, costCeiling, networkAuthorizationProblems, NO_PAID_CALLS } from "../runtime-config.ts";
import { ceilingFor } from "../budget/ledger.ts";

const tripped = closeNetwork();
const t = harness("what the counts mean, and why adding them up is wrong");

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

const RATES = {
  currency: "USD",
  inputPerMillionTokens: 3,
  outputPerMillionTokens: 15,
  cachedInputPerMillionTokens: 0.3,
  cacheWritePerMillionTokens: 3.75,
  reasoningPerMillionTokens: null,
};

const perMillion = (tokens, rate) => (tokens / 1_000_000) * rate;
const round6 = (n) => Math.round(n * 1e6) / 1e6;

/* ═══════════════════════════════ 1 · the three dialects, from the fixtures */

const DIALECTS = [
  {
    providerId: "anthropic", fixtures: load("anthropic"),
    usageOf: (body) => body.usage,
    /* input_tokens excludes both cache figures; thinking is inside output. */
    inputTotal: (u) => u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    outputTotal: (u) => u.output_tokens,
  },
  {
    providerId: "openai", fixtures: load("openai"),
    usageOf: (body) => body.usage,
    /* cached is inside input; reasoning is inside output. */
    inputTotal: (u) => u.input_tokens,
    outputTotal: (u) => u.output_tokens,
  },
  {
    providerId: "google", fixtures: load("google"),
    usageOf: (body) => body.usageMetadata,
    /* cached is inside prompt; thoughts sit beside the candidates. */
    inputTotal: (u) => u.promptTokenCount,
    outputTotal: (u) => u.candidatesTokenCount + (u.thoughtsTokenCount ?? 0),
  },
];

t.section("each provider's counts mean what that provider means by them");
for (const dialect of DIALECTS) {
  const raw = dialect.usageOf(dialect.fixtures.good.body);
  const expected = dialect.fixtures.expectedNormalized;
  const usage = normalizeUsage(dialect.providerId, raw);

  t.check(`${dialect.providerId}: the components are what its own semantics make of its own numbers`,
    usage.complete
    && usage.uncachedInputTokens === expected.uncached_input_tokens
    && usage.cachedInputReadTokens === expected.cached_input_read_tokens
    && usage.cachedInputWriteTokens === expected.cached_input_write_tokens
    && usage.visibleOutputTokens === expected.visible_output_tokens
    && usage.reasoningOutputTokens === expected.reasoning_output_tokens,
    JSON.stringify(billableRecord(usage)));

  t.check(`${dialect.providerId}: NO TOKEN IS COUNTED TWICE — the components add back up to what it reported`,
    usage.uncachedInputTokens + usage.cachedInputReadTokens + usage.cachedInputWriteTokens === dialect.inputTotal(raw)
    && usage.visibleOutputTokens + usage.reasoningOutputTokens === dialect.outputTotal(raw),
    `${usage.uncachedInputTokens}+${usage.cachedInputReadTokens}+${usage.cachedInputWriteTokens} against ${dialect.inputTotal(raw)}`);

  t.check(`${dialect.providerId}: and the version of the rules that produced them is on the record`,
    usage.version === NORMALIZATION_VERSION && billableRecord(usage).normalization_version === NORMALIZATION_VERSION);
}

t.section("the same reported numbers, read three ways — which is the whole point");
{
  /* One object of numbers, deliberately shaped so that a naive adder would
     get the same answer for all three and the truth is different for each. */
  const cost = (providerId, raw) => priceUsage(RATES, normalizeUsage(providerId, raw));
  const anthropic = cost("anthropic", { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 400 });
  const openai = cost("openai", { input_tokens: 1400, output_tokens: 500, input_tokens_details: { cached_tokens: 400 }, output_tokens_details: { reasoning_tokens: 200 } });
  const google = cost("google", { promptTokenCount: 1400, candidatesTokenCount: 300, cachedContentTokenCount: 400, thoughtsTokenCount: 200 });

  /* All three describe the same call: 1000 uncached input, 400 cached, 500
     output of which 200 was reasoning where that is reported separately. */
  const byHand = round6(perMillion(1000, 3) + perMillion(400, 0.3) + perMillion(500, 15));
  t.check("three dialects describing one call price to the same number",
    anthropic.ok && openai.ok && google.ok
    && anthropic.cost === byHand && openai.cost === byHand && google.cost === byHand,
    `${anthropic.cost} / ${openai.cost} / ${google.cost} against ${byHand}`);

  /* What the old code did: add everything it found. */
  const naive = round6(perMillion(1400, 3) + perMillion(400, 0.3) + perMillion(500, 15) + perMillion(200, 15));
  t.check("and that number is NOT what adding up whatever numbers arrived would have said",
    naive > byHand, `adding everything gives ${naive}, the truth is ${byHand}`);
}

/* ══════════════════════════════════ 2 · unknown is not zero */

t.section("a call nobody can account for is not a free call");
{
  const cases = [
    ["the provider reported nothing at all", "anthropic", {}],
    ["the provider reported nothing usable", "anthropic", { some_other_field: "yes" }],
    ["there was no usage object", "anthropic", null],
    ["nobody has written the rules for this provider", "somebody-else", { input_tokens: 10, output_tokens: 10 }],
    ["a count is missing", "openai", { input_tokens: 100 }],
    ["a subset is bigger than what contains it", "openai", { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 500 } }],
    ["a reasoning subset is bigger than the output", "openai", { input_tokens: 100, output_tokens: 10, output_tokens_details: { reasoning_tokens: 50 } }],
    ["a cached subset is bigger than the prompt", "google", { promptTokenCount: 10, candidatesTokenCount: 5, cachedContentTokenCount: 50 }],
  ];
  for (const [what, providerId, raw] of cases) {
    const usage = normalizeUsage(providerId, raw);
    t.check(`${what}: the answer is "not known", not "nothing"`, usage.complete === false, JSON.stringify(billableRecord(usage)));
    t.check(`${what}: and it says why`, usage.problems.length > 0, usage.problems[0]);
    const priced = priceUsage(RATES, usage);
    t.check(`${what}: and it cannot be priced at all — least of all at zero`, priced.ok === false && priced.problems.length > 0);
  }

  const genuine = normalizeUsage("anthropic", { input_tokens: 0, output_tokens: 0 });
  const pricedZero = priceUsage(RATES, genuine);
  t.check("a provider that explicitly says it used nothing IS zero, and settles",
    genuine.complete === true && pricedZero.ok === true && pricedZero.cost === 0);
  t.check("every dialect this runtime knows is named, and nothing else is guessed at",
    JSON.stringify(knownBillingDialects().sort()) === JSON.stringify(["anthropic", "google", "openai"]),
    knownBillingDialects().join(","));
}

/* ═════════════════════════════ 3 · what the operator did not price */

t.section("a component nobody priced is not guessed at when guessing could cost money");
{
  const cached = normalizeUsage("anthropic", { input_tokens: 100, output_tokens: 100, cache_read_input_tokens: 1_000_000 });
  const noCachedRate = priceUsage({ ...RATES, cachedInputPerMillionTokens: null }, cached);
  t.check("a cache read with no cached rate is priced at the FULL input rate — an upper bound, never an under-count",
    noCachedRate.ok && noCachedRate.cost === round6(perMillion(100, 3) + perMillion(100, 15) + perMillion(1_000_000, 3)),
    `${noCachedRate.cost}`);
  t.check("and it says it did so rather than hiding it", noCachedRate.ok && noCachedRate.notes.some((n) => /full input rate/.test(n)));

  const written = normalizeUsage("anthropic", { input_tokens: 100, output_tokens: 100, cache_creation_input_tokens: 500 });
  const noWriteRate = priceUsage({ ...RATES, cacheWritePerMillionTokens: null }, written);
  t.check("a cache WRITE with no cache-write rate is refused — there is no upper bound to fall back to",
    noWriteRate.ok === false && noWriteRate.problems.some((p) => /cache-write rate/.test(p)), JSON.stringify(noWriteRate));

  const reasoning = normalizeUsage("google", { promptTokenCount: 100, candidatesTokenCount: 100, thoughtsTokenCount: 400 });
  const asOutput = priceUsage({ ...RATES, reasoningPerMillionTokens: null }, reasoning);
  t.check("reasoning reported beside the output is priced as output when nobody priced it separately",
    asOutput.ok && asOutput.cost === round6(perMillion(100, 3) + perMillion(100, 15) + perMillion(400, 15)), `${asOutput.cost}`);
  t.check("and it says so", asOutput.ok && asOutput.notes.some((n) => /priced as output/.test(n)));

  const priced = priceUsage({ ...RATES, reasoningPerMillionTokens: 30 }, reasoning);
  t.check("an operator who prices reasoning separately gets that rate",
    priced.ok && priced.cost === round6(perMillion(100, 3) + perMillion(100, 15) + perMillion(400, 30)), `${priced.cost}`);
}

t.section("the price is the rates it is handed, and nothing else");
{
  const usage = normalizeUsage("openai", { input_tokens: 1000, output_tokens: 200, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } });
  const then = priceUsage(RATES, usage);
  const now = priceUsage({ ...RATES, inputPerMillionTokens: 300, outputPerMillionTokens: 1500 }, usage);
  t.check("the same usage under two sets of rates gives two numbers — so the rates decide, not the moment",
    then.ok && now.ok && now.cost === round6(then.cost * 100), `${then.cost} then, ${now.cost} now`);
  t.check("and pricing reads nothing but its arguments — there is no configuration to look at",
    priceUsage.length === 2);
}

/* ══════════════ 5 · a ceiling that is actually a ceiling

   The reservation used to price the input ceiling at the ordinary input rate
   and the output ceiling at the ordinary output rate. That is not a maximum.
   A token ceiling bounds a CATEGORY — every billable input component added
   together, every billable output component added together — and a cache
   write can cost more than ordinary input, and a reasoning token more than
   visible output. So the same number of tokens could cost more than the hold
   taken for them, which is an overspend the engine arranged for itself.

   The rule now is: each category's ceiling priced at the HIGHEST rate any
   component of that category could be charged at. What follows does not
   assert that — it exhausts the mixtures and checks that none of them costs
   more than the hold. */

const TOKENS_IN = 200_000;
const TOKENS_OUT = 8_000;

const configPriced = (over = {}) => ({
  providers: [{
    providerId: "anthropic", baseUrl: "fixture://nothing", apiKeyEnvironmentVariable: "CORE_V2_BILLING_TESTS_KEY",
    models: ["reader"], defaultModel: "reader",
    maximumInputTokens: TOKENS_IN, maximumOutputTokens: TOKENS_OUT, requestTimeoutMs: 1000,
    maximumMaterialBytes: 1024, maximumMaterialBytesPerItem: 1024, supportedMediaTypes: ["text/plain"],
    capabilities: { reader: { forcedToolChoice: true, strictSchema: true, images: false, thinking: "optional" } },
  }],
  pricing: [{
    providerId: "anthropic", model: "reader", effectiveFrom: "2026-01-01", currency: "USD",
    inputPerMillionTokens: 3, outputPerMillionTokens: 15, cacheWritePerMillionTokens: 3, ...over,
  }],
  authorization: NO_PAID_CALLS,
  dispatcherName: "billing-tests",
});

const ratesOf = (config) => {
  const price = config.pricing[0];
  return {
    currency: price.currency,
    inputPerMillionTokens: price.inputPerMillionTokens,
    outputPerMillionTokens: price.outputPerMillionTokens,
    cachedInputPerMillionTokens: price.cachedInputPerMillionTokens ?? null,
    cacheWritePerMillionTokens: price.cacheWritePerMillionTokens ?? null,
    reasoningPerMillionTokens: price.reasoningPerMillionTokens ?? null,
  };
};

/* Every way the two token ceilings can be spent, in steps, including the
   corners. A settlement of any of these must cost no more than the hold. */
function* mixtures(inputTokens, outputTokens, steps = 8) {
  const cuts = Array.from({ length: steps + 1 }, (_, i) => Math.round((inputTokens * i) / steps));
  const outCuts = Array.from({ length: steps + 1 }, (_, i) => Math.round((outputTokens * i) / steps));
  for (const cached of cuts) {
    for (const written of cuts) {
      if (cached + written > inputTokens) continue;
      for (const reasoning of outCuts) {
        yield {
          version: NORMALIZATION_VERSION, providerId: "anthropic",
          uncachedInputTokens: inputTokens - cached - written,
          cachedInputReadTokens: cached,
          cachedInputWriteTokens: written,
          visibleOutputTokens: outputTokens - reasoning,
          reasoningOutputTokens: reasoning,
          unpriced: {}, complete: true, problems: [],
        };
      }
    }
  }
}

t.section("the hold is the worst case, not the ordinary case");
{
  const cases = [
    ["a cache-write rate above the ordinary input rate", { cacheWritePerMillionTokens: 30 }, 30, 15],
    ["a reasoning rate above visible output", { reasoningPerMillionTokens: 60 }, 3, 60],
    ["both of them at once", { cacheWritePerMillionTokens: 30, reasoningPerMillionTokens: 60 }, 30, 60],
    ["a cached-read rate below the input rate, which changes nothing", { cachedInputPerMillionTokens: 0.3 }, 3, 15],
    ["a cached-read rate ABOVE the input rate, which does", { cachedInputPerMillionTokens: 9 }, 9, 15],
    ["only the rates that are required", {}, 3, 15],
    ["every optional rate below the ordinary ones", { cachedInputPerMillionTokens: 0.3, cacheWritePerMillionTokens: 1, reasoningPerMillionTokens: 2 }, 3, 15],
  ];
  for (const [what, over, expectIn, expectOut] of cases) {
    const config = configPriced(over);
    const rates = ceilingRates(config.pricing[0]);
    t.check(`${what}: the ceiling rates are the highest of each category`,
      rates.input === expectIn && rates.output === expectOut, `input ${rates.input}, output ${rates.output}`);

    const ceiling = costCeiling(config, "anthropic", "reader", TOKENS_IN, TOKENS_OUT);
    const expected = round6(perMillion(TOKENS_IN, expectIn) + perMillion(TOKENS_OUT, expectOut));
    t.check(`${what}: and the hold is those rates against the token ceilings`,
      ceiling !== null && ceiling.maximumCost === expected && ceiling.rule === CEILING_RULE,
      `${ceiling?.maximumCost} vs ${expected}`);

    /* THE PROOF, exhaustively rather than by assertion: no mixture of
       components that fits inside the two token ceilings costs more than the
       hold taken for them.

       NOTHING IS SKIPPED. An earlier version of this loop passed over every
       mixture priceUsage would not price — which is exactly the set of
       mixtures a provider can bill and this runtime could not bound, so the
       loop was strongest precisely where the reservation was weakest. A
       mixture that cannot be priced is now a FAILURE of this test, not a
       continue: if a component can appear in a real answer, it has a rate, or
       nothing may be submitted at all. */
    let worst = 0;
    let overspend = null;
    let unpriceable = null;
    let counted = 0;
    let offered = 0;
    for (const usage of mixtures(TOKENS_IN, TOKENS_OUT)) {
      offered += 1;
      const priced = priceUsage(ratesOf(config), usage);
      if (!priced.ok) { unpriceable = unpriceable ?? { usage, problems: priced.problems }; continue; }
      counted += 1;
      if (priced.cost > worst) worst = priced.cost;
      if (priced.cost > ceiling.maximumCost + 1e-9) {
        overspend = { usage, cost: priced.cost };
        break;
      }
    }
    t.check(`${what}: EVERY mixture inside the ceilings can be priced — none is skipped`,
      unpriceable === null && counted === offered && offered > 0,
      unpriceable ? `a mixture nobody can price: ${unpriceable.problems.join("; ").slice(0, 90)}` : `${counted} of ${offered} priced`);
    t.check(`${what}: and no mixture inside the ceilings costs more than the hold`,
      overspend === null && counted > 0, overspend ? `${overspend.cost} > ${ceiling.maximumCost}` : `${counted} mixtures, worst ${worst} of ${ceiling.maximumCost}`);
    t.check(`${what}: the worst of them reaches the hold exactly, so it is not padding either`,
      Math.abs(worst - ceiling.maximumCost) < 1e-6, `worst ${worst}, hold ${ceiling.maximumCost}`);
  }
}

t.section("a price that establishes no upper bound reserves nothing");
{
  for (const [what, over] of [
    ["a cache-write rate that is not a number", { cacheWritePerMillionTokens: Number.NaN }],
    ["a negative reasoning rate", { reasoningPerMillionTokens: -1 }],
    ["a cached rate that is not finite", { cachedInputPerMillionTokens: Number.POSITIVE_INFINITY }],
  ]) {
    const config = configPriced(over);
    t.check(`${what}: no ceiling is worked out`,
      costCeiling(config, "anthropic", "reader", TOKENS_IN, TOKENS_OUT) === null && ceilingFor(config, "anthropic", "reader") === null);
    t.check(`${what}: and the reason is said in words`,
      ceilingRates(config.pricing[0]).problems.length > 0, ceilingRates(config.pricing[0]).problems[0]);
  }
  t.check("a model nobody priced has no ceiling either",
    ceilingFor(configPriced(), "anthropic", "a-model-nobody-priced") === null);
}

/* WHAT USED TO BE HERE WAS WRONG, AND THE WAY IT WAS WRONG IS THE POINT.
   A test called "a cache write with no rate can never be charged" asserted
   that priceUsage refuses such a settlement — true — and concluded that the
   charge therefore could not exceed the hold. It cannot: our refusal to work
   out what something cost does not reach the provider, which has already
   created the cache entry and already billed for it. The refusal protected
   the ledger's arithmetic and nothing about the money.

   So the rule is now the other one: a rate that settlement will never apply
   is not a bound, and an attempt whose request could produce that component
   is not submitted at all. */
t.section("a cache-write rate is required, because a charge nobody can price is still a charge");
{
  const unpriceable = { ...configPriced(), pricing: [{
    providerId: "anthropic", model: "reader", effectiveFrom: "2026-01-01", currency: "USD",
    inputPerMillionTokens: 3, outputPerMillionTokens: 15,
  }] };
  t.check("without one there is no ceiling at all",
    costCeiling(unpriceable, "anthropic", "reader", TOKENS_IN, TOKENS_OUT) === null
    && ceilingFor(unpriceable, "anthropic", "reader") === null);
  t.check("and the reason names the missing rate, in words, where a person will read it",
    ceilingRates(unpriceable.pricing[0]).problems.some((p) => /records no cache-write rate/.test(p)),
    ceilingRates(unpriceable.pricing[0]).problems.join("; ").slice(0, 110));
  t.check("assembling a runtime on it is refused before anything is built from it",
    configurationProblems(unpriceable).some((p) => /cache-write rate/.test(p)),
    configurationProblems(unpriceable).filter((p) => /cache-write/.test(p))[0] ?? "nothing was said");

  /* The component is real: a provider that reports it, under a price that
     does not name its rate, cannot be settled — which is why it may not be
     submitted for in the first place. */
  const wrote = {
    version: NORMALIZATION_VERSION, providerId: "anthropic",
    uncachedInputTokens: 0, cachedInputReadTokens: 0, cachedInputWriteTokens: 1000,
    visibleOutputTokens: 10, reasoningOutputTokens: 0, unpriced: {}, complete: true, problems: [],
  };
  const priced = priceUsage({ ...ratesOf(unpriceable), cacheWritePerMillionTokens: null }, wrote);
  t.check("a settlement of it is refused, which is the ledger's arithmetic and NOT a protection against the charge",
    priced.ok === false && /cache-write rate/.test(priced.problems.join(" ")), JSON.stringify(priced).slice(0, 110));
}

t.section("no ceiling, no key, no request: the refusal happens before any of them");
{
  const unpriceable = { ...configPriced(), pricing: [{
    providerId: "anthropic", model: "reader", effectiveFrom: "2026-01-01", currency: "USD",
    inputPerMillionTokens: 3, outputPerMillionTokens: 15,
  }] };
  /* Every gate open, and it still cannot be built: an authorisation that
     covers a model nothing can be reserved for authorises nothing. */
  const authorised = { ...unpriceable, authorization: {
    providerNetworkFlag: true, environmentGate: true, maximumAuthorizedCost: 5, currency: "USD",
    providerAllowlist: ["anthropic"], modelAllowlist: ["reader"],
  } };
  t.check("the authorisation covers no provider, because the only one it names cannot be bounded",
    authorizedProviders(authorised).length === 0);
  t.check("and the network authorisation refuses, naming the rate",
    networkAuthorizationProblems(authorised).some((p) => /cache-write rate/.test(p)),
    networkAuthorizationProblems(authorised).join("; ").slice(0, 110));
}

t.section("the hold can be reproduced from what was written down beside it");
{
  const config = configPriced({ cacheWritePerMillionTokens: 30, reasoningPerMillionTokens: 60 });
  const ceiling = ceilingFor(config, "anthropic", "reader");
  /* What the reservation stores, worked out here rather than read back. */
  const reproduced = round6(
    perMillion(ceiling.maximumInputTokens, ceiling.ceilingInputPerMillionTokens)
    + perMillion(ceiling.maximumOutputTokens, ceiling.ceilingOutputPerMillionTokens));
  t.check("the rates and the token ceilings give back the number that was held",
    reproduced === ceiling.maximumCost, `${reproduced} vs ${ceiling.maximumCost}`);
  t.check("and the rule that chose those rates is named, so a later reader knows which arithmetic to repeat",
    ceiling.rule === CEILING_RULE, ceiling.rule);
  t.check("while the rates a settlement uses are still the ordinary ones, kept separately",
    ceiling.basis.inputPerMillionTokens === 3 && ceiling.basis.outputPerMillionTokens === 15
    && ceiling.ceilingInputPerMillionTokens === 30 && ceiling.ceilingOutputPerMillionTokens === 60);
}

/* ══════════════ 6 · a record that cannot make the two one thing may not spend
   — proved through the REAL scheduler, so "before the key is read" is a fact
   about what ran rather than a claim about what would have.

   The in-memory record has no unit of work. It used to be handed the ledger's
   own connection, which would have written a hold it could not roll back —
   a hold outliving the refused submission it was taken for. It now refuses,
   and because the scheduler asks an executor only for an attempt whose
   submission succeeded, the executor is never reached: no key is read, no
   request is built, nothing is opened. */

t.section("a record with no unit of work refuses to spend, and the executor is never asked");
{
  const { syntheticRecordSet } = await import("../../core-v2/domains/synthetic-records/fixture.ts");
  const { SyntheticRecordsPack } = await import("../../core-v2/domains/synthetic-records/pack.ts");
  const { mockExecutors } = await import("../../core-v2/domains/synthetic-records/mocks.ts");
  const { assemble, manualClock } = await import("../../core-v2/domains/simulate.ts");
  const { InMemoryOrchestrationRepository } = await import("../../core-v2/kernel/memory-repository.ts");
  const { meteredRepository, NOT_ATOMIC } = await import("../budget/metered.ts");

  const truth = syntheticRecordSet({ seed: "no-transaction", sources: 1, sheetsPerSource: 1, entriesPerTable: 2 });
  const { registry } = mockExecutors(truth);

  /* A ledger that cannot be used without being noticed. If the refusal ever
     stops happening first, this throws rather than quietly writing a hold. */
  const reached = [];
  const ledgerThatMustNotBeReached = {
    reserve: async () => { reached.push("reserve"); throw new Error("the ledger was reached, which is the thing this section says cannot happen"); },
    budget: async () => null,
    reservationOf: async () => null,
    on() { return this; },
  };

  const repo = new InMemoryOrchestrationRepository();
  const money = [];
  const metered = meteredRepository(repo, {
    ledger: ledgerThatMustNotBeReached,
    config: configPriced({ cacheWritePerMillionTokens: 3 }),
    providerOfFamily: () => "anthropic",
    events: (event) => money.push(event),
  });

  const world = assemble({
    repo: metered, manifest: truth.manifest, pack: new SyntheticRecordsPack(),
    executors: registry, clock: manualClock(),
  });
  await world.scheduler.plan();
  for (let i = 0; i < 20; i += 1) {
    const report = await world.scheduler.tick();
    if (["needs_attention", "partial", "failed", "settled"].includes(report.workflowState)) break;
  }

  const attempts = [...repo.attempts.values()];
  const model = attempts.filter((a) => a.executorKind === "model");
  const modelTasks = new Set(model.map((a) => a.taskId));
  const askedOfModel = registry.packetsSeen.filter((p) => modelTasks.has(p.taskId));

  t.check("the run really did get as far as preparing model attempts, so this is not a test of nothing",
    model.length > 0, `${model.length} model attempts, ${attempts.length} attempts in all`);
  t.check("and not one of them was ever handed to an executor — the refusal came first",
    askedOfModel.length === 0, `${askedOfModel.length} packets reached a model executor`);
  t.check("so nothing that reads a key or opens a socket ever ran for them",
    askedOfModel.length === 0 && model.every((a) => a.state !== "submitted"),
    model.map((a) => a.state).join(", "));
  t.check("the ledger was never reached either: the refusal is decided before a hold is attempted",
    reached.length === 0 && money.every((e) => e.event !== "budget.reserved"), reached.join(", ") || "never reached");
  t.check("and every refusal says the same thing, in words an operator can act on",
    money.some((e) => e.event === "budget.refused")
    && money.filter((e) => e.event === "budget.refused").every((e) => e.reason === NOT_ATOMIC),
    JSON.stringify(money.filter((e) => e.event === "budget.refused").slice(0, 1)).slice(0, 130));
  t.check("work that costs nothing was unaffected — a record with no transaction is still a record",
    registry.packetsSeen.length > 0, `${registry.packetsSeen.length} packets ran in all`);
}

t.section("every door stayed closed");
t.check("nothing in this file tried the network", tripped() === 0, `${tripped()} attempts`);

t.finish();
