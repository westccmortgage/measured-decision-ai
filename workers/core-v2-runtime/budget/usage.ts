/* WHAT THE COUNTS MEAN, PROVIDER BY PROVIDER.
 *
 * Every provider reports how much a call used, and no two of them mean the
 * same thing by it. One counts cache reads separately from input; another
 * counts them inside it. One bills reasoning inside the output count;
 * another reports it beside it. A runtime that adds up whatever numbers it
 * finds — input plus cached plus output plus reasoning — charges twice for
 * the same tokens on two of the three, and there is no way to notice from
 * the total.
 *
 * So this file does two things and refuses to do a third:
 *
 *   1. it keeps the provider's own usage object exactly as it arrived,
 *      untouched, so an argument with an invoice is settled from what was
 *      actually said;
 *   2. it produces normalised billable components — uncached input, cache
 *      read, cache write, visible output, reasoning — under a version, so
 *      that what was priced is reconstructible later even if this file
 *      changes;
 *   3. it never invents a number. If a provider reported nothing usable, the
 *      answer is "unknown", and unknown is not zero. A run that settles an
 *      unknown at nothing has quietly decided that a call it cannot account
 *      for was free.
 *
 * The subset rules below are the whole substance of the file, and each one
 * is recorded beside the adapter that reads that provider's answer.
 */

export const NORMALIZATION_VERSION = "core-v2.usage.1";

export type BillableUsage = {
  version: string;
  providerId: string;
  /* Input tokens NOT served from a cache. */
  uncachedInputTokens: number;
  /* Input tokens served from a cache, and input tokens written to one. */
  cachedInputReadTokens: number;
  cachedInputWriteTokens: number;
  /* Output the caller can see, and output the model spent on its own
     reasoning. Never overlapping: whichever way a provider reports them, one
     of these is derived from the other so that their sum is the output once. */
  visibleOutputTokens: number;
  reasoningOutputTokens: number;
  /* Counts the provider reported that this normalisation does not price,
     kept by name rather than dropped. */
  unpriced: Record<string, number>;
  /* Whether these numbers are usable at all. False means the cost is not
     known — not that it is zero. */
  complete: boolean;
  problems: string[];
};

/* A number a provider reported, or nothing. A count that is not a
   non-negative finite number was not reported, whatever was in its place. */
export const reportedNumber = (value: unknown): number | null =>
  (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

export const reportedObject = (raw: Record<string, unknown>, key: string): Record<string, unknown> => {
  const value = raw[key];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
};

/* What a dialect returns when the counts are not usable. */
export function usageNotKnown(providerId: string, problems: string[]): BillableUsage {
  return {
    version: NORMALIZATION_VERSION, providerId,
    uncachedInputTokens: 0, cachedInputReadTokens: 0, cachedInputWriteTokens: 0,
    visibleOutputTokens: 0, reasoningOutputTokens: 0,
    unpriced: {}, complete: false, problems,
  };
}

/* One provider's rules for reading its own counts: what its numbers contain,
   and therefore what may be priced without counting anything twice. Written
   per provider, in providers/, which is the only place in this package where
   a provider may be named at all. */
export type UsageDialect = (raw: Record<string, unknown>) => BillableUsage;

/* What was used, in components that can be priced. A provider nobody has
   written the rules for is not guessed at, and neither is silence: both come
   back as "not known", which is not zero. */
export function normalizeWith(providerId: string, dialect: UsageDialect | undefined, raw: Record<string, unknown> | null | undefined): BillableUsage {
  if (!dialect) return usageNotKnown(providerId, [`nothing in this runtime knows how ${providerId} counts what it charges for`]);
  if (!raw || typeof raw !== "object" || Object.keys(raw).length === 0) {
    return usageNotKnown(providerId, ["the provider reported no usage at all, so what this attempt cost is not known"]);
  }
  return dialect(raw as Record<string, unknown>);
}

/* ─────────────────────────────────────────────────────────── the price */

/* Only the rates. Taken from what the reservation stored, never from the
   configuration as it stands now: a price that changed after a hold was
   taken does not change what that attempt cost. */
export type BillingRates = {
  currency: string;
  inputPerMillionTokens: number;
  outputPerMillionTokens: number;
  cachedInputPerMillionTokens: number | null;
  cacheWritePerMillionTokens: number | null;
  reasoningPerMillionTokens: number | null;
};

export type PricedUsage =
  | { ok: true; cost: number; notes: string[] }
  | { ok: false; problems: string[] };

const perMillion = (tokens: number, rate: number): number => (tokens / 1_000_000) * rate;
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

export function priceUsage(rates: BillingRates, usage: BillableUsage): PricedUsage {
  if (!usage.complete) return { ok: false, problems: usage.problems };
  const notes: string[] = [];

  let cost = perMillion(usage.uncachedInputTokens, rates.inputPerMillionTokens);
  cost += perMillion(usage.visibleOutputTokens, rates.outputPerMillionTokens);

  if (usage.cachedInputReadTokens > 0) {
    if (rates.cachedInputPerMillionTokens === null) {
      /* Priced at the full input rate rather than guessed at a discount. It
         cannot cost more than that, so the number stays an upper bound. */
      notes.push("no cached-input rate was recorded, so cache reads are priced at the full input rate — an upper bound, never an under-count");
      cost += perMillion(usage.cachedInputReadTokens, rates.inputPerMillionTokens);
    } else {
      cost += perMillion(usage.cachedInputReadTokens, rates.cachedInputPerMillionTokens);
    }
  }
  if (usage.cachedInputWriteTokens > 0) {
    if (rates.cacheWritePerMillionTokens === null) {
      /* A cache write can cost MORE than ordinary input, so there is no
         upper bound to fall back to. This one is refused. */
      return { ok: false, problems: [`${usage.cachedInputWriteTokens} tokens were written to a cache and the operator recorded no cache-write rate, so what this attempt cost cannot be worked out`] };
    }
    cost += perMillion(usage.cachedInputWriteTokens, rates.cacheWritePerMillionTokens);
  }
  if (usage.reasoningOutputTokens > 0) {
    /* Reasoning that is reported beside the output is billed as output
       unless the operator priced it separately. */
    const rate = rates.reasoningPerMillionTokens ?? rates.outputPerMillionTokens;
    if (rates.reasoningPerMillionTokens === null) notes.push("no reasoning rate was recorded, so reasoning tokens are priced as output");
    cost += perMillion(usage.reasoningOutputTokens, rate);
  }
  return { ok: true, cost: round6(cost), notes };
}

/* The components as they are written down beside a settlement. Flat, named,
   and carrying the version that produced them. */
export function billableRecord(usage: BillableUsage): Record<string, unknown> {
  return {
    normalization_version: usage.version,
    provider_id: usage.providerId,
    uncached_input_tokens: usage.uncachedInputTokens,
    cached_input_read_tokens: usage.cachedInputReadTokens,
    cached_input_write_tokens: usage.cachedInputWriteTokens,
    visible_output_tokens: usage.visibleOutputTokens,
    reasoning_output_tokens: usage.reasoningOutputTokens,
    unpriced: usage.unpriced,
    complete: usage.complete,
  };
}
