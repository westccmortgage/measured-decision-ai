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
    return `AI usage: ${runs} run${runs === 1 ? "" : "s"} · ${tokenText} · ${cost}${note}`;
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

  /* A worker that refused to spend says so in the same shape every time. */
  function skippedVerdict(payload) {
    const skipped = String(payload?.skipped || "").toLowerCase();
    if (skipped === "reused") return "reused";
    if (skipped === "running") return "running";
    return null;
  }

  function skippedMessage(verdict) {
    if (verdict === "running") return "This analysis is already running. Its result will appear here.";
    if (verdict === "reused") return "Analysis up to date — this result was read from exactly these inputs.";
    return "";
  }

  window.MDAIAiUsage = {
    once,
    isBusy,
    usageLine,
    renderUsage,
    confirmReanalyze,
    skippedVerdict,
    skippedMessage,
    REANALYZE_WARNING,
    NOT_PRICED,
  };
})();
