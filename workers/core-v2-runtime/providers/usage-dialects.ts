/* HOW EACH PROVIDER COUNTS WHAT IT CHARGES FOR.
 *
 * The arithmetic of a bill is universal and lives in budget/usage.ts. What is
 * NOT universal is what a provider's own numbers contain: whether its cache
 * figures sit inside its input count or beside it, whether its reasoning is
 * already part of its output. Getting that wrong is not a rounding error —
 * it is charging twice for the same tokens, on two of these three.
 *
 * So the rules live here, in the one directory of this package where a
 * provider may be named, one function each, each with the containment rule
 * it encodes written next to it. Each is recorded again in the protocol note
 * of the adapter that reads that provider's answers, and each is on the list
 * of things a paid canary must confirm against a real invoice.
 */
import type { BillableUsage, UsageDialect } from "../budget/usage.ts";
import { NORMALIZATION_VERSION, normalizeWith, reportedNumber, reportedObject, usageNotKnown } from "../budget/usage.ts";
import { ANTHROPIC_PROVIDER_ID } from "./anthropic.ts";
import { GOOGLE_PROVIDER_ID } from "./google.ts";
import { OPENAI_PROVIDER_ID } from "./openai.ts";

/* ─────────────────────────────────────────────────── the three dialects */

/* ANTHROPIC — input_tokens EXCLUDES both cache figures, and thinking is
   billed inside output_tokens. There is nothing to subtract and nothing
   separate to add: the two cache counts are their own components, and there
   is no reasoning component at all. */
export function normalizeAnthropic(raw: Record<string, unknown>): BillableUsage {
  const input = reportedNumber(raw.input_tokens);
  const output = reportedNumber(raw.output_tokens);
  const problems: string[] = [];
  if (input === null) problems.push("the provider reported no input token count");
  if (output === null) problems.push("the provider reported no output token count");
  if (problems.length) return usageNotKnown(ANTHROPIC_PROVIDER_ID, problems);
  return {
    version: NORMALIZATION_VERSION, providerId: ANTHROPIC_PROVIDER_ID,
    uncachedInputTokens: input!,
    cachedInputReadTokens: reportedNumber(raw.cache_read_input_tokens) ?? 0,
    cachedInputWriteTokens: reportedNumber(raw.cache_creation_input_tokens) ?? 0,
    visibleOutputTokens: output!,
    /* Thinking is inside output_tokens here. Reporting it again would be the
       double count this whole file exists to prevent. */
    reasoningOutputTokens: 0,
    unpriced: {}, complete: true, problems: [],
  };
}

/* OPENAI — input_tokens INCLUDES input_tokens_details.cached_tokens, and
   output_tokens INCLUDES output_tokens_details.reasoning_tokens. Both
   subsets are subtracted before anything is priced. */
export function normalizeOpenAi(raw: Record<string, unknown>): BillableUsage {
  const input = reportedNumber(raw.input_tokens);
  const output = reportedNumber(raw.output_tokens);
  const cached = reportedNumber(reportedObject(raw, "input_tokens_details").cached_tokens) ?? 0;
  const reasoning = reportedNumber(reportedObject(raw, "output_tokens_details").reasoning_tokens) ?? 0;
  const problems: string[] = [];
  if (input === null) problems.push("the provider reported no input token count");
  if (output === null) problems.push("the provider reported no output token count");
  if (input !== null && cached > input) problems.push(`the provider reported ${cached} cached input tokens inside ${input} input tokens, which cannot be`);
  if (output !== null && reasoning > output) problems.push(`the provider reported ${reasoning} reasoning tokens inside ${output} output tokens, which cannot be`);
  if (problems.length) return usageNotKnown(OPENAI_PROVIDER_ID, problems);
  return {
    version: NORMALIZATION_VERSION, providerId: OPENAI_PROVIDER_ID,
    uncachedInputTokens: input! - cached,
    cachedInputReadTokens: cached,
    /* This provider does not report a cache write separately. */
    cachedInputWriteTokens: 0,
    visibleOutputTokens: output! - reasoning,
    reasoningOutputTokens: reasoning,
    unpriced: {}, complete: true, problems: [],
  };
}

/* GOOGLE — promptTokenCount INCLUDES cachedContentTokenCount, and
   thoughtsTokenCount is reported BESIDE candidatesTokenCount rather than
   inside it. So the cache is subtracted and the thoughts are not. */
export function normalizeGoogle(raw: Record<string, unknown>): BillableUsage {
  const prompt = reportedNumber(raw.promptTokenCount);
  const candidates = reportedNumber(raw.candidatesTokenCount);
  const cached = reportedNumber(raw.cachedContentTokenCount) ?? 0;
  const thoughts = reportedNumber(raw.thoughtsTokenCount) ?? 0;
  const problems: string[] = [];
  if (prompt === null) problems.push("the provider reported no prompt token count");
  if (candidates === null) problems.push("the provider reported no candidate token count");
  if (prompt !== null && cached > prompt) problems.push(`the provider reported ${cached} cached tokens inside ${prompt} prompt tokens, which cannot be`);
  if (problems.length) return usageNotKnown(GOOGLE_PROVIDER_ID, problems);
  return {
    version: NORMALIZATION_VERSION, providerId: GOOGLE_PROVIDER_ID,
    uncachedInputTokens: prompt! - cached,
    cachedInputReadTokens: cached,
    cachedInputWriteTokens: 0,
    visibleOutputTokens: candidates!,
    reasoningOutputTokens: thoughts,
    unpriced: {}, complete: true, problems: [],
  };
}

export const USAGE_DIALECTS: Record<string, UsageDialect> = {
  [ANTHROPIC_PROVIDER_ID]: normalizeAnthropic,
  [OPENAI_PROVIDER_ID]: normalizeOpenAi,
  [GOOGLE_PROVIDER_ID]: normalizeGoogle,
};

export function knownBillingDialects(): string[] {
  return Object.keys(USAGE_DIALECTS);
}

/* The one call the rest of the runtime makes. */
export function normalizeUsage(providerId: string, raw: Record<string, unknown> | null | undefined): BillableUsage {
  return normalizeWith(providerId, USAGE_DIALECTS[providerId], raw);
}
