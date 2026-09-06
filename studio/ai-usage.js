/* AI COST GUARD — the browser's half.
 *
 * The guard that actually stops a second payment is a unique index in the
 * database. This file is the part a person sees and touches, and it is
 * deliberately thin, because a browser cannot be the guard: it cannot see a
 * second tab, a colleague on the same project, or a click that lands before
 * the first render.
 *
 * So there is no fingerprint recipe in here. Duplicating the server's hashing
 * in a second language would drift, and a drifted fingerprint says
 * "up to date" about a reading that was never bought. The browser asks, the
 * server answers, and the answer is the truth.
 */
(function aiUsageModule() {
  const NOT_PRICED = "Cost unavailable";

  /* In-flight presses, by whatever key the caller considers one action. A
     double click is two presses of the same key microseconds apart, and this
     is what makes the second one free — not a substitute for the database
     guard behind it, a courtesy in front of it. */
  const inFlight = new Set();

  async function once(key, run) {
    if (inFlight.has(key)) return { skipped: "in_flight" };
    inFlight.add(key);
    try {
      return await run();
    } finally {
      inFlight.delete(key);
    }
  }

  function isBusy(key) {
    return inFlight.has(key);
  }

  /* What the ledger says about this project, in one line.
   *
   * Money appears only when every counted run carries a cost from a named
   * price list. With no price list configured that is never, and the line
   * says so rather than multiplying tokens by a number somebody remembered. */
  async function usageLine(client, propertyId) {
    if (!client || !propertyId) return null;
    const { data, error } = await client.rpc("ai_usage_summary", { p_property_id: propertyId });
    if (error) return null;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || !Number(row.runs)) return null;
    const runs = Number(row.runs) || 0;
    const tokens = Number(row.total_tokens) || 0;
    const missing = Number(row.usage_missing) || 0;
    const cost = row.estimated_cost_micros === null || row.estimated_cost_micros === undefined
      ? NOT_PRICED
      : `Estimated $${(Number(row.estimated_cost_micros) / 1e6).toFixed(2)}`;
    const tokenText = tokens
      ? `${tokens.toLocaleString("en-US")} tokens`
      : "tokens unavailable";
    const note = missing ? ` · ${missing} run${missing === 1 ? "" : "s"} reported no usage` : "";
    /* A run whose outcome nobody could establish may be on the invoice. Saying
       so is the difference between a ledger and a comforting number. */
    const unknown = Number(row.outcome_unknown) || 0;
    const unknownNote = unknown
      ? ` · ${unknown} run${unknown === 1 ? "" : "s"} with an unknown outcome, possibly billed`
      : "";
    return `AI usage: ${runs} run${runs === 1 ? "" : "s"} · ${tokenText} · ${cost}${note}${unknownNote}`;
  }

  function renderUsage(node, text) {
    if (!node) return;
    node.textContent = text || "";
    node.hidden = !text;
  }

  /* The one sentence a person must read before money is spent again.
     Deliberately blunt about credits: an "are you sure?" that does not say
     what it costs is not a confirmation. */
  const REANALYZE_WARNING = "This will run AI again and may use additional credits.";

  function confirmReanalyze(ask) {
    const prompt = typeof ask === "function" ? ask : window.confirm.bind(window);
    return Boolean(prompt(REANALYZE_WARNING));
  }

  /* The other sentence, for the harder case: a request that went out and whose
     answer never came back. The provider may have done the work and billed it.
     "May" is the honest word — anything more definite would be invented, and
     anything vaguer would hide a cost from the person paying it. */
  const UNKNOWN_OUTCOME_WARNING =
    "The previous request may have run and been billed. Run the analysis again, with possible additional charges?";

  /* Authorise exactly one retry of a run whose outcome is unknown.
   *
   * The authorisation lives in the database and is consumed by the claim that
   * spends it, so this cannot be the guard — it is the question in front of
   * it. Pressing twice sets a flag that is already set; two tabs racing to
   * spend it produce one run between them, because only one claim can take it. */
  async function confirmUnknownOutcome(client, runId, ask) {
    if (!client || !runId) return false;
    const prompt = typeof ask === "function" ? ask : window.confirm.bind(window);
    if (!prompt(UNKNOWN_OUTCOME_WARNING)) return false;
    const { data, error } = await client.rpc("confirm_ai_run_retry", { p_run_id: runId });
    if (error) return false;
    return data === true;
  }

  /* ── the unknown outcome, from the person's side ──────────────────────────
   *
   * A worker that refuses because an earlier attempt may already have run and
   * been billed leaves a decision behind, not an error. The decision belongs to
   * a person, so it is remembered against whatever the screen considers one
   * action, and taken when they press the button they were already going to
   * press — never as a dialog that appears on its own. */
  const pendingUnknown = new Map();

  function rememberUnknown(key, payload) {
    const runId = payload?.unresolved_run_id || payload?.previous_run_id || null;
    if (!key || !runId) return null;
    pendingUnknown.set(key, runId);
    return runId;
  }

  function pendingUnknownRun(key) {
    return pendingUnknown.get(key) || null;
  }

  function clearUnknown(key) {
    pendingUnknown.delete(key);
  }

  /* The whole decision, in one call, for every screen that can reach it.
   *
   * Returns { handled: false } when there is nothing pending — the caller then
   * proceeds exactly as before. Otherwise it asks, and only a yes reaches the
   * worker. The prompt lives INSIDE once(), so a double press cannot produce
   * two questions, two authorisations or two runs; the second press is
   * dropped before it can ask anything. */
  async function offerUnknownRetry(options) {
    const { client, key, ask, retry } = options || {};
    const runId = pendingUnknownRun(key);
    if (!runId) return { handled: false };

    const outcome = await once(`unknown:${key}`, async () => {
      const authorised = await confirmUnknownOutcome(client, runId, ask);
      /* Declining keeps the block exactly as it was: nothing authorised,
         nothing sent, and the same question available next time. */
      if (!authorised) return { confirmed: false, reason: "declined" };
      /* The authorisation is single-use in the database; forgetting it here
         only stops this screen offering it twice. */
      clearUnknown(key);
      return { confirmed: true, result: await retry() };
    });

    if (outcome?.skipped === "in_flight") {
      return { handled: true, confirmed: false, reason: "in_flight" };
    }
    return { handled: true, ...outcome };
  }

  /* A worker that refused to spend says so in the same shape every time. */
  function skippedVerdict(payload) {
    const skipped = String(payload?.skipped || "").toLowerCase();
    if (skipped === "reused") return "reused";
    if (skipped === "running") return "running";
    if (skipped === "outcome_unknown" || skipped === "unknown") return "outcome_unknown";
    return null;
  }

  function skippedMessage(verdict) {
    if (verdict === "running") return "This analysis is already running. Its result will appear here.";
    if (verdict === "reused") return "Analysis up to date — this result was read from exactly these inputs.";
    if (verdict === "outcome_unknown") {
      return "An earlier attempt may have run and been billed. Confirm before running it again.";
    }
    return "";
  }

  window.MDAIAiUsage = {
    once,
    isBusy,
    usageLine,
    renderUsage,
    confirmReanalyze,
    confirmUnknownOutcome,
    offerUnknownRetry,
    rememberUnknown,
    pendingUnknownRun,
    clearUnknown,
    skippedVerdict,
    skippedMessage,
    REANALYZE_WARNING,
    UNKNOWN_OUTCOME_WARNING,
    NOT_PRICED,
  };
})();
