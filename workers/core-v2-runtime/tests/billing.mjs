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

t.section("every door stayed closed");
t.check("nothing in this file tried the network", tripped() === 0, `${tripped()} attempts`);

t.finish();
