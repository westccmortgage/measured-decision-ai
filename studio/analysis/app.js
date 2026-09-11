/* THE PATH: CREATE AN ANALYSIS → ADD FILES → SAY WHAT TO CHECK → RUN → READ.
 *
 * Every screen here is drawn from the record. There is no in-memory idea of
 * "where we are": reloading the page, or opening the same link on a phone,
 * shows the same analysis at the same point, because the point is a row.
 *
 * Three rules this file keeps and is easy to break:
 *
 *   1. NO INVENTED PROGRESS. What is shown while an analysis runs is a count
 *      of finished assignments out of the assignments that exist. A percentage
 *      would have to be guessed, and a guessed percentage is a lie told with a
 *      progress bar.
 *   2. NOTHING SPENDS WITHOUT A PRESS. The run button is the only thing in the
 *      product that authorises money, it shows the ceiling first, and the
 *      amount is written into the record — the server reads it from there.
 *   3. NO KEYS HERE. This page holds the signed-in person's own token and
 *      nothing else. Provider keys live in the function environment; this file
 *      could not reach a provider if it tried.
 */
import { backendFor } from "./backend.js?v=existing-project-1";
import { AnalysisRecord, Refusal } from "./record.js";
import { KINDS, MAXIMUM_FILES, humanBytes } from "./formats.js";
import { clock, coverageSentence } from "./plan.js";

const FUNCTION = "core-v2-analysis";
const screen = document.getElementById("screen");

/* Use the Studio project and its existing account session on this origin. */
const backend = backendFor(window.location.hostname, window.MDAI_CONFIG || {});
const config = {
  supabaseUrl: backend.supabaseUrl,
  supabasePublishableKey: backend.publishableKey,
  storageBucket: backend.storageBucket,
};

const client = window.supabase?.createClient && config.supabaseUrl && config.supabasePublishableKey
  ? window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: {
        persistSession: true, autoRefreshToken: true, detectSessionInUrl: true,

      },
    })
  : null;

const state = {
  session: null,
  organizationId: null,
  role: null,
  record: null,      // AnalysisRecord, once signed in
  analyses: [],
  open: null,        // { run, files, events }
  status: null,
  pairing: null,    // what will be compared with what
  results: null,
  busy: new Map(),   // fileId -> { phase, sent, total, what }
  pending: null,     // a file whose row does not exist yet
  problem: "",
  poll: null,
};

/* ─────────────────────────────────────────────────────────── small tools */

const h = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content; };
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const say = (message) => { state.problem = message ? String(message) : ""; render(); };

async function call(op, body = {}) {
  const token = state.session?.access_token;
  const response = await fetch(`${config.supabaseUrl}/functions/v1/${FUNCTION}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      apikey: config.supabasePublishableKey,
    },
    body: JSON.stringify({ op, ...body }),
  });
  let payload = {};
  try { payload = await response.json(); } catch { payload = {}; }
  if (!response.ok) throw new Refusal(payload.refused || `${op} was refused (${response.status})`);
  return payload;
}

/* ─────────────────────────────────────────────────────────────── booting */

async function boot() {
  document.getElementById("theme").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("mdai-theme", next); } catch { /* private window */ }
  });
  document.getElementById("sign-out").addEventListener("click", async () => {
    await client?.auth.signOut();
    location.hash = "";
    location.reload();
  });

  if (!client) { screen.replaceChildren(h(`<div class="card refusal"><strong>This page is not configured.</strong><p class="muted">config.js is missing the Supabase address or key.</p></div>`)); return; }

  const { data } = await client.auth.getSession();
  state.session = data?.session ?? null;
  client.auth.onAuthStateChange((_event, session) => {
    state.session = session;
    if (session) hydrate().then(route);
    else render();
  });
  window.addEventListener("hashchange", route);
  if (state.session) await hydrate();
  await route();
}

async function hydrate() {
  const { data, error } = await client
    .from("organization_members")
    .select("organization_id, role")
    .eq("user_id", state.session.user.id)
    .order("created_at", { ascending: true })
    .limit(1).maybeSingle();
  if (error || !data) {
    state.organizationId = null;
    return;
  }
  state.organizationId = data.organization_id;
  state.role = data.role;
  state.record = new AnalysisRecord({
    client,
    organizationId: state.organizationId,
    userId: state.session.user.id,
    supabaseUrl: config.supabaseUrl,
    bucket: config.storageBucket || "property-evidence",
    accessToken: state.session.access_token,
  });
}

function analysisIdInUrl() {
  const match = /^#\/a\/([0-9a-f-]{36})/i.exec(location.hash || "");
  return match ? match[1] : null;
}

async function route() {
  stopPolling();
  const where = document.getElementById("where");
  if (where) {
    where.textContent = backend.name;
    where.title = `${backend.note} (${backend.database})`;
    where.dataset.kind = backend.name === "production" ? "live" : "test";
  }
  document.getElementById("who").textContent = state.session?.user?.email || "";
  document.getElementById("sign-out").hidden = !state.session;
  state.problem = "";
  if (!state.session || !state.organizationId) { render(); return; }

  const id = analysisIdInUrl();
  if (!id) {
    state.open = null; state.status = null; state.results = null;
    try { state.analyses = await state.record.list(); } catch (error) { state.problem = error.message; }
    render();
    return;
  }
  await refreshOpen(id);
  render();
  maybePoll();
}

async function refreshOpen(analysisId) {
  try {
    state.open = await state.record.read(analysisId);
    if (!state.open) { state.problem = "That analysis is not in this workspace."; return; }
    state.status = await call("status", { analysisId });
    state.pairing = state.open.run.question_kind === "specific_question"
      ? null : await call("pairing", { analysisId });
    state.results = state.open.run.workflow_id ? await call("results", { analysisId }) : null;
  } catch (error) {
    state.problem = error.message;
  }
}

function maybePoll() {
  stopPolling();
  const running = state.status?.state === "running" || state.status?.stage === "reading"
    || state.status?.stage === "planning" || state.status?.stage === "deciding";
  if (!running) return;
  state.poll = setInterval(async () => {
    const id = analysisIdInUrl();
    if (!id) return stopPolling();
    await refreshOpen(id);
    render();
    maybePoll();
  }, 5000);
}
function stopPolling() { if (state.poll) { clearInterval(state.poll); state.poll = null; } }

/* ───────────────────────────────────────────────────────────── rendering */

function render() {
  if (!state.session) return screen.replaceChildren(signIn());
  if (!state.organizationId) {
    const card = h(`
      <div class="card">
        <p class="eyebrow">One step, once</p>
        <h1>This account has no workspace yet</h1>
        <p class="lede">An analysis belongs to a workspace — a private place for your files, your
        analyses and what they were authorised to spend. You do not have one on
        <strong>${esc(backend.name)}</strong> yet.</p>
        <button class="primary" id="make-workspace" type="button">Create my workspace</button>
        <p class="faint" id="workspace-said" style="margin-top:10px"></p>
      </div>`);
    card.querySelector("#make-workspace").addEventListener("click", async (event) => {
      event.currentTarget.disabled = true;
      const said = screen.querySelector("#workspace-said");
      const { error } = await client.rpc("bootstrap_personal_organization", { workspace_name: "My workspace" });
      if (error) { if (said) said.textContent = error.message; event.currentTarget.disabled = false; return; }
      await hydrate();
      await route();
    });
    return screen.replaceChildren(card);
  }

  const parts = [];
  if (state.problem) parts.push(h(`<div class="card refusal"><strong>${esc(state.problem)}</strong></div>`));
  parts.push(analysisIdInUrl() && state.open ? workScreen() : homeScreen());
  screen.replaceChildren(...parts);
}

/* ── sign in ─────────────────────────────────────────────────────────── */

function signIn() {
  const node = h(`
    <div class="card">
      <p class="eyebrow">Measured Decision</p>
      <h1>Sign in to run an analysis</h1>
      <p class="lede">The same sign-in as the Studio. Your files, the material prepared from them
      and the analysis itself stay inside your workspace.</p>
      <div class="row" style="margin-bottom:14px"><button class="primary" id="google" type="button">Continue with Google</button></div>
      <label class="field"><span>Email</span><input id="email" type="email" autocomplete="email"></label>
      <label class="field"><span>Password</span><input id="password" type="password" autocomplete="current-password"></label>
      <div class="row">
        <button class="primary" id="password-in" type="button">Sign in</button>
        <button id="link-in" type="button">Email me a link instead</button>
      </div>
      <p class="faint" id="auth-said" style="margin-top:10px"></p>
    </div>`);
  const said = (text) => { const el = screen.querySelector("#auth-said"); if (el) el.textContent = text; };
  node.querySelector("#google").addEventListener("click", () =>
    client.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.href } }));
  node.querySelector("#password-in").addEventListener("click", async () => {
    const email = screen.querySelector("#email").value.trim();
    const password = screen.querySelector("#password").value;
    const { error } = await client.auth.signInWithPassword({ email, password });
    said(error ? error.message : "Signed in.");
  });
  node.querySelector("#link-in").addEventListener("click", async () => {
    const email = screen.querySelector("#email").value.trim();
    const { error } = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: location.href } });
    said(error ? error.message : `A sign-in link is on its way to ${email}.`);
  });
  return node;
}

/* ── the list, and starting a new one ────────────────────────────────── */

function homeScreen() {
  const rows = state.analyses.map((a) => `
    <tr>
      <td><a href="#/a/${esc(a.id)}">${esc(a.title)}</a></td>
      <td class="muted">${esc(questionName(a.question_kind))}</td>
      <td><span class="pill" data-tone="${esc(toneForState(a.state))}">${esc(a.state)}</span></td>
      <td class="faint">${esc(new Date(a.created_at).toLocaleString())}</td>
    </tr>`).join("");

  const node = h(`
    <div class="stack">
      <div class="card">
        <p class="eyebrow">Step 1 of 5</p>
        <h1>Create an analysis</h1>
        <p class="lede">Give it a name, choose what you want checked, then add your own PDF plans
        and video. Independent AI readers look at each page and each sampled moment separately;
        what they agree on, what they differ on, and what nobody could settle are shown apart.</p>
        <label class="field"><span>Name it</span><input id="title" type="text" placeholder="e.g. Riverside — level 2 electrical set"></label>
        <div class="choices" id="kinds">
          ${Object.entries(QUESTIONS).map(([key, q], i) => `
            <label class="choice">
              <input type="radio" name="question-kind" value="${key}" ${i === 0 ? "checked" : ""}>
              <span><strong>${esc(q.name)}</strong><small>${esc(q.detail)}</small></span>
            </label>`).join("")}
        </div>
        <label class="field"><span>Anything specific to check? (optional — this is given to every reader word for word)</span>
          <textarea id="question" placeholder="e.g. Is a smoke detector shown in every bedroom?"></textarea></label>
        <button class="primary" id="make" type="button">Create analysis</button>
      </div>
      ${state.analyses.length ? `
      <div class="card">
        <h2>Your analyses</h2>
        <div class="scroll-x"><table class="plain">
          <thead><tr><th>Name</th><th>Checking</th><th>State</th><th>Started</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>` : ""}
    </div>`);

  node.querySelector("#make").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const created = await state.record.create({
        title: screen.querySelector("#title").value,
        questionKind: screen.querySelector('input[name="question-kind"]:checked').value,
        question: screen.querySelector("#question").value,
      });
      location.hash = `#/a/${created.id}`;
    } catch (error) {
      button.disabled = false;
      say(error.message);
    }
  });
  return node;
}

const QUESTIONS = {
  plan_consistency: {
    name: "Check the plans against themselves",
    detail: "Read every page of the plan set and look for what disagrees between sheets.",
    ask: "Does this page disagree with anything else in this plan set?",
  },
  video_against_plans: {
    name: "Compare the video against the selected plans",
    detail: "Read the plan pages and sampled moments of the video, and look for what is on one and not the other.",
    ask: "Does what is visible here match what the plans show?",
  },
  specific_question: {
    name: "Check one thing",
    detail: "Ask one question and have every page and every sampled moment answered against it.",
    ask: "",
  },
};
const questionName = (kind) => QUESTIONS[kind]?.name || kind;
const toneForState = (s) => ({ finished: "good", running: "open", failed: "bad", cancelled: "warn" }[s] || "");

/* ── the analysis ────────────────────────────────────────────────────── */

function workScreen() {
  const { run, files } = state.open;
  const status = state.status || {};
  const started = !!run.workflow_id;
  const preparedSubjects = (status.materialPrepared?.pdf_page_image || 0) + (status.materialPrepared?.video_frame || 0);
  const allStored = files.length > 0 && files.every((f) => f.upload_state === "stored");
  const allPrepared = files.length > 0 && files.every((f) => f.preparation_state === "prepared");

  const node = h(`
    <div class="stack">
      <div class="card">
        <div class="row"><a href="#/" class="faint">← All analyses</a></div>
        <h1>${esc(run.title)}</h1>
        <p class="lede">${esc(questionName(run.question_kind))}${run.question ? ` — “${esc(run.question)}”` : ""}</p>
        <div class="row">
          <span class="pill" data-tone="${esc(toneForState(run.state))}">${esc(run.state)}</span>
          ${status.stage ? `<span class="pill">${esc(stageWords(status.stage))}</span>` : ""}
          ${run.authorized_usd ? `<span class="pill">authorised $${esc(Number(run.authorized_usd).toFixed(2))}</span>` : ""}
        </div>
      </div>

      <div class="card step" data-done="${allStored && files.length ? "yes" : "no"}" data-active="${started ? "no" : "yes"}">
        <div class="step-number">2</div>
        <div class="step-body" id="files-step"></div>
      </div>

      <div class="card step" data-done="${allPrepared ? "yes" : "no"}">
        <div class="step-number">3</div>
        <div class="step-body" id="prepare-step"></div>
      </div>

      ${state.pairing ? `<div class="card step" data-done="${(state.pairing.pairs || []).length ? "yes" : "no"}">
        <div class="step-number">✚</div>
        <div class="step-body" id="pairs-step"></div>
      </div>` : ""}

      <div class="card step" data-done="${started ? "yes" : "no"}" data-active="${!started && preparedSubjects > 0 ? "yes" : "no"}">
        <div class="step-number">4</div>
        <div class="step-body" id="run-step"></div>
      </div>

      ${started ? `<div class="card step" data-active="yes"><div class="step-number">5</div><div class="step-body" id="results-step"></div></div>` : ""}
    </div>`);

  node.getElementById("files-step").replaceChildren(filesStep(started));
  node.getElementById("prepare-step").replaceChildren(prepareStep(started));
  if (state.pairing) node.getElementById("pairs-step").replaceChildren(pairsStep(started));
  node.getElementById("run-step").replaceChildren(runStep(preparedSubjects, allPrepared, started));
  if (started) node.getElementById("results-step").replaceChildren(resultsStep());
  return node;
}

const stageWords = (stage) => ({
  collecting: "collecting files", preparing: "preparing material", ready: "ready to run",
  planning: "planning the work", reading: "reading", deciding: "deciding",
  finished: "finished", cancelled: "stopped", failed: "ended with an error",
  needs_a_person: "needs a person",
}[stage] || stage);

/* ── step 2: the files ───────────────────────────────────────────────── */

function filesStep(started) {
  const { run, files } = state.open;
  const node = h(`
    <div>
      <p class="eyebrow">Step 2</p>
      <h2>Your files</h2>
      ${started ? `<p class="muted">This analysis has been run, so its material is settled. Adding or
        replacing a file now would change the evidence under a result that already exists — start a
        second analysis instead.</p>` : `
      <p class="muted">What is accepted, and the limits, before you pick anything:</p>
      <div class="formats">
        ${Object.values(KINDS).map((k) => `
          <div class="format">
            <div><strong>${esc(k.name)}</strong><small>${esc(k.detail)}</small></div>
            <div class="faint" style="text-align:right;white-space:nowrap">up to ${esc(humanBytes(k.maximumBytes))}<br>${esc(String(k.maximumParts))} ${esc(k.partWord)}</div>
          </div>`).join("")}
      </div>
      <div class="row" style="margin-bottom:12px">
        ${Object.values(KINDS).map((k) => `<button type="button" data-add="${esc(k.kind)}">Add ${esc(k.name.toLowerCase())}</button>`).join("")}
      </div>
      <p class="faint">Up to ${MAXIMUM_FILES} files in one analysis. Large files upload straight to
      storage and resume where they stopped — closing this tab does not lose an upload.</p>
      <input type="file" id="picker" hidden>`}
      <div class="filelist" id="filelist"></div>
    </div>`);

  const cards = files.map((f) => fileCard(f, started));
  if (state.pending) cards.unshift(pendingCard(state.pending));
  node.getElementById("filelist").replaceChildren(...cards);

  if (!started) {
    const picker = node.getElementById("picker");
    node.querySelectorAll("[data-add]").forEach((button) => {
      button.addEventListener("click", () => {
        const kind = button.getAttribute("data-add");
        picker.value = "";
        picker.accept = KINDS[kind].accept;
        picker.onchange = async () => {
          const file = picker.files?.[0];
          if (!file) return;
          await addFile(run.id, kind, file);
        };
        picker.click();
      });
    });
  }
  return node;
}

function fileCard(file, started) {
  const busy = state.busy.get(file.id);
  const tone = file.upload_state === "failed" || file.preparation_state === "failed" ? "bad"
    : file.preparation_state === "prepared" ? "good"
    : file.upload_state === "stored" ? "open" : "";
  const said = busy
    ? busy.phase === "uploading" ? `uploading ${humanBytes(busy.sent)} of ${humanBytes(busy.total)}`
      : busy.phase === "identifying" ? "identifying the file"
      : busy.what || "preparing"
    : file.upload_state !== "stored" ? file.upload_state
    : file.preparation_state === "prepared" ? `${file.prepared_units} of ${file.total_units} ${KINDS[file.kind]?.partWord || "pieces"} prepared`
    : file.preparation_state === "preparing" ? "preparing"
    : "stored, not prepared yet";

  const fraction = busy?.total ? Math.min(1, busy.sent / busy.total)
    : file.total_units ? file.prepared_units / file.total_units
    : file.upload_state === "stored" ? 1 : 0;

  const probe = file.probe || {};
  const node = h(`
    <div class="file">
      <div class="file-head">
        <strong>${esc(file.file_name)}</strong>
        <span class="pill" data-tone="${esc(tone)}">${esc(KINDS[file.kind]?.name || file.kind)}</span>
        <span class="faint">${esc(humanBytes(file.byte_size))}</span>
        <span class="spacer" style="flex:1"></span>
        ${!started && file.upload_state !== "uploading" ? `<button class="quiet danger" data-remove="${esc(file.id)}" type="button">Remove</button>` : ""}
      </div>
      <div class="bar"><i style="width:${Math.round(fraction * 100)}%"></i></div>
      <div class="faint">${esc(said)}</div>
      ${probe.pages ? `<div class="faint">${esc(String(probe.pages))} pages, every one of them read.</div>` : ""}
      ${probe.durationSeconds ? `<div class="faint">${esc(coverageSentence(probe.durationSeconds, probe.momentsRead || []))}</div>` : ""}
      ${probe.momentsRead?.length ? `<details class="faint"><summary>Which moments were read</summary><p class="mono">${probe.momentsRead.map((m) => esc(clock(m.seconds))).join(" · ")}</p></details>` : ""}
      ${file.last_error ? `<div class="refusal">${esc(file.last_error)}</div>` : ""}
    </div>`);

  node.querySelector("[data-remove]")?.addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    try {
      await state.record.removeFile(state.open.run.id, file.id);
      await refreshOpen(state.open.run.id);
      render();
    } catch (error) { say(error.message); }
  });
  return node;
}

async function addFile(analysisId, kind, file) {
  /* The row does not exist until the record has written it, so what is drawn
     while the first bytes move is this: the file the person picked, and how
     far it has got. It is replaced by the real row on the next read. */
  state.pending = { name: file.name, kind, size: file.size, phase: "uploading", sent: 0, total: file.size };
  paintBusy();
  try {
    const row = await state.record.addFile({
      analysisId, kind, file,
      existingFiles: state.open.files,
      onProgress: (p) => { state.pending = { ...state.pending, ...p }; paintBusy(); },
    });
    state.pending = null;
    /* The bytes are stored; the pieces can be made now, from the file still
       in this browser's hands — no download back. */
    await refreshOpen(analysisId);
    const stored = state.open.files.find((f) => f.id === row.id);
    if (stored) await prepareOne(stored, file);
    await refreshOpen(analysisId);
    render();
  } catch (error) {
    state.pending = null;
    state.busy.clear();
    await refreshOpen(analysisId);
    say(error.message);
  }
}

/* A cheap repaint while a big file is moving: replacing the whole screen on
   every chunk would fight the file picker and lose scroll position. */
function paintBusy() {
  const list = screen.querySelector("#filelist");
  if (!list || !state.open) return;
  const cards = state.open.files.map((f) => fileCard(f, !!state.open.run.workflow_id));
  if (state.pending) cards.unshift(pendingCard(state.pending));
  list.replaceChildren(...cards);
}

function pendingCard(pending) {
  const fraction = pending.total ? Math.min(1, (pending.sent || 0) / pending.total) : 0;
  const said = pending.phase === "identifying" ? "identifying the file"
    : `uploading ${humanBytes(pending.sent || 0)} of ${humanBytes(pending.total || 0)}`;
  return h(`
    <div class="file">
      <div class="file-head">
        <strong>${esc(pending.name)}</strong>
        <span class="pill">${esc(KINDS[pending.kind]?.name || pending.kind)}</span>
        <span class="faint">${esc(humanBytes(pending.size))}</span>
      </div>
      <div class="bar"><i style="width:${Math.round(fraction * 100)}%"></i></div>
      <div class="faint">${esc(said)}</div>
    </div>`);
}

/* ── step 3: preparation ─────────────────────────────────────────────── */

function prepareStep(started) {
  const { files } = state.open;
  const waiting = files.filter((f) => f.upload_state === "stored" && f.preparation_state !== "prepared");
  const node = h(`
    <div>
      <p class="eyebrow">Step 3</p>
      <h2>Material for the readers</h2>
      <p class="muted">A reader is never handed a whole file. Each page becomes its own image plus
      whatever text the PDF carries; a video becomes a bounded set of frames at exact times. Every
      piece is stored the moment it is made, so this can stop and pick up again.</p>
      <p class="faint">Preparation reads the file in this browser, because a page image needs a canvas
      and a video frame needs a decoder — this deployment has neither on the server. So preparing
      material needs this tab open, and resumes at the first piece that is not yet stored. The
      analysis itself runs on the server and needs no tab open.</p>
      ${files.length === 0 ? `<p class="faint">Nothing to prepare yet.</p>` : ""}
      ${waiting.length && !started ? `
        <div class="notice">
          <strong>${waiting.length} file${waiting.length === 1 ? "" : "s"} still to prepare.</strong>
          <p class="muted" style="margin:6px 0 10px">Pick the same file again and it carries on from the
          first piece that is not yet stored.</p>
          <input type="file" id="reprepare-picker" hidden>
          <div class="row" id="reprepare"></div>
        </div>` : ""}
      ${files.length && !waiting.length ? `<p class="faint">Every file is prepared.</p>` : ""}
    </div>`);

  const picker = node.getElementById("reprepare-picker");
  const row = node.getElementById("reprepare");
  if (row) {
    for (const file of waiting) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `Prepare ${file.file_name}`;
      button.addEventListener("click", () => {
        picker.value = "";
        picker.accept = KINDS[file.kind]?.accept || "";
        picker.onchange = async () => {
          const picked = picker.files?.[0];
          if (!picked) return;
          if (picked.size !== Number(file.byte_size)) {
            say(`That is a different file: ${file.file_name} is ${humanBytes(file.byte_size)} and this one is ${humanBytes(picked.size)}. Preparation has to read the same bytes that were uploaded.`);
            return;
          }
          await prepareOne(file, picked);
          await refreshOpen(state.open.run.id);
          render();
        };
        picker.click();
      });
      row.appendChild(button);
    }
  }
  return node;
}

async function prepareOne(fileRow, source) {
  try {
    await state.record.setState(state.open.run.id, "preparing");
    await state.record.prepareFile({
      analysisId: state.open.run.id,
      fileRow, source,
      onProgress: (p) => { state.busy.set(fileRow.id, p); paintBusy(); },
    });
    state.busy.delete(fileRow.id);
    await state.record.setState(state.open.run.id, "ready");
  } catch (error) {
    state.busy.delete(fileRow.id);
    say(error.message);
  }
}


/* ── what will be compared with what ─────────────────────────────────── */

/* A COMPARISON NEEDS TWO PIECES OF MATERIAL, AND SOMETHING HAS TO SAY WHICH.
 *
 * Most of the time the sheets do: a sheet carries its own number and names the
 * sheets it refers to, and that is a correspondence nobody had to invent.
 * Nothing in a video frame says which sheet it belongs to, so that one is
 * asked here — and where it is not answered, the place is shown as needing a
 * check rather than paired with a guess. */
function pairsStep(started) {
  const pairing = state.pairing || {};
  const pairs = pairing.pairs || [];
  const unpaired = pairing.unpaired || [];
  const pages = pairing.pages || [];
  const clips = pairing.clips || [];
  const kind = state.open.run.question_kind;

  const node = h(`
    <div>
      <p class="eyebrow">Before you run</p>
      <h2>What will be compared</h2>
      <p class="muted">${esc(kind === "plan_consistency"
        ? "Each pair below is read by two independent readers, together, and they are asked whether the two sheets agree."
        : "Each sampled moment below is read against a plan sheet by two independent readers, and they are asked whether what is visible matches what the sheet calls for.")}</p>
      ${pairs.length ? `
        <div class="filelist" style="margin-bottom:12px">
          ${pairs.map((p) => `<div class="file"><div class="file-head"><strong>${esc(p.label)}</strong></div>
            <div class="faint">${esc(p.why)}</div></div>`).join("")}
        </div>` : `<div class="notice" style="margin-bottom:12px"><strong>Nothing is paired yet.</strong>
          <p class="muted" style="margin:6px 0 0">${esc(pairing.note || "")}</p></div>`}

      ${unpaired.length ? `<div class="refusal" style="margin-bottom:12px">
        <strong>${unpaired.length} place${unpaired.length === 1 ? " has" : "s have"} nothing to be compared with.</strong>
        ${unpaired.slice(0, 4).map((u) => `<p class="muted" style="margin:6px 0 0">${esc(u.label)} — ${esc(u.question)}</p>`).join("")}
        <p class="faint" style="margin:8px 0 0">Unpaired places are shown in the result under “Needs a check”. Nothing is compared by guesswork.</p>
      </div>` : ""}

      ${started || pairing.settled ? `<p class="faint">This analysis has been run, so what it compares is settled.</p>` : `
        ${kind === "video_against_plans" ? `
          <label class="field"><span>Which sheets should each clip be read against?</span>
            <select id="pair-clip">${clips.map((c) => `<option value="${esc(c.file)}">${esc(c.label)} — ${esc(c.moments)} moments</option>`).join("")}</select>
          </label>
          <div class="choices" id="pair-pages">
            ${pages.map((p) => `<label class="choice"><input type="checkbox" value="${esc(p.file)}:${esc(p.ordinal)}"><span><strong>${esc(p.label)}</strong></span></label>`).join("")}
          </div>
          <button class="primary" id="pair-save" type="button">Use these sheets for this clip</button>` : `
          <div class="row" style="align-items:flex-end">
            <label class="field" style="flex:1"><span>Compare this sheet</span>
              <select id="pair-a">${pages.map((p) => `<option value="${esc(p.file)}:${esc(p.ordinal)}">${esc(p.label)}</option>`).join("")}</select></label>
            <label class="field" style="flex:1"><span>with this one</span>
              <select id="pair-b">${pages.map((p) => `<option value="${esc(p.file)}:${esc(p.ordinal)}">${esc(p.label)}</option>`).join("")}</select></label>
            <button class="primary" id="pair-add" type="button" style="margin-bottom:12px">Add this pair</button>
          </div>`}
        <p class="faint">What you choose is kept with the analysis and is closed the moment you run it — a result may not
        be left standing on a question nobody asked.</p>`}
    </div>`);

  const place = (value) => {
    const [file, ordinal] = String(value).split(":").map(Number);
    return { file, ordinal };
  };
  const saveChosen = async (chosen) => {
    const { error } = await client.from("analysis_runs").update({ pairing: chosen }).eq("id", state.open.run.id);
    if (error) { say(error.message); return; }
    await refreshOpen(state.open.run.id);
    render();
  };

  node.querySelector("#pair-add")?.addEventListener("click", async () => {
    const a = place(screen.querySelector("#pair-a").value);
    const b = place(screen.querySelector("#pair-b").value);
    if (a.file === b.file && a.ordinal === b.ordinal) { say("A sheet cannot be compared with itself."); return; }
    const chosen = { ...(pairing.chosen || {}) };
    chosen.pagePairs = [...(chosen.pagePairs || []), { a, b }];
    await saveChosen(chosen);
  });
  node.querySelector("#pair-save")?.addEventListener("click", async () => {
    const file = Number(screen.querySelector("#pair-clip").value);
    const wanted = [...screen.querySelectorAll("#pair-pages input:checked")].map((box) => place(box.value));
    if (!wanted.length) { say("Choose at least one sheet, or leave it and every moment will be shown as needing a check."); return; }
    const chosen = { ...(pairing.chosen || {}) };
    chosen.momentPages = [...(chosen.momentPages || []).filter((m) => m.file !== file), { file, pages: wanted }];
    await saveChosen(chosen);
  });
  return node;
}

/* ── step 4: the press ───────────────────────────────────────────────── */

function runStep(preparedSubjects, allPrepared, started) {
  if (started) return runningStep();

  const node = h(`
    <div>
      <p class="eyebrow">Step 4</p>
      <h2>Run the analysis</h2>
      ${preparedSubjects === 0
        ? `<p class="muted">Nothing has been prepared to read yet. Add a file and prepare it first.</p>`
        : `<p class="muted">${preparedSubjects} place${preparedSubjects === 1 ? "" : "s"} to read
           — every page of every PDF and every sampled moment of every clip. Each is read twice,
           independently, and checked against the source.</p>
           <div id="quote" class="notice" style="margin-bottom:12px">Working out what this could cost…</div>
           <label class="field" style="max-width:260px"><span>Authorise up to (USD)</span>
             <input id="authorized" type="number" min="0.01" step="0.5" value="5"></label>
           <div class="row">
             <button class="primary" id="press" type="button" ${allPrepared ? "" : "disabled"}>Run analysis</button>
             ${allPrepared ? "" : `<span class="faint">Finish preparing every file first.</span>`}
           </div>
           <p class="faint" style="margin-top:10px">Real AI calls start on the server after this press,
           never before it, and never from this browser. Nothing may spend past the amount above.</p>`}
    </div>`);

  if (preparedSubjects > 0) {
    call("estimate", { analysisId: state.open.run.id }).then((estimate) => {
      const box = screen.querySelector("#quote");
      if (!box) return;
      box.innerHTML = `
        <strong>At most $${esc(Number(estimate.worstUsd).toFixed(2))}</strong>
        <p class="muted" style="margin:6px 0 0">${esc(estimate.subjects)} places to read ·
        ${esc(estimate.readerAttempts)} independent readings · up to ${esc(estimate.criticAttempts)} checks
        against the source. ${esc(estimate.note)}. One analysis may be authorised at most
        $${esc(String(estimate.ceilingUsd))}.</p>`;
      const field = screen.querySelector("#authorized");
      if (field) field.value = Math.min(estimate.ceilingUsd, Math.max(1, Math.ceil(Number(estimate.worstUsd) || 1)));
    }).catch((error) => {
      const box = screen.querySelector("#quote");
      if (box) box.textContent = error.message;
    });

    node.querySelector("#press")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = "Starting…";
      try {
        await call("run", {
          analysisId: state.open.run.id,
          authorizedUsd: Number(screen.querySelector("#authorized").value),
        });
        await refreshOpen(state.open.run.id);
        render();
        maybePoll();
      } catch (error) {
        button.disabled = false;
        button.textContent = "Run analysis";
        say(error.message);
      }
    });
  }
  return node;
}

function runningStep() {
  const status = state.status || {};
  const a = status.assignments || { finished: 0, total: 0, running: 0, waiting: 0 };
  const material = status.materialPrepared || {};
  const finished = ["finished", "cancelled", "failed"].includes(status.stage);
  const node = h(`
    <div>
      <p class="eyebrow">Step 4</p>
      <h2>${esc(finished ? "The run" : "Running")}</h2>
      <p class="muted">${esc(stageSentence(status))}</p>
      <div class="counts">
        <div class="count"><strong>${a.finished}<span style="color:var(--ink-faint);font-size:15px"> / ${a.total}</span></strong><span>assignments finished</span></div>
        <div class="count"><strong>${a.running}</strong><span>being read now</span></div>
        <div class="count"><strong>${a.waiting}</strong><span>still waiting</span></div>
        <div class="count"><strong>${(material.pdf_page_image || 0) + (material.video_frame || 0)}</strong><span>places prepared</span></div>
      </div>
      <p class="faint">These are counted rows, not a guess. There is no percentage here because there
      is nothing honest to compute one from.</p>
      ${status.budget ? `<p class="faint">Reserved $${esc(Number(status.budget.reserved || 0).toFixed(4))},
        settled $${esc(Number(status.budget.settled || 0).toFixed(4))} of $${esc(Number(status.budget.authorized_maximum || 0).toFixed(2))} authorised.
        ${status.budget.stopped_reason ? `Stopped: ${esc(status.budget.stopped_reason)}` : ""}</p>` : ""}
      ${status.problem ? `<div class="refusal" style="margin-top:10px">${esc(status.problem)}</div>` : ""}
      ${status.stage === "needs_a_person" ? `<div class="notice" style="margin-top:10px"><strong>This needs a person.</strong>
        <p class="muted" style="margin:6px 0 0">The engine stopped rather than guess. The reason is above; the readings
        that did finish are below and are still evidence.</p></div>` : ""}
      <div class="row" style="margin-top:12px">
        ${finished ? "" : `<button id="stop" type="button" class="danger">Stop this analysis</button>`}
        <button id="refresh" type="button" class="quiet">Refresh now</button>
        ${status.cancelRequested ? `<span class="pill" data-tone="warn">stop requested</span>` : ""}
      </div>
      <p class="faint" style="margin-top:8px">Closing this page does not stop anything — the work is on the
      server and this screen is rebuilt from its record.</p>
      ${state.open.events.length ? `<div class="ticker">${state.open.events.slice(0, 8).map((e) => `
        <div><time>${esc(new Date(e.at).toLocaleTimeString())}</time><span class="muted">${esc(eventWords(e))}</span></div>`).join("")}</div>` : ""}
    </div>`);

  node.querySelector("#refresh")?.addEventListener("click", async () => {
    await refreshOpen(state.open.run.id); render(); maybePoll();
  });
  node.querySelector("#stop")?.addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    try {
      const answer = await call("cancel", { analysisId: state.open.run.id });
      await refreshOpen(state.open.run.id);
      render();
      say(answer.note || "");
    } catch (error) { say(error.message); }
  });
  return node;
}

function stageSentence(status) {
  const a = status.assignments || {};
  switch (status.stage) {
    case "planning": return "The work is being divided into bounded assignments.";
    case "reading": return "Independent readers are looking at one page or one moment each.";
    case "deciding": return "The readings are being compared and the established rules applied.";
    case "finished": return "Every assignment reached an end.";
    case "cancelled": return "Stopped. No new assignments were given out; anything already sent is shown as it ended.";
    case "failed": return "The run ended with an error rather than a result.";
    case "needs_a_person": return "The engine stopped and asked for a person rather than guessing.";
    default: return `${a.finished || 0} of ${a.total || 0} assignments have finished.`;
  }
}

const eventWords = (e) => ({
  "analysis.created": "Analysis created",
  "file.stored": `Stored ${e.detail?.file ?? "a file"}`,
  "file.prepared": `Prepared ${e.detail?.file ?? "a file"} — ${e.detail?.units ?? "?"} pieces`,
  "file.preparation_failed": `Could not prepare ${e.detail?.file ?? "a file"}: ${e.detail?.problem ?? ""}`,
  "file.removed": "A file was removed",
  run_requested: `Run authorised at $${Number(e.detail?.authorizedUsd ?? 0).toFixed(2)}`,
  cancel_requested: "Stop requested",
}[e.kind] || e.kind);

/* ── step 5: what was found ──────────────────────────────────────────── */

function resultsStep() {
  const results = state.results;
  if (!results || !results.started) return h(`<div><p class="eyebrow">Step 5</p><h2>What was found</h2><p class="muted">Nothing yet.</p></div>`);
  const counts = results.counts || {};
  const node = h(`
    <div>
      <p class="eyebrow">Step 5</p>
      <h2>What was found</h2>
      <p class="muted">One place appears in one section. A card opens on the individual readings and
      on the page or the moment they came from.</p>
      <div class="sections">
        ${section("confirmed", "Confirmed", counts.confirmed,
          "Two independent readers said the same thing about the same place, and nothing contradicted it.")}
        ${section("discrepancy", "Discrepancy found", counts.discrepancy,
          "Two readers differ, or a reviewer went back to the source and read otherwise. Both are kept.")}
        ${section("needsCheck", "Needs a check", counts.needsCheck,
          "Not decided. A page nobody could read, a reading nobody corroborated, or an answer of “unclear”. This is not a failure — it is the part a person should look at.")}
      </div>
    </div>`);

  for (const kind of ["confirmed", "discrepancy", "needsCheck"]) {
    const holder = node.querySelector(`.section[data-kind="${kind}"] .findings`);
    const list = (results.sections?.[kind] || []);
    if (!list.length) { holder.replaceChildren(h(`<p class="faint">Nothing in this section.</p>`)); continue; }
    holder.replaceChildren(...list.map((subject) => findingCard(subject)));
  }
  return node;
}

function section(kind, title, n, explain) {
  return `
    <section class="section" data-kind="${kind}">
      <div class="section-head"><h2>${esc(title)}</h2><span class="n">${esc(String(n ?? 0))}</span></div>
      <p class="faint" style="margin-bottom:8px">${esc(explain)}</p>
      <div class="findings"></div>
    </section>`;
}

function findingCard(subject) {
  const readings = subject.readings || [];
  const reviews = subject.reviews || [];
  const answers = [...new Set(readings.map((r) => answerOf(r)).filter(Boolean))];
  const node = h(`
    <details class="finding">
      <summary>
        <span><span class="where">${esc(placeWords(subject.subjectKey))}</span>
          <span class="answer"> — ${esc(answers.length ? answers.join(" / ") : "no reading was recorded")}</span></span>
        <span class="pill" data-tone="${esc({ confirmed: "good", discrepancy: "warn", needsCheck: "open" }[subject.section])}">${esc(readings.length)} reading${readings.length === 1 ? "" : "s"}</span>
      </summary>
      <div class="inside">
        ${readings.map((r) => `
          <div class="reading">
            <b>${esc(r.executor || r.role || "a reader")}</b>
            <span class="faint"> · ${esc(r.role || "")}${r.model ? ` · ${esc(r.model)}` : ""}</span>
            <div>Answer: <b>${esc(answerOf(r) || "—")}</b> <span class="faint">(${esc(r.status)})</span></div>
            ${(r.anchors || []).map((a) => `
              ${a.quotedText ? `<p class="quote">“${esc(a.quotedText)}”</p>` : ""}
              ${a.contentHash ? `<button type="button" class="quiet" data-evidence="${esc(a.contentHash)}" data-region="${esc(JSON.stringify(a.locator?.bbox ?? null))}">Open the evidence →</button>` : ""}
            `).join("")}
          </div>`).join("")}
        ${reviews.length ? `<div class="details"><h3>Checked against the source</h3>
          ${reviews.map((v) => `<p class="muted">${esc(v.executor || v.role || "a reviewer")}: <b>${esc(v.verdict)}</b>
            ${v.explanation ? ` — ${esc(v.explanation)}` : ""} <span class="faint">(${esc(v.reasonCode)})</span></p>`).join("")}
        </div>` : ""}
        ${(subject.decisions || []).length ? `<div class="details"><h3>Decision</h3>
          ${subject.decisions.map((d) => `<p class="muted"><b>${esc(d.title)}</b> — ${esc(d.type)}, by ${esc(d.authority)}
            ${d.rationale ? `<br><span class="faint">${esc(d.rationale)}</span>` : ""}</p>`).join("")}
        </div>` : ""}
        ${(subject.problems || []).length ? `<div class="details"><h3>What went wrong here</h3>
          ${subject.problems.map((p) => `<p class="muted">${esc(p)}</p>`).join("")}</div>` : ""}
        <details class="details"><summary class="faint">Technical detail</summary>
          <p class="mono">subject ${esc(subject.subjectKey)} · task states ${esc((subject.taskStates || []).join(", ") || "—")}</p>
          ${readings.map((r) => `<p class="mono">claim ${esc(r.claimId)} · ${esc(r.independenceDomain || "domain unknown")} · role ${esc(r.role || "?")} ${esc(r.roleVersion || "")}</p>`).join("")}
        </details>
      </div>
    </details>`);

  node.querySelectorAll("[data-evidence]").forEach((button) =>
    button.addEventListener("click", () => {
      let region = null;
      try { region = JSON.parse(button.getAttribute("data-region") || "null"); } catch { region = null; }
      openEvidence(button.getAttribute("data-evidence"), region);
    }));
  return node;
}

const answerOf = (reading) => {
  const value = reading.value || {};
  const said = value.text ?? value.known ?? "";
  return String(said || "").trim();
};

function placeWords(subjectKey) {
  const parts = String(subjectKey || "").split("/");
  /* A comparison names two places, and the card is titled by both — a person
     looking for "the sheet that disagrees with the schedule" is looking for
     the pair, not for one half of it. */
  if (parts[0] === "pages" && parts.length >= 5) {
    return `${placeWords(`page/${parts[1]}/${parts[2]}`)}  vs  ${placeWords(`page/${parts[3]}/${parts[4]}`)}`;
  }
  if (parts[0] === "moment" && parts[3] === "page" && parts.length >= 6) {
    return `${placeWords(`moment/${parts[1]}/${parts[2]}`)}  vs  ${placeWords(`page/${parts[4]}/${parts[5]}`)}`;
  }
  const [kind, fileOrdinal, ordinal] = parts;
  const file = (state.open?.files || []).find((f) => String(f.ordinal) === String(fileOrdinal));
  const name = file?.file_name || `file ${fileOrdinal}`;
  if (kind === "page") return `${name}, page ${ordinal}`;
  if (kind === "moment") {
    const part = (file?.parts || []).find((p) => p.part_kind === "video_frame" && String(p.ordinal) === String(ordinal));
    const seconds = part?.locator?.seconds;
    return `${name} at ${seconds === undefined ? `moment ${ordinal}` : clock(seconds)}`;
  }
  return subjectKey;
}

/* ── the evidence ────────────────────────────────────────────────────── */

async function openEvidence(contentHash, region) {
  let found;
  try {
    found = await call("evidence", { analysisId: state.open.run.id, contentHash });
  } catch (error) { say(error.message); return; }

  /* A 360 clip opens in the Studio's own equirectangular viewer, at the second
     the frame came from. The DIRECTION is not set, because nothing in this
     analysis established one and pointing the camera somewhere would be
     inventing a fact. */
  if (found.fileKind === "video360" || found.fileKind === "video") {
    const file = state.open.files.find((f) => f.ordinal === found.fileOrdinal);
    const original = file ? await signedOriginal(file) : null;
    if (original && window.MDAIPano360) {
      const at = Number(found.locator?.seconds ?? 0);
      window.MDAIPano360.open({
        src: original,
        mediaType: file.media_type,
        title: found.where,
        subtitle: found.fileKind === "video360"
          ? "Opened at the second this frame came from. The direction is not set: this analysis established a moment, not a bearing."
          : "Opened at the second this frame came from.",
        spatial: found.fileKind === "video360",
        trim: { applied: true, start: Math.max(0, at - 0.5), end: at + 6 },
      });
      return;
    }
  }
  showStill(found, region);
}

async function signedOriginal(file) {
  const { data, error } = await client.storage
    .from(config.storageBucket || "property-evidence")
    .createSignedUrl(file.storage_path, 900);
  if (error) { say(error.message); return null; }
  return data?.signedUrl ?? null;
}

function showStill(found, region) {
  /* The region a reading actually named, in the kernel's own geometry: four
     numbers normalised against this very image. A finding with no box is
     shown without one rather than with a guessed one. */
  const box = Array.isArray(region) && region.length === 4 ? region
    : Array.isArray(found.locator?.bbox) && found.locator.bbox.length === 4 ? null
    : null;
  const overlay = box
    ? `<div class="evidence-box" style="left:${box[0] * 100}%;top:${box[1] * 100}%;width:${(box[2] - box[0]) * 100}%;height:${(box[3] - box[1]) * 100}%"></div>`
    : "";
  const node = h(`
    <div class="evidence-backdrop">
      <div class="evidence-panel">
        <div class="row"><strong>${esc(found.where)}</strong><span class="spacer" style="flex:1"></span>
          <button type="button" id="close-evidence">Close</button></div>
        <p class="faint">This is the exact material the reader was given — not a re-render.</p>
        <div class="evidence-frame">
          ${found.url ? `<img src="${esc(found.url)}" alt="${esc(found.where)}">${overlay}` : `<p class="muted">This piece is text, not a picture.</p>`}
        </div>
        ${found.text ? `<div class="details"><h3>Text this page carried</h3><p class="mono">${esc(found.text.slice(0, 2000))}</p></div>` : ""}
        <details class="details"><summary class="faint">Technical detail</summary>
          <p class="mono">${esc(found.partKind)} · ${esc(JSON.stringify(found.locator))}</p></details>
      </div>
    </div>`);
  const backdrop = node.firstElementChild;
  document.body.appendChild(backdrop);
  const close = () => backdrop.remove();
  backdrop.querySelector("#close-evidence").addEventListener("click", close);
  backdrop.addEventListener("click", (event) => { if (event.target === backdrop) close(); });
  document.addEventListener("keydown", function escape(event) {
    if (event.key === "Escape") { close(); document.removeEventListener("keydown", escape); }
  });
}

boot().catch((error) => {
  screen.replaceChildren(h(`<div class="card refusal"><strong>This page could not start.</strong><p class="mono">${esc(error?.message || error)}</p></div>`));
});
