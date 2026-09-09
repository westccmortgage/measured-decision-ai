/* The screen. It starts a real Core V2 run, re-reads the record after every
 * tick, and draws what it finds. It decides nothing: there is no rule in this
 * file about what agrees, what is proved or what needs a person — those are
 * the engine's answers, and this only puts them in words and boxes.
 *
 * Two deliberate absences worth naming:
 *   · nothing here holds a reader's answer to hand to another reader. The
 *     engine builds every packet, so independence is not something the screen
 *     has to remember to preserve;
 *   · Stop is not a paused animation. It asks the engine to cancel, and then
 *     shows whatever the engine did about it.
 */
import { STAGES, createRun, driveRun, readRun, stopRun } from "./adapter.js";

const el = (id) => document.getElementById(id);
const startButton = el("start");
const stopButton = el("stop");
const againButton = el("again");

let current = null;
let stopping = false;

/* ── drawing ──────────────────────────────────────────────────────────── */

function text(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}

/* A subject key the engine uses ("entry/E-001") in the words a reader of this
   screen would use. Nothing is renamed on the way back in. */
function readable(subjectKey) {
  if (!subjectKey) return "a subject";
  const key = String(subjectKey);
  const [kind, ...rest] = key.split("/");
  if (kind === "entry") return `Row ${rest[0]}`;
  if (kind === "category") return `Category ${rest[0]}`;
  if (kind.startsWith("source")) return `Record set ${String.fromCharCode(65 + Number(key.split(":")[1] ?? 0))}`;
  if (kind === "sheet") {
    const region = rest.indexOf("region");
    return region === -1 ? `Sheet ${rest.join(".")}` : `Sheet ${rest[0]}.${rest[1]}, region ${rest[region + 1]}`;
  }
  /* A normalised signature the engine made from a subject, e.g. ENTRYE001. */
  const normalised = key.match(/^ENTRY([A-Z])(\d+)$/i);
  if (normalised) return `Row ${normalised[1]}-${normalised[2]}`;
  return key;
}

/* What the engine recorded, said the way a person would say it. A digest and a
   rule name are facts about the machinery, not findings about the evidence, so
   they are named rather than printed: the digest belongs behind View evidence,
   and the screen is for the decision. */
function valueOf(claim) {
  const v = claim?.value ?? {};
  if (claim?.predicate === "content_identity") return "identity confirmed against the source";
  if (claim?.predicate === "revision_status") return v.text === "current" ? "current revision" : String(v.text ?? "—");
  if (v.known === false) return "could not be read";
  if (v.text && !/^digest=|^sha-?256/i.test(v.text)) return v.text;
  if (v.quantity !== null && v.quantity !== undefined) return String(v.quantity);
  return "recorded";
}

/* What a claim is ABOUT, in a phrase. */
function predicateOf(claim) {
  return {
    quantity: "quantity read from the table",
    total_quantity: "total across the accepted rows",
    content_identity: "the source is the one that was submitted",
    revision_status: "revision",
  }[claim?.predicate] ?? String(claim?.predicate ?? "").replace(/_/g, " ");
}

/* The engine's rule names, in a sentence. Anything unmapped is shown as the
   engine wrote it rather than guessed at. */
const RULE_WORDS = {
  independent_verification_supports_anchor: "an independent check found the same thing at the same place in the source",
  source_identity_matches_manifest: "the source is the one that was submitted",
};
function rationaleOf(decision) {
  const raw = decision.rationale ?? "";
  if (RULE_WORDS[raw]) return RULE_WORDS[raw];
  if (raw.startsWith("derived:")) return "calculated by code from the accepted readings, not read by a model";
  return raw;
}

/* A decision's own title starts with an identifier the engine derived. A
   person needs the subject, not the id. */
function decisionTitle(decision) {
  const subject = readable(decision.subjectKey);
  const what = {
    accept_claim: "accepted",
    reject_claim: "rejected",
    reject_all: "all readings rejected",
    correct_claim: "corrected",
    proceed: "evidenced and cleared",
    hold: "held for a person",
    supersede: "superseded",
  }[decision.decisionType] ?? decision.decisionType.replace(/_/g, " ");
  return `${subject} — ${what}`;
}

function drawTimeline(view) {
  const list = el("timeline");
  list.replaceChildren();
  const at = STAGES.findIndex((s) => s.key === view.stage);
  STAGES.forEach((stage, index) => {
    const li = text("li");
    li.dataset.state = view.finished || index < at ? "done" : index === at ? "active" : "waiting";
    if (view.finished) li.dataset.state = "done";
    li.append(text("span", "dot"), text("span", null, stage.label));
    list.append(li);
  });
}

function drawWorkers(view) {
  const list = el("workers");
  list.replaceChildren();
  for (const worker of view.workers) list.append(text("li", null, worker));
}

/* "View evidence" — the source, the segment, where on it, who said so, and
   whether anything has checked it. The material itself is shown, not
   described. */
function evidenceButton(claim) {
  const button = text("button", "evidence-open", `View evidence (${claim.evidence.length})`);
  button.type = "button";
  button.addEventListener("click", () => openEvidence(claim));
  return button;
}

function openEvidence(claim) {
  const body = el("evidence-body");
  body.replaceChildren();
  body.append(text("h3", null, `${readable(claim.subjectKey)} — ${claim.predicate.replace(/_/g, " ")}`));
  body.append(text("p", "finding-why", `Recorded value: ${valueOf(claim)}`));

  if (claim.evidence.length === 0) {
    body.append(text("p", "finding-why", "No anchor was recorded for this claim, which is why it was not accepted."));
  }

  for (const piece of claim.evidence) {
    const meta = text("dl", "evidence-meta");
    const row = (label, value) => {
      if (value === null || value === undefined || value === "") return;
      const wrap = text("div");
      wrap.append(text("dt", null, label), text("dd", null, String(value)));
      meta.append(wrap);
    };
    row("Source", piece.sourceLabel);
    row("Segment", piece.segmentLabel ?? piece.segmentId);
    if (piece.locator?.bbox) row("Where on it", `x ${piece.locator.bbox[0].toFixed(3)}–${piece.locator.bbox[2].toFixed(3)}, y ${piece.locator.bbox[1].toFixed(3)}–${piece.locator.bbox[3].toFixed(3)}`);
    if (piece.locator?.timeRange) row("Time range", `${piece.locator.timeRange.startsAt}s – ${piece.locator.timeRange.endsAt}s`);
    if (piece.locator?.page !== undefined) row("Page", piece.locator.page);
    row("Claimed by", claim.madeBy);
    row("Verification state", claim.status);
    body.append(meta);

    if (piece.bytes && piece.mediaKind === "text") {
      body.append(text("pre", "excerpt", new TextDecoder().decode(piece.bytes)));
    } else if (piece.bytes && piece.mediaKind === "image") {
      const image = document.createElement("img");
      let binary = "";
      for (const byte of piece.bytes) binary += String.fromCharCode(byte);
      image.src = `data:${piece.mimeType};base64,${btoa(binary)}`;
      image.alt = `The evidence region for ${readable(claim.subjectKey)}`;
      body.append(image);
    }
    if (piece.quotedText) body.append(text("pre", "excerpt", piece.quotedText));
  }

  for (const assessment of claim.assessments) {
    body.append(text("p", "finding-why", `${assessment.madeBy}: ${assessment.verdict} — ${assessment.rationale ?? "no rationale recorded"}`));
  }
  el("evidence").showModal();
}

function findingNode(claim, { why } = {}) {
  const li = text("li", "finding");
  const head = text("div", "finding-head");
  head.append(text("span", "finding-what", `${readable(claim.subjectKey)} · ${valueOf(claim)}`));
  head.append(text("span", "finding-who", claim.madeBy));
  li.append(head);
  li.append(text("p", "finding-why", predicateOf(claim)));
  if (why) li.append(text("p", "finding-why", why));
  li.append(evidenceButton(claim));
  return li;
}

function drawResults(view) {
  el("count-agreed").textContent = view.agreed.length;
  el("count-disagreement").textContent = view.disagreements.length;
  el("count-unproved").textContent = view.unproved.length;
  el("count-decision").textContent = view.decisions.length;

  const agreed = el("list-agreed");
  agreed.replaceChildren();
  for (const claim of view.agreed) agreed.append(findingNode(claim));
  if (view.agreed.length === 0) agreed.append(text("li", "finding-why", "Nothing accepted yet."));

  const disputed = el("list-disagreement");
  disputed.replaceChildren();
  for (const dispute of view.disagreements) {
    const li = text("li", "finding");
    const head = text("div", "finding-head");
    head.append(text("span", "finding-what", readable(dispute.subjectKey)));
    const held = dispute.state === "needs_human";
    const tag = text("span", "tag", held ? "held for a person" : dispute.state.replace(/_/g, " "));
    tag.dataset.tone = held ? "held" : "settled";
    head.append(tag);
    li.append(head);
    if (dispute.needsHumanReason) li.append(text("p", "finding-why", dispute.needsHumanReason));
    const sides = text("div", "finding-sides");
    for (const side of dispute.sides) {
      const box = text("div", "side");
      box.dataset.outcome = side.status;
      box.append(text("div", "side-who", `${side.madeBy} — ${side.status}`));
      box.append(text("div", "side-value", valueOf(side)));
      box.append(evidenceButton(side));
      sides.append(box);
    }
    li.append(sides);
    disputed.append(li);
  }
  if (view.disagreements.length === 0) disputed.append(text("li", "finding-why", "No conflicting readings."));

  const unproved = el("list-unproved");
  unproved.replaceChildren();
  for (const claim of view.unproved) unproved.append(findingNode(claim, { why: claim.why }));
  if (view.unproved.length === 0) unproved.append(text("li", "finding-why", "Nothing outstanding."));

  const decisions = el("list-decision");
  decisions.replaceChildren();
  const decisionNode = (decision) => {
    const li = text("li", "finding");
    const head = text("div", "finding-head");
    head.append(text("span", "finding-what", decisionTitle(decision)));
    const held = decision.decisionType === "hold" || decision.status === "needs_human";
    const byPerson = decision.authority === "adjudicator";
    const tag = text("span", "tag", held ? "held for a person" : byPerson ? "settled on evidence" : "accepted by rule");
    tag.dataset.tone = held ? "held" : "settled";
    head.append(tag);
    li.append(head);
    const why = rationaleOf(decision);
    if (why) li.append(text("p", "finding-why", why));
    return li;
  };
  /* What a person needs first: anything held, and anything a judgement settled
     rather than a rule. The routine machine accepts are real and are kept, one
     disclosure away, so the screen is honest without being a log. */
  const notable = view.decisions.filter((d) => d.decisionType === "hold" || d.authority === "adjudicator");
  const routine = view.decisions.filter((d) => !notable.includes(d));
  for (const decision of notable) decisions.append(decisionNode(decision));
  if (routine.length > 0) {
    const more = text("details", "technical");
    more.append(text("summary", null, `Show ${routine.length} routine decision${routine.length === 1 ? "" : "s"} accepted by rule`));
    const list = text("ul", "findings");
    for (const decision of routine) list.append(decisionNode(decision));
    more.append(list);
    decisions.append(more);
  }
  if (view.decisions.length === 0) decisions.append(text("li", "finding-why", "No decision yet."));
}

function drawFacts(view) {
  const facts = el("facts");
  facts.replaceChildren();
  const add = (label, value, tone) => {
    const wrap = text("div");
    const dd = text("dd", null, value);
    if (tone) dd.dataset.tone = tone;
    wrap.append(text("dt", null, label), dd);
    facts.append(wrap);
  };
  add("Current state", view.state.replace(/_/g, " "));
  add("Completed assignments", `${view.facts.completedAssignments} of ${view.facts.totalAssignments}`);
  add("Refused assignments", String(view.facts.refusedAssignments));
  add("External cost", view.facts.externalCost, "good");
  add("Provider network", view.facts.providerNetwork, "good");
  add("Human review required", view.facts.humanReviewRequired ? "yes" : "no", view.facts.humanReviewRequired ? "held" : "good");

  const technical = el("technical");
  technical.replaceChildren();
  const addTechnical = (label, value) => {
    const wrap = text("div");
    wrap.append(text("dt", null, label), text("dd", null, value));
    technical.append(wrap);
  };
  addTechnical("Workflow id", view.workflowId);
  addTechnical("Run seed", view.seed);
  addTechnical("Engine", "Core V2 kernel, synthetic-records pack, sealed transport");
}

function draw(view) {
  for (const id of ["progress-panel", "workers-panel", "results", "facts-panel"]) el(id).hidden = false;
  drawTimeline(view);
  drawWorkers(view);
  drawResults(view);
  drawFacts(view);
}

/* ── running ──────────────────────────────────────────────────────────── */

async function start() {
  stopping = false;
  startButton.disabled = true;
  startButton.hidden = true;
  againButton.hidden = true;
  stopButton.hidden = false;
  el("opening-note").textContent = "Running. Every reading below is written by the engine as it happens.";

  current = createRun();
  draw(await readRun(current));

  const view = await driveRun(current, {
    onProgress: (progress) => {
      draw(progress);
      /* Let the browser paint between ticks, so a person can watch the run
         rather than being handed the end of it. */
      return new Promise((resolve) => setTimeout(resolve, 220));
    },
    shouldStop: () => stopping,
  });

  draw(view);
  finish(view);
}

function finish(view) {
  stopButton.hidden = true;
  againButton.hidden = false;
  againButton.disabled = false;
  startButton.disabled = false;
  el("opening-note").textContent = view.facts.humanReviewRequired
    ? "Finished. Something could not be settled by machine, and is held for a person."
    : "Finished. Every accepted finding above points at the evidence it rests on.";
}

startButton.addEventListener("click", () => { start().catch(report); });

stopButton.addEventListener("click", async () => {
  stopping = true;
  stopButton.disabled = true;
  el("opening-note").textContent = "Stopping — the engine is being asked to cancel this run.";
  try {
    const view = await stopRun(current);
    draw(view);
    el("opening-note").textContent = "Stopped. Work that was never sent was dropped; anything already sent is recorded rather than pretended away.";
    stopButton.disabled = false;
    finish(view);
    el("opening-note").textContent = "Stopped by you. The engine cancelled the run.";
  } catch (error) { report(error); }
});

againButton.addEventListener("click", () => {
  /* A new run, not a re-render: createRun() seeds a new workflow id. */
  againButton.disabled = true;
  start().catch(report);
});

function report(error) {
  el("opening-note").textContent = `The demonstration could not finish: ${error?.message ?? error}`;
  startButton.disabled = false;
  startButton.hidden = false;
  stopButton.hidden = true;
}

/* So a test can drive the same screen a person does. */
window.measuredDecisionRun = { current: () => current, readRun, createRun };
