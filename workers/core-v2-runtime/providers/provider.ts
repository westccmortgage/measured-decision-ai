/* THE PART OF TALKING TO A PROVIDER THAT IS NOT ABOUT ANY PROVIDER.
 *
 * Three things answer questions for money, and they disagree about almost
 * everything: what a request looks like, what a refusal looks like, what a
 * token is called, where the identifier of a call is written. What they do
 * not disagree about is the lifecycle, and the lifecycle is where the rules
 * that matter live:
 *
 *   · nothing is built before the four authorization gates are all open;
 *   · the model asked for comes from configuration, never from a default
 *     written into code, and it must be one the operator allowed;
 *   · the key is read from the environment the operator named, once, at the
 *     moment of the request, and it is never stored, logged or checked;
 *   · every request is fresh — one system instruction, one question, no
 *     history, no other reader's answer, no memory of the last call;
 *   · whatever comes back, the facts about it are reported: the identifier,
 *     the model that actually answered, the counts, the duration, the reason
 *     it stopped, and the answer exactly as it arrived — on the failure
 *     paths as much as on the good one;
 *   · a failure is a failure. It never becomes an empty success, and an
 *     attempt that may have reached the provider is never retried by machine.
 *
 * Everything a provider does differently is behind ProviderProtocol, which
 * the three files beside this one implement. This file names nobody.
 */
import type { AgentResultEnvelope, EnvelopeOutcome, ProviderFacts, WorkPacket } from "../../core-v2/kernel/contracts.ts";
import { PACKET_VERSION } from "../../core-v2/kernel/contracts.ts";
import type { AgentExecutor, ExecutionContext, ReconciliationOutcome } from "../../core-v2/kernel/executors.ts";
import type { ProviderConfiguration, RuntimeConfig } from "../runtime-config.ts";
import { configurationProblems, paidCallRefusals } from "../runtime-config.ts";
import type { HttpRequest, HttpResponse, HttpTransport } from "../transport/transport.ts";
import { NetworkNotAuthorized, failedBeforeSubmission } from "../transport/transport.ts";
import type { MaterialLimits, MaterialResolver, ResolvedMaterial } from "../material/material.ts";
import { verifyResolvedMaterial } from "../material/material.ts";

/* ─────────────────────────────────────────────── what somebody else writes */

/* The prompt compiler is injected. This file does not know how a packet
   becomes words, and must not: a compiler that leaked a peer's answer into
   the text would be a visibility bug, and it is caught where visibility is
   decided, not here. The signature is the whole contract. */
export type CompiledPrompt = { system: string; user: string };
export type PromptCompiler = (packet: WorkPacket) => CompiledPrompt;

/* ───────────────────────────────────────────────────────── the clock */

export type Clock = { now(): number; sleep(ms: number): Promise<void> };

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => { setTimeout(() => resolve(), ms); }),
};

/* ────────────────────────────────────── the shape every answer is asked for */

/* One JSON Schema, written once, in nobody's dialect. Each protocol wraps it
   in whatever its own strict-output mechanism is called. Only the parts of an
   envelope a model may produce are described: a model does not decide a task
   id, and it is never asked for one. */
/* WHETHER A SCHEMA CAN BE SENT STRICT, AND WHY IT MATTERS.
 *
 * "Strict" is the provider validating the arguments against the schema
 * rather than being asked nicely, and both providers that offer it require
 * the SAME thing to do it: every object in the schema closed with
 * `additionalProperties: false`. An open map — `additionalProperties` set to
 * a schema rather than to false — cannot be expressed under that rule.
 *
 * This envelope has two on purpose. A claim's `scope` and an anchor's
 * `locator` are domain vocabulary: a page and a row for one pack, a sheet
 * and a cell for another. Closing them would mean the kernel deciding what
 * a locator may say, which is the coupling the whole domain-pack split
 * exists to avoid.
 *
 * So the flag follows the schema instead of the schema following the flag.
 * The first paid canary sent strict over an open map and was rejected with
 * a 400 — after the reservation was taken. This is checked before the
 * request is built, and when it comes back false the answer is validated by
 * the engine's own result validator, which is where a claim's shape is
 * actually adjudicated anyway. */
export function schemaIsClosed(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return true;
  const node = schema as Record<string, unknown>;
  if (node.type === "object" && node.additionalProperties !== false) return false;
  for (const value of Object.values(node)) {
    if (value && typeof value === "object" && !schemaIsClosed(value)) return false;
  }
  return true;
}

/* AN OPEN MAP, SAID IN A CLOSED WAY.
 *
 * A claim's scope and an anchor's locator are the domain pack's vocabulary:
 * a page and a row for one pack, a sheet and a cell for another. The kernel
 * takes them as string maps and must keep doing so.
 *
 * But "strict" — the providers validating the answer against the schema
 * rather than asking nicely — requires every object closed, and an open map
 * cannot be closed. Sending the schema unstrict instead makes `required`
 * advisory, and a canary generation found out what that costs: the model
 * returned an envelope with no `outcome` at all, which is a whole paid
 * attempt thrown away over a field the provider would have insisted on.
 *
 * So the WIRE says the same thing in a shape that can be closed — a list of
 * key/value pairs — and the adapter turns it back into a map before anybody
 * downstream sees it. The kernel's contract does not change; only how it is
 * spelled to a provider does, which is what an adapter is for. */
const KEY_VALUE_PAIRS = {
  type: "array",
  description: "an open map, as pairs: [{key, value}, ...]",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["key", "value"],
    properties: { key: { type: "string" }, value: { type: "string" } },
  },
};

/* The other half: pairs back into the map the kernel reads. Tolerant on
   purpose — a provider that sent an object anyway is not an error, and text
   that is not an envelope at all (a spoken refusal) is passed through. */
function pairsToMap(value: unknown): unknown {
  if (!Array.isArray(value)) return value ?? {};
  const out: Record<string, string> = {};
  for (const pair of value) {
    if (pair && typeof pair === "object" && typeof (pair as { key?: unknown }).key === "string") {
      out[(pair as { key: string }).key] = String((pair as { value?: unknown }).value ?? "");
    }
  }
  return out;
}

/* What the rest of the runtime is handed: the envelope as text, with every
   open map spelled the way the kernel reads it. Accepts either a parsed
   object (a tool call's input) or the text a provider wrote. */
export function envelopeText(value: unknown): string | null {
  let envelope: unknown = value;
  if (typeof value === "string") {
    if (value.trim() === "") return null;
    try { envelope = JSON.parse(value); } catch { return value; }
  }
  if (!envelope || typeof envelope !== "object") return value === undefined ? null : JSON.stringify(envelope ?? null);
  const e = envelope as Record<string, unknown>;
  for (const claim of Array.isArray(e.claims) ? e.claims : []) {
    if (claim && typeof claim === "object") (claim as Record<string, unknown>).scope = pairsToMap((claim as Record<string, unknown>).scope);
  }
  for (const field of ["anchors", "segments"] as const) {
    for (const item of Array.isArray(e[field]) ? e[field] as unknown[] : []) {
      if (item && typeof item === "object") (item as Record<string, unknown>).locator = pairsToMap((item as Record<string, unknown>).locator);
    }
  }
  return JSON.stringify(envelope);
}

export const RESULT_ENVELOPE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "claims", "segments", "anchors", "assessments", "limitations"],
  properties: {
    outcome: { type: "string", enum: ["completed", "needs_follow_up", "insufficient_evidence", "failed_known", "outcome_unknown"] },
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claimKey", "subjectType", "subjectKey", "predicate", "value", "unit", "observationBasis", "scope", "anchorKeys"],
        properties: {
          claimKey: { type: "string" },
          subjectType: { type: "string" },
          subjectKey: { type: "string" },
          predicate: { type: "string" },
          value: {
            type: "object",
            additionalProperties: false,
            required: ["known", "quantity", "text"],
            properties: {
              known: { type: "boolean" },
              quantity: { type: ["number", "null"] },
              text: { type: ["string", "null"] },
            },
          },
          unit: { type: ["string", "null"] },
          observationBasis: { type: "string", enum: ["observed", "inferred"] },
          scope: KEY_VALUE_PAIRS,
          anchorKeys: { type: "array", items: { type: "string" } },
        },
      },
    },
    /* WHAT A DISCOVERER IS FOR, AND WHAT WAS MISSING FROM THIS ENVELOPE.

     *

     * A discoverer's whole job is to say which regions a sheet contains, and

     * until now this schema had nowhere to put them. Offline that never

     * showed, because the local stand-in returns a JavaScript object and

     * never passes through the schema at all. The first canary whose reader

     * actually answered found it in one move: Claude read the sheet

     * correctly, described both regions — a table and a note, with their

     * boxes, labels and ordinals — and had to put them in `anchors`,

     * because `segments` did not exist. Nothing could then expand on them,

     * and a workflow that should have gone on to two blind readers, a

     * comparison and a decision completed after two units.

     *

     * The field is the kernel's ProposedSegment, which is a

     * SegmentDescriptor plus the key the rest of the envelope refers to it

     * by. Required, like claims and anchors: a role that discovers nothing

     * returns an empty array and says so, rather than leaving the question

     * open. */

    segments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["segmentKey", "sourceId", "parentSegmentId", "segmentKind", "label", "ordinal", "locator", "contentHash"],
        properties: {
          segmentKey: { type: "string" },
          sourceId: { type: "string" },
          parentSegmentId: { type: ["string", "null"] },
          segmentKind: { type: "string" },
          label: { type: ["string", "null"] },
          ordinal: { type: "integer" },
          locator: KEY_VALUE_PAIRS,
          contentHash: { type: "string" },
        },
      },

    },
    anchors: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["anchorKey", "sourceKind", "sourceId", "segmentId", "locator", "quotedText"],
        properties: {
          anchorKey: { type: "string" },
          sourceKind: { type: "string", enum: ["segment_locator", "segment", "source"] },
          sourceId: { type: ["string", "null"] },
          segmentId: { type: ["string", "null"] },
          locator: KEY_VALUE_PAIRS,
          quotedText: { type: ["string", "null"] },
        },
      },
    },
    assessments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["claimRef", "assessment", "reasonCode", "explanation", "anchorKeys"],
        properties: {
          claimRef: { type: "string" },
          assessment: { type: "string", enum: ["supports", "contradicts", "insufficient", "wrong_scope", "wrong_unit", "duplicate", "unreadable"] },
          reasonCode: { type: "string" },
          explanation: { type: "string" },
          anchorKeys: { type: "array", items: { type: "string" } },
        },
      },
    },
    limitations: { type: "array", items: { type: "string" } },
  },
};

export const RESULT_ENVELOPE_SCHEMA_NAME = "result_envelope";
export const RESULT_ENVELOPE_SCHEMA_DESCRIPTION =
  "The only way to answer. Every claim names anchors this same answer carries; a value that could not be read is known:false with a null quantity and a null text.";

/* ──────────────────────────────────────────── what a provider must supply */

/* Everything the skeleton hands a protocol so it can write one request. No
   secret is held anywhere else, and the plan is not kept after the request
   is built. */
export type ProviderRequestPlan = {
  configuration: ProviderConfiguration;
  model: string;
  maximumOutputTokens: number;
  prompt: CompiledPrompt;
  /* The bytes this assignment authorises, already resolved and already
     checked: the hash recomputed, the locator the packet's own, nothing
     extra and nothing missing. A protocol puts these on the wire in its own
     multimodal shape; it does not decide what they are. */
  material: ResolvedMaterial[];
  /* The role's own words for what it must return, carried through so the
     provider's instruction says the same thing the kernel will check. */
  expectedOutputContract: string;
  apiKey: string;
  timeoutMs: number;
  signal: AbortSignal;
};

/* What the skeleton needs to know about an answer, whoever gave it. Every
   field is what the provider actually said, never a guess: a provider that
   reports no identifier reports null, and null is what is written down. */
export type ParsedAnswer = {
  /* The structured answer as text, ready to be read as JSON. Null when the
     provider produced no answer text at all. */
  text: string | null;
  requestId: string | null;
  modelReported: string | null;
  /* THE PROVIDER'S OWN USAGE OBJECT, VERBATIM. Not normalised, not renamed,
     not filled in: what arrives is what is written down, and what it means
     is decided later, per provider, by budget/usage.ts. A runtime that
     normalised here would have thrown away the only record of what was
     actually said. Empty when the provider reported nothing. */
  rawUsage: Record<string, unknown>;
  stopReason: string | null;
  /* The provider's own words when it declined. Null when it did not. */
  refusal: string | null;
  /* True when the answer stopped because it hit the output ceiling. */
  incomplete: boolean;
};

export interface ProviderProtocol {
  readonly providerId: string;
  /* The path this protocol appends to the operator's baseUrl. Declared
     rather than hidden inside buildRequest, because an operator who writes
     the version segment into their baseUrl as well gets it twice — and a
     doubled path is a 404 that looks exactly like a wrong model id. */
  readonly requestPath: string;
  buildRequest(plan: ProviderRequestPlan): HttpRequest;
  parse(response: HttpResponse): ParsedAnswer;
  /* What this provider cannot be asked for in this configuration — a model
     that cannot combine the output mode, the tool choice and the thinking
     mode the request would use, a media type it will not take. Returned as
     sentences, refused before submission. Silence means nothing is wrong,
     never that nothing was checked. */
  configurationProblems?(configuration: ProviderConfiguration, model: string, material: ResolvedMaterial[]): string[];
}

/* ───────────────────────────────────────────────────────── retrying */

/* The only retry this layer performs, and the only status it performs it
   for. A rate limit is the one answer that says, in the provider's own
   words, that it did not accept the request — so it is the one answer where
   sending again cannot double anything. Everything else is either a
   permanent no or an unknown, and an unknown is never retried by machine.
   maximumAttempts counts sends, not retries: two means at most two requests
   ever leave for one attempt. */
export type RetryPolicy = { maximumAttempts: number; backoffMs: number };

export const BOUNDED_RETRY: RetryPolicy = { maximumAttempts: 2, backoffMs: 0 };

/* ─────────────────────────────────────────────── how a failure is written */

/* An envelope has no field for an error code, so the code is the first
   limitation and is written in one recognisable shape. failureCode() reads
   it back, which is how a dispatcher or a test asks "why" without matching
   prose. */
/* Every code this executor can end an attempt with. The set is closed so
   that reading a code back is exact rather than a guess about prose. */
export const FAILURE_CODES = new Set<string>([
  "provider_misconfigured", "paid_call_not_authorized", "provider_key_absent", "cancelled_before_submission",
  "material_not_resolved", "material_refused",
  "prompt_not_compiled", "request_not_built", "network_not_authorized", "provider_unauthorized",
  "provider_rate_limited", "provider_rejected_request", "response_not_understood", "provider_refused",
  "output_ceiling_reached", "empty_answer", "answer_not_json", "answer_not_an_envelope", "answer_without_outcome",
  "transport_fault", "provider_server_error",
]);

/* The code comes first, then the sentence: `<code>: what happened`. The
   kernel files a failed attempt under the first word of its reason, so
   writing the code there is what puts a machine-readable cause on the
   attempt row instead of the name of this package. */
export function failureCode(envelope: AgentResultEnvelope): string | null {
  const first = envelope.limitations[0];
  if (typeof first !== "string") return null;
  const code = first.split(":")[0].trim();
  return FAILURE_CODES.has(code) ? code : null;
}

function answerless(packet: WorkPacket, outcome: EnvelopeOutcome, code: string, reasons: string[], rawResponseReference: string | null = null): AgentResultEnvelope {
  return {
    packetVersion: PACKET_VERSION,
    taskId: packet.taskId,
    roleKey: packet.roleKey,
    roleVersion: packet.roleVersion,
    outcome,
    claims: [], anchors: [], segments: [], assessments: [], disagreements: [], requestedActions: [],
    limitations: [`${code}: ${reasons[0] ?? "no further detail"}`, ...reasons.slice(1)],
    rawResponseReference,
    adjudication: null,
    decisions: [], calculations: [],
  };
}

/* The answer exactly as it arrived, before anything read it. Kept with its
   status and headers because a body alone cannot be told from a body that
   came with a 500. */
export type RawProviderResponse = { status: number; headers: Record<string, string>; body: string };

function verbatim(response: HttpResponse): RawProviderResponse {
  return { status: response.status, headers: { ...response.headers }, body: response.body };
}

const OUTCOMES = new Set<string>(["completed", "needs_follow_up", "insufficient_evidence", "failed_known", "outcome_unknown"]);

/* ─────────────────────────────────────────────────────── the executor */

export type ProviderExecutorOptions = {
  configuration: ProviderConfiguration;
  runtime: RuntimeConfig;
  transport: HttpTransport;
  protocol: ProviderProtocol;
  compilePrompt: PromptCompiler;
  /* Where the bytes come from. Required: an executor that cannot resolve
     material cannot show a model anything, and one that quietly sent
     identities instead would look like it was working. */
  materialResolver: MaterialResolver;
  /* The families this one instance serves. One instance is one independence
     domain, so every family listed here is the same opinion — which is the
     point, and why the registry builds exactly one instance per provider. */
  families?: string[];
  /* Which of the provider's configured models to ask. Defaults to the one
     the operator set as this provider's default; there is no default in code. */
  model?: string;
  clock?: Clock;
  retry?: RetryPolicy;
  /* Where the key named in configuration is looked up. Injected so a test
     never touches the process environment. */
  environment?: Record<string, string | undefined>;
};

export class ProviderExecutor implements AgentExecutor {
  readonly family: string;
  readonly families: string[];
  readonly providerId: string;
  readonly model: string;
  private configuration: ProviderConfiguration;
  private runtime: RuntimeConfig;
  private transport: HttpTransport;
  private protocol: ProviderProtocol;
  private compilePrompt: PromptCompiler;
  private materialResolver: MaterialResolver;
  private clock: Clock;
  private retry: RetryPolicy;
  private environment: Record<string, string | undefined>;

  constructor(options: ProviderExecutorOptions) {
    this.configuration = options.configuration;
    this.runtime = options.runtime;
    this.transport = options.transport;
    this.protocol = options.protocol;
    this.compilePrompt = options.compilePrompt;
    this.materialResolver = options.materialResolver;
    this.clock = options.clock ?? systemClock;
    this.retry = options.retry ?? BOUNDED_RETRY;
    this.environment = options.environment ?? process.env;
    this.providerId = options.configuration.providerId;
    this.model = options.model ?? options.configuration.defaultModel;
    this.families = options.families && options.families.length ? [...options.families] : [options.configuration.providerId];
    this.family = this.families[0];
    if (options.protocol.providerId !== options.configuration.providerId) {
      throw new Error(`core-v2-runtime: a ${options.protocol.providerId} protocol was given a ${options.configuration.providerId} configuration`);
    }
  }

  async execute(packet: WorkPacket, context: ExecutionContext): Promise<AgentResultEnvelope> {
    const started = this.clock.now();
    const since = () => this.clock.now() - started;
    const refuse = (code: string, reasons: string[], outcome: EnvelopeOutcome = "failed_known"): AgentResultEnvelope => {
      context.report({ durationMs: since() });
      return answerless(packet, outcome, code, reasons);
    };

    /* 1. A run that would refuse at submission refuses at assembly. */
    const problems = configurationProblems(this.runtime).filter((p) => p.includes(this.providerId));
    if (!this.configuration.models.includes(this.model)) {
      problems.push(`${this.providerId} would be asked for ${this.model}, which is not on its own list of models`);
    }
    if (problems.length) return refuse("provider_misconfigured", problems);

    /* 2. Four gates, all of them, before a request exists at all. */
    const refusals = paidCallRefusals(this.runtime, this.providerId, this.model);
    if (refusals.length) return refuse("paid_call_not_authorized", refusals);

    /* 3. A deadline that passed before anything was sent is a known failure,
          not an unknown one: nothing left this process. */
    if (context.signal.aborted) {
      return refuse("cancelled_before_submission", ["the deadline for this attempt passed before anything was sent"]);
    }

    /* 4. The bytes. The packet says what may be read; the resolver turns
          that into material; and what comes back is checked against what was
          asked for before anything else happens. A resolver that adds a
          source, returns the wrong one, hands back something that does not
          hash to what the assignment names, or is silent about a segment the
          assignment requires, stops the attempt here. */
    let material: ResolvedMaterial[] = [];
    if (packet.sources.length > 0) {
      let resolved: ResolvedMaterial[];
      try {
        resolved = await this.materialResolver.resolve(packet.sources);
      } catch (error) {
        return refuse("material_not_resolved", [`the material this assignment authorises could not be fetched: ${messageOf(error)}`]);
      }
      const verdict = verifyResolvedMaterial(packet.sources, resolved, this.materialLimits(packet.limits.maximumSources));
      if (!verdict.ok) return refuse("material_refused", verdict.problems);
      material = verdict.material;
    }

    /* 5. What this provider cannot be asked for in this configuration. Asked
          after the material exists, because some of it is about the material. */
    if (this.protocol.configurationProblems) {
      const cannot = this.protocol.configurationProblems(this.configuration, this.model, material);
      if (cannot.length) return refuse("provider_misconfigured", cannot);
    }

    /* 6. The words, from somebody else's compiler. */
    let prompt: CompiledPrompt;
    try {
      prompt = this.compilePrompt(packet);
    } catch (error) {
      return refuse("prompt_not_compiled", [`the packet could not be turned into a question: ${messageOf(error)}`]);
    }
    if (!prompt || typeof prompt.system !== "string" || typeof prompt.user !== "string" || prompt.user.length === 0) {
      return refuse("prompt_not_compiled", ["the compiler returned no question to ask"]);
    }

    /* 7. THE LAST THING BEFORE THE REQUEST IS BUILT is the key. Every check
          that can be made without a secret has been made by now — the
          configuration, the four gates, the deadline, the material, the
          provider's own capabilities, the words. A run that is going to
          refuse has already refused, and a key is read only for a request
          that is otherwise ready to send. It is not stored on this object,
          not measured, not checked against anything, and not written
          anywhere but the one header. */
    const apiKey = this.environment[this.configuration.apiKeyEnvironmentVariable];
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      return refuse("provider_key_absent", [`the environment variable configuration names for ${this.providerId} holds nothing`]);
    }

    /* 8. The one provider-specific thing that happens before the wire. */
    let request: HttpRequest;
    try {
      request = this.protocol.buildRequest({
        configuration: this.configuration,
        model: this.model,
        maximumOutputTokens: this.configuration.maximumOutputTokens,
        prompt,
        material,
        expectedOutputContract: packet.expectedOutputContract,
        apiKey,
        timeoutMs: this.configuration.requestTimeoutMs,
        signal: context.signal,
      });
    } catch (error) {
      return refuse("request_not_built", [`the request could not be built: ${messageOf(error)}`]);
    }

    /* 9. The wire. Every send is the same request: nothing accumulates
          between one send and the next, and nothing accumulates between one
          attempt and the next, because this object keeps nothing. */
    let response: HttpResponse | null = null;
    let sends = 0;
    for (;;) {
      sends++;
      try {
        response = await this.transport.send(request);
      } catch (error) {
        const durationMs = since();
        if (error instanceof NetworkNotAuthorized) {
          /* Not a failure of the thing on the other side: the door was never
             opened, so nothing was sent and nothing may have happened. */
          context.report({ durationMs, stopReason: "network_not_authorized" });
          return answerless(packet, "failed_known", "network_not_authorized", [messageOf(error), ...error.refusals]);
        }
        if (beforeSubmission(error)) {
          context.report({ durationMs, stopReason: "aborted_before_submission" });
          return answerless(packet, "failed_known", "cancelled_before_submission", [`nothing was sent: ${messageOf(error)}`]);
        }
        /* The request left, and what became of it is not known. It is not
           retried, and it is not called a failure. */
        context.report({ durationMs, stopReason: "transport_fault" });
        return answerless(packet, "outcome_unknown", "transport_fault", [
          `the request was sent and no answer came back: ${messageOf(error)}`,
          "whether the provider did the work is not known, so this attempt is not repeated by machine",
        ]);
      }

      if (response.status === 429 && sends < this.retry.maximumAttempts && !context.signal.aborted) {
        /* The only retry there is: the provider said it did not take it. */
        await this.clock.sleep(this.retry.backoffMs);
        continue;
      }
      break;
    }

    const durationMs = since();
    const raw = verbatim(response);
    const requestId = headerRequestId(response);
    const reportHttp = (stopReason: string) => {
      context.report({ requestId, durationMs, stopReason, response: raw });
    };

    /* 10. What the status alone already settles. */
    if (response.status === 401 || response.status === 403) {
      reportHttp(`http_${response.status}`);
      return answerless(packet, "failed_known", "provider_unauthorized", [
        `the provider refused the credential with ${response.status}`,
        "a refused credential does not become acceptable by asking again, so this is not retried",
      ], requestId);
    }
    if (response.status === 429) {
      reportHttp("http_429");
      return answerless(packet, "failed_known", "provider_rate_limited", [
        `the provider declined to take the request ${sends} time${sends === 1 ? "" : "s"} and said so with 429`,
        `the policy allows at most ${this.retry.maximumAttempts} send${this.retry.maximumAttempts === 1 ? "" : "s"} for one attempt, and they are used`,
        "a rate limit is the one answer that says the request was not accepted, which is why sending again was allowed at all",
      ], requestId);
    }
    if (response.status >= 500) {
      reportHttp(`http_${response.status}`);
      return answerless(packet, "outcome_unknown", "provider_server_error", [
        `the provider answered ${response.status}, which does not say whether it did the work`,
        "an attempt that may have reached the provider is never repeated by machine",
      ], requestId);
    }
    if (response.status < 200 || response.status >= 300) {
      reportHttp(`http_${response.status}`);
      return answerless(packet, "failed_known", "provider_rejected_request", [
        `the provider rejected the request with ${response.status}`,
        "a request the provider will not accept is not made acceptable by repetition",
      ], requestId);
    }

    /* 11. The provider-specific reading of a good status. */
    let parsed: ParsedAnswer;
    try {
      parsed = this.protocol.parse(response);
    } catch (error) {
      reportHttp("unreadable_response");
      return answerless(packet, "failed_known", "response_not_understood", [
        `the answer did not have the shape this provider's answers have: ${messageOf(error)}`,
        "the answer is kept exactly as it arrived",
      ], requestId);
    }

    /* Everything learned, in one report, before anything is decided about it. */
    const facts: ProviderFacts = {
      requestId: parsed.requestId ?? requestId,
      modelReported: parsed.modelReported,
      usage: parsed.rawUsage,
      durationMs,
      stopReason: parsed.stopReason,
      response: raw,
    };
    context.report(facts);
    const reference = parsed.requestId ?? requestId;

    /* 12. A refusal is preserved and invents nothing. */
    if (parsed.refusal !== null) {
      return answerless(packet, "failed_known", "provider_refused", [
        "the provider declined to answer, and what it declined with is kept as it said it",
        parsed.refusal,
      ], reference);
    }

    /* 13. A ceiling keeps the part that was written and the counts it cost. */
    if (parsed.incomplete) {
      const partial = typeof parsed.text === "string" ? parsed.text : "";
      return answerless(packet, "failed_known", "output_ceiling_reached", [
        `the answer stopped at the output ceiling of ${this.configuration.maximumOutputTokens} tokens and is incomplete`,
        `the part that was written is kept: ${partial}`,
        "an incomplete answer is not read as an answer — a truncated list of claims is not a shorter list of claims",
      ], reference);
    }

    if (typeof parsed.text !== "string" || parsed.text.trim().length === 0) {
      return answerless(packet, "failed_known", "empty_answer", [
        "the provider answered with no answer at all",
        "an absent answer is a failure, never a result with nothing in it",
      ], reference);
    }

    /* 14. The strict shape that was asked for, read back. */
    let body: unknown;
    try {
      body = JSON.parse(parsed.text);
    } catch (error) {
      return answerless(packet, "failed_known", "answer_not_json", [
        `the strict shape that was asked for did not come back as one: ${messageOf(error)}`,
        "the answer is kept exactly as it arrived, so the parse can be argued with later",
      ], reference);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return answerless(packet, "failed_known", "answer_not_an_envelope", [
        "the answer was valid JSON but not an object, so it is not an envelope",
      ], reference);
    }

    const supplied = body as Record<string, unknown>;
    if (typeof supplied.outcome !== "string" || !OUTCOMES.has(supplied.outcome)) {
      return answerless(packet, "failed_known", "answer_without_outcome", [
        `the answer does not say how it ended: ${JSON.stringify(supplied.outcome ?? null)}`,
        "an answer that does not say whether it finished is not read as one that did",
      ], reference);
    }

    /* Parsing, not validating: the identity fields are filled in only where
       the answer left them out, so an answer to the wrong task still says so
       and the kernel still catches it. */
    return {
      packetVersion: typeof supplied.packetVersion === "string" ? supplied.packetVersion : PACKET_VERSION,
      taskId: typeof supplied.taskId === "string" ? supplied.taskId : packet.taskId,
      roleKey: typeof supplied.roleKey === "string" ? supplied.roleKey : packet.roleKey,
      roleVersion: typeof supplied.roleVersion === "string" ? supplied.roleVersion : packet.roleVersion,
      outcome: supplied.outcome as EnvelopeOutcome,
      claims: list(supplied.claims),
      anchors: list(supplied.anchors),
      segments: list(supplied.segments),
      assessments: list(supplied.assessments),
      disagreements: list(supplied.disagreements),
      requestedActions: list(supplied.requestedActions),
      limitations: list<string>(supplied.limitations),
      rawResponseReference: typeof supplied.rawResponseReference === "string" ? supplied.rawResponseReference : reference,
      adjudication: (supplied.adjudication ?? null) as AgentResultEnvelope["adjudication"],
      decisions: list(supplied.decisions),
      calculations: list(supplied.calculations),
    };
  }

  /* What this provider and this assignment will carry between them. The
     packet's own ceiling on how many pieces of material there may be, and the
     configuration's ceilings on size and type. */
  private materialLimits(maximumSources: number): MaterialLimits {
    return {
      maximumItems: maximumSources,
      maximumBytesPerItem: this.configuration.maximumMaterialBytesPerItem,
      maximumBytesTotal: this.configuration.maximumMaterialBytes,
      allowedMimeTypes: this.configuration.supportedMediaTypes,
    };
  }

  /* An adapter cannot say what became of a request it never saw the end of.
     Saying "unknown" is the honest answer and the only one it has; the
     kernel keeps such an attempt unknown rather than repeating it. */
  async reconcile(_attemptId: string): Promise<ReconciliationOutcome> {
    return "unknown";
  }
}

/* ─────────────────────────────────────────────────────────── helpers */

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* Whether a transport fault happened before anything could have reached the
   provider. Only a transport that says so is believed; silence means the
   request may have arrived, and that is the conservative reading. */
function beforeSubmission(error: unknown): boolean {
  if (failedBeforeSubmission(error)) return true;
  if (error && typeof error === "object" && (error as { beforeSubmission?: unknown }).beforeSubmission === true) return true;
  return /before it was sent/i.test(messageOf(error));
}

/* The two header names providers write a call identifier under. Kept here
   rather than in each protocol because it is the same header everywhere it
   exists, and a protocol that has its own says so in its own file. */
export function headerRequestId(response: HttpResponse): string | null {
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    const lower = name.toLowerCase();
    if (lower === "request-id" || lower === "x-request-id") return value;
  }
  return null;
}

/* Counts, under the four names the pricing table settles against, and only
   the ones that were actually supplied. A count nobody reported is absent,
   never zero: zero is a measurement. */
/* The provider's usage object, kept exactly as it arrived. Not renamed, not
   summed, not filled in: an object that is not an object is an empty one,
   and that is the only judgement made here. What the numbers MEAN is a
   provider-specific question, and it is answered in budget/usage.ts, where
   it can be argued with. */
export function rawUsageOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

/* The line that goes before a piece of material in a request: what it is,
   where it came from, and the hash of it. Identities only — the address it
   was stored under is not in the ResolvedMaterial at all, so it cannot be
   here either. The reader needs this to anchor a claim to a segment id, and
   the segment id is exactly what it is allowed to know. */
export function materialHeading(item: ResolvedMaterial): string {
  const where = item.segmentId ? `segmentId ${item.segmentId} of sourceId ${item.sourceId}` : `sourceId ${item.sourceId}`;
  const range = item.timeRange ? `, seconds ${item.timeRange.startSeconds}\u2013${item.timeRange.endSeconds}` : "";
  return `--- material for ${where} (${item.mediaKind}, ${item.mimeType}, ${item.byteLength} bytes, sha-256 ${item.contentHash}${range}) ---`;
}

/* The same line, read back. Whatever is downstream of a request — a test, a
   stand-in — pairs a heading with the thing that follows it, and does so
   from the one place the format is written down. */
export function parseMaterialHeading(text: string): { sourceId: string; segmentId: string | null; mediaKind: string; mimeType: string; byteLength: number; contentHash: string } | null {
  const m = text.match(/^--- material for (?:segmentId (\S+) of sourceId (\S+)|sourceId (\S+)) \(([a-z_]+), ([^,]+), (\d+) bytes, sha-256 ([0-9a-f]{64})(?:, seconds [^)]*)?\) ---$/);
  if (!m) return null;
  return {
    segmentId: m[1] ?? null,
    sourceId: m[2] ?? m[3],
    mediaKind: m[4],
    mimeType: m[5],
    byteLength: Number(m[6]),
    contentHash: m[7],
  };
}

export function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

export function parseJsonBody(response: HttpResponse): Record<string, unknown> {
  const parsed: unknown = JSON.parse(response.body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("the body was not a JSON object");
  }
  return parsed as Record<string, unknown>;
}
