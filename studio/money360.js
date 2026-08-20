/* Measured Decision · work, money, and the gap in both directions.

   Money does not arrive per object. One invoice covers the rough electrical for
   a house; another covers every window in it. Nobody can answer "how much was
   this outlet", so the product must never ask. An outlet is not a line item —
   it is proof that rough electrical progressed.

   So evidence attaches to the thing, money attaches to the trade, and the two
   are joined by the trade dictionary. That join is what makes the useful
   question short enough to answer on a phone at the property: we saw rough
   electrical, insulation and windows — how much is each.

   And it makes the dangerous question askable at all. Work seen with no money
   recorded is a small gap: somebody has not told us the number yet. Money
   recorded with no work seen anywhere on the property is a different animal
   entirely, and it is the reason a lender pays for a record like this.

   The AI never reads an amount, never infers a price, never decides which
   invoice belongs to which wall. Every figure here is a person's entry.

   window.MDAIMoney360.coverage(rooms, costs) -> the trade-level picture
*/
(() => {
  function money(amount, currency = "USD") {
    const value = Number(amount);
    if (!Number.isFinite(value)) return "";
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
    } catch {
      return `${currency} ${Math.round(value)}`;
    }
  }

  function amountOf(entry) {
    /* Number(null) is 0 and 0 is finite. A recorded zero is a claim that
       something was free; an empty field is nobody having said yet. */
    return entry && entry.amount != null && entry.amount !== "" && Number.isFinite(Number(entry.amount))
      ? Number(entry.amount)
      : null;
  }

  /* Everything the record says it has seen, wherever it came from: the standing
     interpretation of a space, the things a comparison called new, and the
     points a person marked in the sphere. */
  function observations(room) {
    const seen = new Set();
    const out = [];
    const push = (text, origin, extra = {}) => {
      const clean = String(text || "").trim();
      const key = clean.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (!clean || seen.has(key)) return;
      seen.add(key);
      out.push({ key, text: clean, origin, room_id: room.id, room_name: room.name, ...extra });
    };
    (room?.change?.appeared || []).forEach((entry) =>
      push(entry.text, "appeared", { since: room.change.earlier_label }),
    );
    (room?.markers || []).forEach((marker) => {
      if (marker.state === "rejected") return;
      push(marker.detail || marker.label, "marker", { marker_id: marker.id });
    });
    (room?.visible || []).forEach((text) => push(text, "observed"));
    return out;
  }

  function documents(rooms) {
    return (rooms || []).flatMap((room) =>
      (room.evidence || [])
        .filter((item) => {
          const name = String(item?.name || "").toLowerCase();
          return item?.mimeType === "application/pdf" || name.endsWith(".pdf");
        })
        .map((item) => ({ ...item, room_name: room.name })),
    );
  }

  /* A person can overrule the dictionary for one observation, and that
     correction outranks it forever after. */
  function tradeFor(observation, overrides) {
    const override = overrides ? overrides[observation.key] : null;
    if (override) return { trade: override, label: window.MDAITrades360.label(override), confidence: 1, matched: "set by a person" };
    return window.MDAITrades360.classify(observation.text);
  }

  function coverage(rooms, costs = [], overrides = {}) {
    if (!window.MDAITrades360) return null;
    const buckets = new Map();
    const bucket = (key) => {
      if (!buckets.has(key)) {
        buckets.set(key, {
          key,
          label: window.MDAITrades360.label(key),
          billable: window.MDAITrades360.billable(key),
          spaces: new Set(),
          examples: [],
          evidence_count: 0,
          new_count: 0,
          entries: [],
          amount: 0,
          has_amount: false,
        });
      }
      return buckets.get(key);
    };

    (rooms || []).forEach((room) => {
      observations(room).forEach((observation) => {
        const guess = tradeFor(observation, overrides);
        const item = bucket(guess.trade);
        item.spaces.add(room.name);
        item.evidence_count += 1;
        if (observation.origin === "appeared") item.new_count += 1;
        if (item.examples.length < 3) {
          item.examples.push({ ...observation, confidence: guess.confidence, matched: guess.matched });
        }
      });
    });

    (costs || []).forEach((entry) => {
      const item = bucket(entry.trade || window.MDAITrades360.UNASSIGNED.key);
      item.entries.push(entry);
      const value = amountOf(entry);
      if (value != null) {
        item.amount += value;
        item.has_amount = true;
      }
    });

    const trades = window.MDAITrades360.TRADES.map((trade) => buckets.get(trade.key))
      .concat(buckets.get(window.MDAITrades360.UNASSIGNED.key) || [])
      .filter(Boolean)
      .map((item) => ({
        ...item,
        spaces: [...item.spaces],
        amount_label: item.has_amount ? money(item.amount) : "",
        invoices: item.entries.map((entry) => entry.invoice_ref).filter(Boolean),
        documents: item.entries.map((entry) => entry.document_evidence_id).filter(Boolean),
        /* The four states this whole product exists to distinguish. */
        state: item.evidence_count && item.has_amount
          ? "covered"
          : item.evidence_count
            ? "no_money"
            : item.has_amount
              ? "no_evidence"
              : "empty",
      }))
      .filter((item) => item.evidence_count || item.has_amount);

    const questions = trades.filter((item) => item.state === "no_money" && item.billable);
    const alarms = trades.filter((item) => item.state === "no_evidence");
    const recorded = trades.reduce((total, item) => total + item.amount, 0);

    return {
      trades,
      questions,
      alarms,
      documents: documents(rooms),
      recorded_total: recorded,
      recorded_label: recorded ? money(recorded) : "",
      /* One sentence, and it leads with the thing that costs money to miss. */
      headline: alarms.length
        ? `${money(alarms.reduce((total, item) => total + item.amount, 0))} is recorded against work that is not visible anywhere in this record.`
        : questions.length
          ? `${questions.length} kind${questions.length === 1 ? "" : "s"} of work ${questions.length === 1 ? "is" : "are"} visible with no cost recorded yet.`
          : recorded
            ? `Every kind of work on record carries a recorded cost · ${money(recorded)} in total.`
            : "No cost has been recorded against this project yet.",
    };
  }

  window.MDAIMoney360 = { coverage, observations, documents, money, amountOf };
})();
