/* Measured Decision · work, money, and the paperwork between them.

   The record can now say what appeared between two captures. That is only half
   an answer. The half that decides whether a payment goes out is: what did it
   cost, and which document covers it.

   The AI is not allowed anywhere near this. It never reads an amount, never
   infers a price, never guesses which invoice belongs to which wall. A figure
   is here because a person put it here, or it is absent — and absence is not a
   blank, it is a request addressed to whoever owes the document.

   What this file owns is the reconciliation: line up the work the record shows
   against the money and paper attached to it, and name every gap in both
   directions. Work with no document is the gap that loses money. A document
   attached to nothing is the gap that hides it.

   window.MDAIMoney360.reconcile(room) -> the ledger for one space
   window.MDAIMoney360.projectTotals(rooms) -> the same across a project
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

  function key(text) {
    return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function entriesFor(room) {
    return Array.isArray(room?.costs) ? room.costs : [];
  }

  function findEntry(room, workKey) {
    return entriesFor(room).find((entry) => entry.work_key === workKey) || null;
  }

  /* The work this space is answerable for: everything the last comparison
     reported as new, plus anything a person marked by hand in the sphere. One
     line per thing, whichever way it got into the record. */
  function workItems(room) {
    const items = [];
    const seen = new Set();
    const push = (label, source, extra = {}) => {
      const workKey = key(label);
      if (!workKey || seen.has(workKey)) return;
      seen.add(workKey);
      items.push({ work_key: workKey, label, source, ...extra });
    };
    (room?.change?.appeared || []).forEach((entry) =>
      push(entry.text, "appeared", { since: room.change.earlier_label, confidence: entry.confidence }),
    );
    (room?.markers || []).forEach((marker) => {
      if (marker.state === "rejected") return;
      push(marker.detail || marker.label, "marker", { marker_id: marker.id, marker_state: marker.state });
    });
    return items;
  }

  /* Documents are evidence like anything else: a PDF a person attached to this
     space. A document nobody linked to a piece of work is listed on its own,
     because an unexplained invoice is a question too. */
  function documents(room) {
    return (room?.evidence || []).filter((item) => {
      const name = String(item?.name || "").toLowerCase();
      return item?.mimeType === "application/pdf" || name.endsWith(".pdf");
    });
  }

  function reconcile(room) {
    const items = workItems(room).map((item) => {
      const entry = findEntry(room, item.work_key);
      const document = entry?.document_evidence_id
        ? documents(room).find((file) => file.id === entry.document_evidence_id) || null
        : null;
      return {
        ...item,
        /* Number(null) is 0 and 0 is finite, so an unpriced item used to report
           itself as costing nothing — which is a claim, not an absence. No
           recorded amount means no amount. */
        amount:
          entry && entry.amount != null && entry.amount !== "" && Number.isFinite(Number(entry.amount))
            ? Number(entry.amount)
            : null,
        currency: entry?.currency || "USD",
        invoice_ref: entry?.invoice_ref || "",
        document_evidence_id: entry?.document_evidence_id || "",
        document_name: document?.name || "",
        requested: Boolean(entry?.requested),
        recorded_at: entry?.recorded_at || "",
      };
    });

    const linkedDocumentIds = new Set(items.map((item) => item.document_evidence_id).filter(Boolean));
    const unlinkedDocuments = documents(room).filter((file) => !linkedDocumentIds.has(file.id));

    const missingDocument = items.filter((item) => !item.document_evidence_id);
    const missingCost = items.filter((item) => item.amount == null);
    const recorded = items.reduce((total, item) => total + (item.amount || 0), 0);

    return {
      items,
      documents: documents(room),
      unlinked_documents: unlinkedDocuments,
      missing_document: missingDocument,
      missing_cost: missingCost,
      recorded_total: recorded,
      recorded_label: recorded ? money(recorded, items.find((item) => item.amount != null)?.currency || "USD") : "",
      /* The one sentence that decides whether a payment is safe to release. */
      headline: !items.length
        ? "No work has been identified in this space yet."
        : missingDocument.length
          ? `${missingDocument.length} of ${items.length} item${items.length === 1 ? "" : "s"} on record ${missingDocument.length === 1 ? "has" : "have"} no document behind ${missingDocument.length === 1 ? "it" : "them"}.`
          : `Every item on record is covered by a document${recorded ? ` · ${money(recorded)} recorded` : ""}.`,
    };
  }

  function projectTotals(rooms) {
    const ledgers = (rooms || []).map((room) => ({ room, ledger: reconcile(room) }));
    const items = ledgers.reduce((total, entry) => total + entry.ledger.items.length, 0);
    const missing = ledgers.reduce((total, entry) => total + entry.ledger.missing_document.length, 0);
    const recorded = ledgers.reduce((total, entry) => total + entry.ledger.recorded_total, 0);
    const unlinked = ledgers.reduce((total, entry) => total + entry.ledger.unlinked_documents.length, 0);
    return {
      ledgers,
      items,
      missing_document: missing,
      unlinked_documents: unlinked,
      recorded_total: recorded,
      recorded_label: recorded ? money(recorded) : "",
      requests: ledgers.flatMap(({ room, ledger }) =>
        ledger.missing_document.map((item) => ({
          room_id: room.id,
          room_name: room.name,
          work_key: item.work_key,
          label: item.label,
          since: item.since || "",
          text: `Send the invoice or work order covering "${item.label}" in ${room.name}`,
        })),
      ),
    };
  }

  window.MDAIMoney360 = { reconcile, projectTotals, workItems, documents, money, key };
})();
