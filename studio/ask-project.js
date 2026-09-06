/* ASK THIS PROJECT — the browser half.
 *
 * A question, a short answer, and sources a person can click. There is no
 * chat history on purpose: a conversation invites a follow-up that quietly
 * loses its citations, and a citation nobody can check is the thing this
 * product refuses.
 *
 * Nothing here interprets the answer. The worker decides what is shown and
 * what is refused; this file renders it and turns each verified citation into
 * a door.
 */
(function askProjectModule() {
  const state = { client: null, propertyId: null, lastQuestion: null, open: (() => {}) };

  const $ = (id) => document.getElementById(id);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /* What a citation says on the row, built only from fields the worker
     verified. A source with nothing to open still says what it is — an
     honest label beats a dead link. */
  function describe(citation) {
    const parts = [];
    if (citation.label) parts.push(citation.label);
    if (citation.sheet_ref) parts.push(citation.sheet_ref);
    if (citation.opens === "document" && !Number.isInteger(citation.page_number)) parts.push("Whole document · page not recorded");
    if (Number.isFinite(citation.page_number)) parts.push(`Page ${citation.page_number}`);
    if (citation.room_name && !String(citation.label || "").includes(citation.room_name)) {
      parts.push(citation.room_name);
    }
    if (citation.when) {
      const date = new Date(citation.when);
      if (!Number.isNaN(date.valueOf())) {
        parts.push(date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }));
      }
    }
    return parts.filter(Boolean).join(" · ");
  }

  /* Where a source opens. Each kind has one door and the worker already said
     which — this never guesses from a filename. */
  function openCitation(citation) {
    const property = state.propertyId;
    if (!property) return;
    switch (citation.opens) {
      case "document":
        window.location.assign(
          `plans/?property=${encodeURIComponent(property)}`
          + `&document=${encodeURIComponent(citation.document_id || "")}`
          + (Number.isFinite(citation.page_number) ? `&page=${citation.page_number}` : ""),
        );
        return;
      case "capture":
      case "room":
        state.open({
          kind: citation.opens,
          evidenceId: citation.evidence_id || null,
          roomId: citation.room_id || null,
        });
        return;
      default:
        /* Derived records open the comparison, where the numbers they were
           computed from are shown beside them. */
        state.open({ kind: "comparison", recordId: citation.record_id || null });
    }
  }

  function renderAnswer(payload) {
    const answerBox = $("ask-answer");
    const text = $("ask-answer-text");
    const limitations = $("ask-limitations");
    const sourcesHead = $("ask-sources-head");
    const sources = $("ask-sources");
    const note = $("ask-note");
    if (!answerBox) return;

    answerBox.hidden = false;
    text.textContent = payload.answer || "";
    limitations.textContent = payload.limitations || "";
    limitations.hidden = !payload.limitations;

    sources.innerHTML = "";
    const citations = Array.isArray(payload.citations) ? payload.citations : [];
    sourcesHead.hidden = citations.length === 0;
    for (const citation of citations) {
      const row = el("li", "ask-source");
      const button = el("button", "ask-source-link", describe(citation) || citation.source_id);
      button.type = "button";
      button.addEventListener("click", () => openCitation(citation));
      row.appendChild(button);
      if (citation.why) row.appendChild(el("span", "ask-source-why", citation.why));
      sources.appendChild(row);
    }

    /* Said out loud when an answer cost nothing, so nobody wonders whether
       asking twice was billed twice. */
    const lines = [];
    if (payload.reused) lines.push("Answered from the saved answer for this exact question — no new AI call.");
    if (payload.records_considered) {
      lines.push(`${payload.records_considered} record${payload.records_considered === 1 ? "" : "s"} from this project were read.`);
    }
    note.textContent = lines.join(" ");
    note.hidden = lines.length === 0;
  }

  /* One key per project, so a block raised on one project is never offered
     on another. */
  function unknownKey() {
    return `project-search:${state.propertyId || "unknown"}`;
  }

  /* The explanation and the one button that resolves it. */
  function renderUnknown(question) {
    const answerBox = $("ask-answer");
    const text = $("ask-answer-text");
    if (!answerBox) return;
    answerBox.hidden = false;
    text.textContent = window.MDAIAiUsage.skippedMessage("outcome_unknown");
    $("ask-limitations").hidden = true;
    $("ask-sources-head").hidden = true;
    $("ask-sources").innerHTML = "";

    /* The note holds a line and a button as separate nodes, so writing the
       line can never remove the only way out of the block — which is exactly
       what happened when they shared one text node. */
    const note = $("ask-note");
    note.hidden = false;
    note.innerHTML = "";
    const line = el("span", "ask-retry-line", "");
    const button = el("button", "button ask-retry", "Ask again");
    button.type = "button";
    button.id = "ask-retry";
    button.addEventListener("click", async () => {
      const offer = await window.MDAIAiUsage.offerUnknownRetry({
        client: state.client,
        key: unknownKey(),
        /* The block is cleared before this runs, so the retry takes the
           ordinary path rather than asking again. */
        retry: () => ask(question),
      });
      /* Declining changes nothing: the explanation and the button stay, and
         no AI call was made. */
      if (offer.handled && !offer.confirmed && offer.reason === "declined") {
        line.textContent = "Nothing was asked. The earlier attempt is still unresolved.";
      }
    });
    note.appendChild(line);
    note.appendChild(button);
  }

  async function ask(question, options = {}) {
    if (!state.client || !state.propertyId) return;
    const submit = $("ask-submit");
    const answerBox = $("ask-answer");
    const text = $("ask-answer-text");
    /* One press, one question. The worker refuses a duplicate anyway; this
       only spares the round trip and the flicker. */
    if (options.force && !window.MDAIAiUsage?.confirmReanalyze()) return;
    if (window.MDAIAiUsage?.isBusy("ask-project")) return;
    state.lastQuestion = question;
    const askedProperty = state.propertyId;
    submit.disabled = true;
    const previousLabel = submit.textContent;
    submit.textContent = "Asking…";
    answerBox.hidden = false;
    text.textContent = "Reading this project's record…";
    $("ask-limitations").hidden = true;
    $("ask-sources-head").hidden = true;
    $("ask-sources").innerHTML = "";
    $("ask-note").hidden = true;

    try {
      const payload = await window.MDAIAiUsage.once("ask-project", async () => {
        const { data, error } = await state.client.functions.invoke("project-search", {
          body: { property_id: askedProperty, question, force: Boolean(options.force) },
        });
        if (error) throw error;
        return data;
      });
      if (state.propertyId !== askedProperty) return;
      if (payload?.skipped === "in_flight") return;
      /* An earlier attempt at this exact question may already have run and
         been billed. That is a decision, not an error: the block explains
         itself and offers one button, and nothing is sent until it is
         pressed and the question is answered. */
      if (window.MDAIAiUsage.skippedVerdict(payload) === "outcome_unknown") {
        window.MDAIAiUsage.rememberUnknown(unknownKey(), payload);
        renderUnknown(question);
        return;
      }
      if (payload?.error) {
        text.textContent = payload.error;
        return;
      }
      if (payload?.answer == null) {
        text.textContent = payload?.message || "This question is being answered right now.";
        return;
      }
      renderAnswer(payload);
    } catch (error) {
      if (state.propertyId !== askedProperty) return;
      text.textContent = "The question could not be answered just now. The project record is untouched.";
      console.warn("project-search", error);
    } finally {
      submit.disabled = false;
      submit.textContent = previousLabel;
    }
  }

  function mount({ client, propertyId, openSource }) {
    if (state.propertyId !== propertyId) {
      state.lastQuestion = null;
      if ($("ask-answer")) $("ask-answer").hidden = true;
      if ($("ask-question")) $("ask-question").value = "";
    }
    state.client = client;
    state.propertyId = propertyId;
    if (typeof openSource === "function") state.open = openSource;
    const block = $("ask-project");
    if (!block) return;
    block.hidden = !propertyId;
    if (block.dataset.wired) return;
    block.dataset.wired = "1";

    $("ask-again")?.addEventListener("click", () => {
      if (state.lastQuestion) void ask(state.lastQuestion, { force: true });
    });

    $("ask-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const question = $("ask-question").value.trim();
      if (question.length < 3) return;
      void ask(question);
    });
    for (const button of block.querySelectorAll("[data-ask-example]")) {
      button.addEventListener("click", () => {
        $("ask-question").value = button.textContent.trim();
        void ask(button.textContent.trim());
      });
    }
  }

  window.MDAIAskProject = { mount, ask, describe, renderAnswer };
})();
