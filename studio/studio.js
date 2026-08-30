let propertyRecord = {
  id: "private-pilot-property",
  name: "Private Pilot Property",
  city: "Los Angeles",
  state: "CA",
  description: "Los Angeles, California · Spatial evidence record",
  access: "private",
};

const config = window.MDAI_CONFIG || {};
const PASSWORD_RECOVERY_REDIRECT = `${window.location.origin}/studio/?recovery=1`;
const cloud = {
  client:
    window.supabase?.createClient &&
    config.supabaseUrl &&
    config.supabasePublishableKey
      ? window.supabase.createClient(
          config.supabaseUrl,
          config.supabasePublishableKey,
          {
            auth: {
              persistSession: true,
              autoRefreshToken: true,
              detectSessionInUrl: true,
            },
          },
        )
      : null,
  session: null,
  organizationId: null,
  propertyId: null,
  role: null,
  schemaReady: false,
  properties: [],
};

const seedRooms = [
  {
    id: "entrance",
    name: "Entrance",
    building: "Main House",
    level: "Level 1",
    status: "needs",
    note: "",
    evidence: [],
    visible: [],
    unknown: ["Evidence has not been uploaded or reviewed"],
  },
  {
    id: "formal-living",
    name: "Formal Living",
    building: "Main House",
    level: "Level 1",
    status: "needs",
    note: "",
    evidence: [],
    visible: [],
    unknown: ["Evidence has not been uploaded or reviewed"],
  },
];

const STORAGE_KEY = "mdai-spatial-studio-v2";
const JOBS_KEY = "mdai-studio-jobs-v1";
let rooms = loadRooms();
let jobs = loadJobs();
/* Stitching happens on a machine nobody can see. Without this the Studio says
   "no playable export yet" for twenty minutes and gives no sign of life, which
   is indistinguishable from something being broken. */
let stitchJobs = [];
let stitchPollTimer = null;
/* What the stitching machine last said about itself. null means it has not been
   read yet or the record cannot answer; machineRunLoaded separates those two, so
   the Studio never reports silence it did not actually observe. */
let machineRun = null;
let machineRunLoaded = false;
let activeRoomId = rooms[0]?.id;
let pendingFiles = [];
let editingEvidenceId = null;
let deletingEvidenceId = null;
let editingSpaceId = null;
let deletingSpaceId = null;
let activeEvidenceId = null;
let visionRelease = null;
let approvedVisionRelease = null;
let objectUrls = [];
let fileDatabase;
const analysisRoomsInFlight = new Set();

const $ = (selector) => document.querySelector(selector);
const elements = {
  gate: $("#prototype-gate"),
  propertyGate: $("#property-gate"),
  focusStudio: $("#focus-studio"),
  shell: $("#app-shell"),
  propertyDirectory: $("#property-directory"),
  roomList: $("#room-list"),
  title: $("#room-title"),
  level: $("#room-level"),
  count: $("#room-evidence-count"),
  image: $("#evidence-image"),
  video: $("#evidence-video"),
  document: $("#document-preview"),
  documentName: $("#document-name"),
  documentOpen: $("#document-open"),
  strip: $("#evidence-strip"),
  type: $("#evidence-type"),
  sourceName: $("#source-name"),
  sourceDate: $("#source-date"),
  sourceSubject: $("#source-subject"),
  sourceStatus: $("#source-status"),
  visible: $("#visible-observations"),
  unknown: $("#unknown-observations"),
  analysisSummary: $("#ai-result-summary"),
  analysisSummaryText: $("#ai-summary"),
  analysisQuality: $("#ai-capture-quality"),
  followUpBlock: $("#follow-up-block"),
  followUp: $("#follow-up-captures"),
  note: $("#review-note"),
  badge: $("#review-badge"),
  toast: $("#toast"),
  autosave: $("#autosave-status"),
  authForm: $("#auth-form"),
  authMessage: $("#auth-message"),
  accountSecurityDialog: $("#account-security-dialog"),
  accountSecurityForm: $("#account-security-form"),
  accountSecurityMessage: $("#account-security-message"),
  roomDialog: $("#room-dialog"),
  editSpaceDialog: $("#edit-space-dialog"),
  deleteSpaceDialog: $("#delete-space-dialog"),
  uploadDialog: $("#upload-dialog"),
  editEvidenceDialog: $("#edit-evidence-dialog"),
  deleteEvidenceDialog: $("#delete-evidence-dialog"),
  fileUpload: $("#file-upload"),
  intakeUpload: $("#file-upload-intake"),
  uploadRoom: $("#upload-room"),
  editEvidenceRoom: $("#edit-evidence-room"),
  lightbox: $("#lightbox"),
};
let accountSecurityMode = "set";

function isVideo(item) {
  return Boolean(
    item?.mimeType?.startsWith("video/") ||
      /\.(mp4|mov|m4v|webm)$/i.test(item?.name || ""),
  );
}

function isImage(item) {
  return Boolean(
    item?.mimeType?.startsWith("image/") ||
      /\.(jpe?g|png|gif|webp|heic|heif)$/i.test(item?.name || ""),
  );
}

function insta360CaptureKey(item) {
  if (item?.sourceMetadata?.insta360?.capture_key) return item.sourceMetadata.insta360.capture_key;
  const match = String(item?.name || "").toLowerCase().match(/^(.*)_(00|10)_([0-9]+)\.insv$/i);
  return match ? `${match[1]}_${match[3]}` : null;
}

/* A dual-lens capture is two files and one thing, so the two are shown as one
   tile. The grouping used to be by capture key alone, across the whole project.
 *
 * That made the same capture uploaded to a second room disappear from it. The
 * two rooms' files collapsed into a single tile, and the tile inherited the
 * room of sources[0] — the oldest row, because the query orders by created_at.
 * The newly uploaded files were in the database with the right room on them,
 * and the screen showed the room they belonged to as empty. Which is exactly
 * what "I uploaded two files into Hallway 200A and it says the room is empty"
 * looks like from the outside.
 *
 * A capture belongs to a room. Grouping is per room, so the same capture in two
 * rooms is two tiles, and a pair accidentally split across rooms shows as two
 * incomplete captures — which is true, and findable, instead of one of them
 * silently vanishing into the other room. */
/* Which room a file is in.
 *
 * This used to be asked by scanning every room for one that contained the
 * object — rooms.find(room => room.evidence.includes(item)) — which is not a
 * question about the record but a question about JavaScript object identity.
 * It gives the wrong answer whenever the tile is not the row: a dual-lens
 * capture is a synthetic tile standing for two files, and a list rebuilt after
 * any change is a different set of objects entirely.
 *
 * The room travels on the item. Every place that needs it reads it from there,
 * and nowhere works it out again. */
/* The tile that stands for a given evidence id.
 *
 * A dual-lens capture is one tile carrying two source ids, so "the row" and
 * "the thing on screen" are not the same object, and every caller that wanted
 * one from the other wrote its own scan. There were two, and they disagreed:
 * one searched the whole project, the other only the room it had already
 * guessed at. */
function tileFor(evidenceId) {
  if (!evidenceId) return { item: null, room: null };
  for (const room of rooms) {
    const item = (room.evidence || []).find(
      (entry) => entry.id === evidenceId || (entry.sourceIds || []).includes(evidenceId),
    );
    if (item) return { item, room };
  }
  return { item: null, room: null };
}

function roomOf(item) {
  if (!item) return null;
  if (item.spaceId) return rooms.find((room) => room.id === item.spaceId) || null;
  /* A file the record has not placed in a room. Saying null is the truthful
     answer; guessing which room it looks like it belongs to is how evidence
     ends up filed somewhere nobody chose. */
  return null;
}

function collapseInsta360Sources(items) {
  const grouped = new Map();
  const ordinary = [];
  items.forEach((item) => {
    const key = insta360CaptureKey(item);
    if (!key) { ordinary.push(item); return; }
    const roomKey = `${item.spaceId || "unfiled"}|${key}`;
    if (!grouped.has(roomKey)) grouped.set(roomKey, []);
    grouped.get(roomKey).push(item);
  });
  grouped.forEach((sources, roomKey) => {
    const key = roomKey.slice(roomKey.indexOf("|") + 1);
    const clip = key.split("_").pop();
    const paired = sources.length >= 2;
    ordinary.push({
      ...sources[0],
      src: "",
      name: `360 capture ${clip || ""}`.trim(),
      type: "360 capture",
      mimeType: "application/x-insta360-capture",
      sourceIds: sources.map((source) => source.id),
      /* The filenames behind the tile. The tile renames itself "360 capture
         016", and anything asking "is this file already here?" — the upload
         gate — needs the real names, not the display one. */
      sourceNames: sources.map((source) => source.name),
      sourceMetadata: { ...sources[0].sourceMetadata, insta360_capture_key: key },
      status: paired ? "Original pair verified · VR processing prepared" : "Waiting for the matching camera original",
    });
  });
  return ordinary;
}

function waitForMediaEvent(target, eventName, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let timeout = null;
    function cleanup() {
      clearTimeout(timeout);
      target.removeEventListener(eventName, onSuccess);
      target.removeEventListener("error", onError);
    }
    function onSuccess() {
      cleanup();
      resolve();
    }
    function onError() {
      cleanup();
      reject(new Error("The video could not be decoded for AI keyframes"));
    }
    timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out while preparing video ${eventName}`));
    }, timeoutMs);
    target.addEventListener(eventName, onSuccess, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

async function extractVideoFrames(item, frameLimit = 4) {
  /* These used to be silent returns: no frames, no reason, no warning. The
     caller then sent an empty request and the server refused it, and what a
     person saw was the word "Failed". A reason nobody can read is not a
     reason. */
  if (!isVideo(item)) throw new Error("This file is not a video");
  if (frameLimit < 1) throw new Error("No frames were requested");
  const source = await freshEvidenceSrc(item);
  if (!source) throw new Error("The link to this file could not be renewed");
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  video.src = source;
  try {
    if (video.readyState < 1) {
      try {
        await waitForMediaEvent(video, "loadedmetadata");
      } catch (error) {
        /* The one failure worth retrying rather than reporting. A signature can
           expire between the check above and this fetch, and a person should
           never be told to reload a page to fix that. */
        const renewed = await freshEvidenceSrc(item, { force: true });
        if (!renewed || renewed === source) throw error;
        video.src = renewed;
        await waitForMediaEvent(video, "loadedmetadata");
      }
    }
    const duration = Number(video.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("The video duration is unavailable");
    }
    /* The head and tail of a 360 walkthrough are the operator leaving and
       returning. Reading them as evidence produces findings about a doorway
       and a person, not about the space. */
    const trim = evidenceTrimWindow(item, duration);
    const windowStart = trim?.applied ? Math.max(0, trim.start_seconds) : 0;
    const windowEnd = trim?.applied ? Math.min(duration, trim.end_seconds) : duration;
    const windowSpan = Math.max(0.2, windowEnd - windowStart);
    const positions = [0.1, 0.35, 0.6, 0.85].slice(0, frameLimit);
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 960 / Math.max(1, video.videoWidth));
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Video frame capture is unavailable");

    const frames = [];
    for (const position of positions) {
      const timestamp = Math.min(
        Math.max(0.05, windowStart + windowSpan * position),
        Math.max(0.05, windowEnd - 0.05),
      );
      if (Math.abs(video.currentTime - timestamp) > 0.02) {
        const frameReady = waitForMediaEvent(video, "seeked");
        video.currentTime = timestamp;
        await frameReady;
      }
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push({
        evidence_id: item.id,
        timestamp_seconds: Number(timestamp.toFixed(2)),
        data_url: canvas.toDataURL("image/jpeg", 0.72),
        /* A spherical frame is the whole room in one picture, so the model can
           say where in it a thing sits — and that position becomes a marker a
           person can look at. A flat frame carries no such direction. */
        equirectangular: focusIsSpatial(item),
      });
    }
    return frames;
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

async function prepareVideoFrames(source) {
  const items = Array.isArray(source) ? source : source?.evidence || [];
  const videos = items.filter(isVideo);
  const frames = [];
  const warnings = [];
  const reasons = [];
  for (const item of videos) {
    if (frames.length >= 8) break;
    try {
      frames.push(...(await extractVideoFrames(item, Math.min(4, 8 - frames.length))));
    } catch (error) {
      console.warn("Video keyframe extraction failed", item.name, error);
      warnings.push(item.name || "Video");
      /* Kept, because "some videos could not be sampled" is not a reason and
         the reason is what somebody needs in order to do anything about it. */
      reasons.push(`${item.name || "Video"}: ${error?.message || "could not be read"}`);
    }
  }
  return { frames, warnings, reasons, videoCount: videos.length };
}

/* Why an analysis is not worth sending, in words, or null when it is.
 *
 * There are two ways into analysis and the first version of this guard was
 * written into one of them. The one that was missed is the one the button
 * actually uses. So it lives here, once, and both call it.
 *
 * The failure it prevents: every video in the room failed to open, the request
 * goes out with an empty frame list, the server refuses it in a tenth of a
 * second, and a person reads the word "Failed". */
function nothingToAnalyse(scope, roomName, prepared) {
  if (prepared.frames.length) return null;
  /* Stills are sent as themselves and need no frame extraction, so a room with
     photographs in it always has something to look at. */
  if ((scope || []).some((item) => isImage(item))) return null;
  if (!prepared.videoCount) return null;
  const count = prepared.videoCount;
  return `None of the ${count} video${count === 1 ? "" : "s"} in ${roomName} could be read, so there was nothing to analyse. ${
    prepared.reasons[0] || "The files could not be opened."
  } Nothing was sent and nothing was changed — press Process with AI again, and if it repeats the file itself may be unreadable.`;
}

function applyAnalysisResult(room, analysis, suggestionId) {
  if (!room || !analysis) return;
  room.analysis = analysis;
  room.suggestionId = suggestionId || room.suggestionId || null;
  room.visible = Array.isArray(analysis.visible_observations)
    ? analysis.visible_observations.map((item) => item.text).filter(Boolean)
    : [];
  room.unknown = Array.isArray(analysis.not_established)
    ? analysis.not_established
        .map((item) =>
          [item.question, item.reason].filter(Boolean).join(" — "),
        )
        .filter(Boolean)
    : [];
  /* An observation the model could point at becomes a point in the sphere, not
     another line of prose. A second run must not wipe a verdict a person
     already gave, nor the markers a person placed by hand. */
  if (window.MDAIMarkers360) {
    const derived = window.MDAIMarkers360.fromAnalysis(analysis, {
      evidenceIds: room.evidence.map((item) => item.id),
    });
    room.markers = window.MDAIMarkers360.merge(room.markers || [], derived);
  }
  room.status = "needs";
  room.evidence.forEach((item) => {
    item.status = "Private cloud original · AI suggestion available";
  });
}

/* --------------------------------------------------- Work, money and documents */

const COSTS_KEY = "mdai-project-costs-v1";
let projectCosts = [];
let tradeOverrides = {};
let costEditor = null;

function costsStorageKey() {
  return `${COSTS_KEY}:${cloud.propertyId || "local"}`;
}

function loadProjectCosts() {
  try {
    const saved = JSON.parse(localStorage.getItem(costsStorageKey())) || {};
    projectCosts = Array.isArray(saved.costs) ? saved.costs : [];
    tradeOverrides = saved.overrides && typeof saved.overrides === "object" ? saved.overrides : {};
  } catch {
    projectCosts = [];
    tradeOverrides = {};
  }
}

function saveProjectCosts(message = "Cost recorded") {
  localStorage.setItem(costsStorageKey(), JSON.stringify({ costs: projectCosts, overrides: tradeOverrides }));
  elements.autosave.textContent = message;
  setTimeout(() => (elements.autosave.textContent = cloud.schemaReady ? `Cloud connected · ${cloud.role}` : "Saved locally"), 1300);
}

/* Money belongs in the record, not in a browser.

   Costs and a person's trade corrections used to live only in localStorage:
   invisible to everyone else on the project, absent from the export, outside
   every audit, and gone with the cache. They are rows now. The browser copy
   survives as the offline path — a person entering figures with no connection
   still keeps them — and anything already sitting there can be moved across in
   one press rather than quietly abandoned. */
let costsAreInTheRecord = false;
let costsWaitingInBrowser = 0;
let strandedCosts = [];

async function hydrateProjectCosts() {
  costsAreInTheRecord = false;
  costsWaitingInBrowser = 0;
  if (!cloud.schemaReady || !cloud.propertyId) return;
  const [{ data: costRows, error: costError }, { data: correctionRows }] = await Promise.all([
    cloud.client.from("project_costs")
      .select("id, trade, amount, currency, invoice_ref, document_evidence_id, note, recorded_at")
      .eq("property_id", cloud.propertyId).eq("state", "active")
      .order("recorded_at", { ascending: true }),
    cloud.client.from("project_trade_corrections")
      .select("observation_key, trade")
      .eq("property_id", cloud.propertyId).eq("state", "active"),
  ]);
  /* A reader who is not allowed to see money gets nothing here, and that is
     the policy working. The screen simply has no ledger to show them. */
  if (costError) return;
  costsAreInTheRecord = true;
  const fromRecord = (costRows || []).map((row) => ({
    id: row.id,
    trade: row.trade,
    amount: row.amount == null ? null : Number(row.amount),
    currency: row.currency || "USD",
    invoice_ref: row.invoice_ref || "",
    document_evidence_id: row.document_evidence_id || "",
    note: row.note || "",
    recorded_at: row.recorded_at,
  }));
  /* Anything still carrying a browser-made id has not reached the record.
     It stays on screen — a figure a person entered does not vanish because
     the record has not got it yet — and it stays movable. */
  strandedCosts = projectCosts.filter((entry) => String(entry.id || "").startsWith("ct-"));
  costsWaitingInBrowser = strandedCosts.length;
  projectCosts = [...fromRecord, ...strandedCosts];
  tradeOverrides = Object.fromEntries((correctionRows || []).map((row) => [row.observation_key, row.trade]));
}

/* One entered figure, written wherever it can be kept. */
async function recordCost(entry) {
  if (cloud.schemaReady && cloud.propertyId) {
    const { error } = await cloud.client.rpc("record_project_cost", {
      p_property_id: cloud.propertyId,
      p_trade: entry.trade,
      p_amount: entry.amount,
      p_currency: entry.currency || "USD",
      p_invoice_ref: entry.invoice_ref || null,
      p_document_evidence_id: entry.document_evidence_id || null,
      p_note: entry.note || null,
    });
    if (!error) return true;
    /* Never silently drop a figure a person typed: if the record refused it,
       the browser still holds it and says so. */
    notify(`Recorded in this browser only — the record refused it: ${error.message}`, "error");
  }
  projectCosts.push({
    id: `ct-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    recorded_at: new Date().toISOString(),
    recorded_by: cloud.session?.user?.email || "",
    currency: "USD",
    invoice_ref: "",
    document_evidence_id: "",
    ...entry,
  });
  return false;
}

/* What is still only in this browser, moved across in one press. */
async function moveBrowserCostsIntoRecord() {
  const stranded = strandedCosts.slice();
  if (!stranded.length) return;
  let moved = 0;
  for (const entry of stranded) {
    const { error } = await cloud.client.rpc("record_project_cost", {
      p_property_id: cloud.propertyId,
      p_trade: entry.trade,
      p_amount: entry.amount ?? null,
      p_currency: entry.currency || "USD",
      p_invoice_ref: entry.invoice_ref || null,
      p_document_evidence_id: entry.document_evidence_id || null,
      p_note: entry.note || null,
    });
    if (!error) {
      moved += 1;
      /* Moved rows leave the browser copy, so a second press cannot enter
         the same figure twice. */
      projectCosts = projectCosts.filter((row) => row.id !== entry.id);
      strandedCosts = strandedCosts.filter((row) => row.id !== entry.id);
    }
  }
  saveProjectCosts("Moving into the record…");
  await hydrateProjectCosts();
  saveProjectCosts(`${moved} moved into the record`);
  renderFocusStudio();
  notify(moved === stranded.length
    ? `${moved} cost${moved === 1 ? "" : "s"} moved into the record — they are part of the project now, not this browser.`
    : `${moved} of ${stranded.length} moved; the rest stay in this browser and can be tried again.`, 6000);
}

function projectCoverage() {
  return window.MDAIMoney360 ? window.MDAIMoney360.coverage(rooms, projectCosts, tradeOverrides) : null;
}

/* The whole point of grouping money by trade: the question is short enough to
   answer standing in the room that prompted it. Never more than a handful, and
   only for work the record actually saw. */
function openMoneyQuestions(preselect = "") {
  const coverage = projectCoverage();
  if (!coverage) return;
  const asking = coverage.questions;
  const list = $("#money-question-list");
  if (!asking.length) {
    list.innerHTML = `<p class="dialog-copy">Every kind of work the record has seen already carries a cost. Nothing to ask.</p>`;
  } else {
    list.innerHTML = asking
      .map(
        (trade) => `<label class="money-question">
          <span class="money-question-head"><b>How much is ${escapeText(trade.label.toLowerCase())}?</b>
          <small>${trade.evidence_count} thing${trade.evidence_count === 1 ? "" : "s"} seen in ${escapeText(trade.spaces.slice(0, 3).join(", "))}${trade.spaces.length > 3 ? " and others" : ""}</small></span>
          <input type="number" min="0" step="1" inputmode="decimal" data-trade="${escapeText(trade.key)}"
            placeholder="Leave empty if not known" ${trade.key === preselect ? "autofocus" : ""}>
        </label>`,
      )
      .join("");
  }
  $("#money-dialog").showModal();
}

function saveMoneyQuestions() {
  const entries = [];
  $("#money-question-list").querySelectorAll("[data-trade]").forEach((input) => {
    const value = input.value.trim();
    if (value === "") return;
    const amount = Number(value);
    if (!Number.isFinite(amount)) return;
    entries.push({ trade: input.dataset.trade, amount, currency: "USD", invoice_ref: "", document_evidence_id: "" });
  });
  $("#money-dialog").close();
  if (!entries.length) return;
  void (async () => {
    let kept = 0;
    for (const entry of entries) {
      if (await recordCost(entry)) kept += 1;
    }
    if (kept) await hydrateProjectCosts();
    saveProjectCosts(`${entries.length} cost${entries.length === 1 ? "" : "s"} recorded`);
    renderFocusStudio();
    notify(kept === entries.length
      ? `${kept} cost${kept === 1 ? "" : "s"} recorded against the work — in the project record, not this browser.`
      : `${entries.length} recorded, ${entries.length - kept} of them in this browser only.`, 5000);
  })();
}

/* One trade, in full: several invoices can sit under it, because that is how
   they arrive. */
function openTradeEditor(tradeKey) {
  const coverage = projectCoverage();
  const trade = coverage?.trades.find((entry) => entry.key === tradeKey);
  if (!trade || !canManageSpaces()) return;
  costEditor = { trade: tradeKey };
  $("#cost-dialog-work").textContent = trade.label;
  $("#cost-amount").value = "";
  $("#cost-invoice").value = "";
  const select = $("#cost-document");
  const files = window.MDAIMoney360.documents(rooms);
  select.innerHTML =
    `<option value="">No document linked</option>` +
    files.map((file) => `<option value="${escapeText(file.id)}">${escapeText(file.name)} · ${escapeText(file.room_name)}</option>`).join("");
  const recorded = $("#cost-recorded");
  recorded.innerHTML = trade.entries.length
    ? `<h4>Already recorded</h4><ul>${trade.entries
        .map(
          (entry) => `<li>${escapeText(window.MDAIMoney360.money(window.MDAIMoney360.amountOf(entry) || 0))}${
            entry.invoice_ref ? ` · ${escapeText(entry.invoice_ref)}` : ""
          } <button type="button" class="mini-button" data-drop-cost="${escapeText(entry.id)}">Remove</button></li>`,
        )
        .join("")}</ul>`
    : "";
  recorded.querySelectorAll("[data-drop-cost]").forEach((button) =>
    button.addEventListener("click", () => {
      projectCosts = projectCosts.filter((entry) => entry.id !== button.dataset.dropCost);
      saveProjectCosts("Cost removed");
      $("#cost-dialog").close();
      renderFocusStudio();
    }),
  );
  $("#cost-dialog").showModal();
}

function saveCostEntry() {
  if (!costEditor) return;
  const amountValue = $("#cost-amount").value.trim();
  const invoice = $("#cost-invoice").value.trim();
  const document_evidence_id = $("#cost-document").value || "";
  if (amountValue === "" && !invoice && !document_evidence_id) {
    $("#cost-dialog").close();
    return;
  }
  const entry = {
    trade: costEditor.trade,
    amount: amountValue === "" ? null : Number(amountValue),
    currency: "USD",
    invoice_ref: invoice,
    document_evidence_id,
  };
  costEditor = null;
  $("#cost-dialog").close();
  void (async () => {
    const kept = await recordCost(entry);
    if (kept) await hydrateProjectCosts();
    saveProjectCosts(kept ? "Cost and document in the record" : "Cost and document recorded");
    renderFocusStudio();
  })();
}

/* Money recorded for work nobody can see is the one thing here that is not a
   bookkeeping gap. It is asked about differently, and it is asked first. */
function requestTradeDocument(trade) {
  const room = rooms[0];
  if (!room) return;
  room.requests = Array.isArray(room.requests) ? room.requests : [];
  const text = trade.state === "no_evidence"
    ? `Show where ${trade.label.toLowerCase()} was done: ${window.MDAIMoney360.money(trade.amount)} is recorded and nothing in the capture record shows it`
    : `Send the invoice covering ${trade.label.toLowerCase()}`;
  if (room.requests.some((entry) => entry.trade === trade.key && entry.state === "open")) {
    notify("This has already been asked for.");
    return;
  }
  room.requests.push({
    id: `rq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    trade: trade.key,
    kind: trade.state === "no_evidence" ? "evidence" : "document",
    text,
    reason: trade.spaces.length ? `Seen in ${trade.spaces.join(", ")}` : "Not seen anywhere on the property",
    state: "open",
    created_at: new Date().toISOString(),
  });
  saveRooms("Request recorded");
  renderFocusStudio();
  notify(text, 7000);
}

/* --------------------------------------------------- Capture-to-capture change */

/* A space filmed twice is the only place the record can answer what actually
   happened between two dates. Captures are grouped by the day they were taken,
   because that is the unit a person and an invoice both work in. */
function roomCaptureDays(room) {
  const groups = new Map();
  (room?.evidence || [])
    .filter((item) => isImage(item) || isVideo(item))
    .forEach((item) => {
      const time = focusTimestamp(item);
      const key = focusDayKey(time) || "undated";
      if (!groups.has(key)) groups.set(key, { key, time, items: [] });
      groups.get(key).items.push(item);
      groups.get(key).time = Math.min(groups.get(key).time || time, time || Infinity);
    });
  return [...groups.values()]
    .sort((a, b) => (a.time || 0) - (b.time || 0))
    .map((group) => ({
      ...group,
      label: group.key === "undated"
        ? "an undated capture"
        : new Date(group.time).toLocaleDateString("en-US", { month: "long", day: "numeric" }),
    }));
}

function roomCanCompare(room) {
  return roomCaptureDays(room).length >= 2;
}

/* Both captures are read separately and then differenced. The result is stored
   on the space as a suggestion, never as a fact: it says what appeared, what is
   no longer in view, and how much the two captures can be trusted to carry it. */
async function compareRoomCaptures(room, onStatus = () => {}) {
  const days = roomCaptureDays(room);
  if (days.length < 2) throw new Error("This space has captures from only one day, so there is nothing to compare.");
  if (!cloud.schemaReady || !cloud.propertyId) throw new Error("A secure Supabase connection is required to compare captures.");
  if (!window.MDAICompare360) throw new Error("The comparison engine is unavailable. Reload the page.");
  const earlier = days[days.length - 2];
  const later = days[days.length - 1];

  onStatus(`Reading the capture from ${earlier.label}`);
  const first = await analyzeFocusRoom(room, onStatus, { evidenceItems: earlier.items, apply: false });
  if (!first?.analysis) throw new Error(`The capture from ${earlier.label} could not be interpreted.`);

  onStatus(`Reading the capture from ${later.label}`);
  const second = await analyzeFocusRoom(room, onStatus, { evidenceItems: later.items, apply: true });
  if (!second?.analysis) throw new Error(`The capture from ${later.label} could not be interpreted.`);

  onStatus("Comparing the two captures");
  room.change = window.MDAICompare360.compare(first.analysis, second.analysis, {
    earlier_label: earlier.label,
    later_label: later.label,
    earlier_ids: first.evidenceIds || [],
    later_ids: second.evidenceIds || [],
  });
  room.change.space_id = room.id;
  saveRooms("Comparison saved");
  return room.change;
}

/* ------------------------------------------------------------ Spatial markers */

/* Matched the same way the comparison itself matches, so a marker and the
   change list can never disagree about whether a thing is new. */
function markerChangeLine(room, marker) {
  const change = room?.change;
  if (!change || !window.MDAICompare360) return "";
  const words = window.MDAICompare360.tokens(marker.detail || marker.label);
  const hit = (list, phrase) => {
    const best = list
      .map((entry) => ({ entry, score: window.MDAICompare360.overlap(words, window.MDAICompare360.tokens(entry.text)) }))
      .sort((a, b) => b.score - a.score)[0];
    return best && best.score >= window.MDAICompare360.SAME_THRESHOLD ? phrase : "";
  };
  return (
    hit(change.appeared, `Appeared since ${change.earlier_label} — AI suggestion, not verified`) ||
    hit(change.unchanged, `Present in the capture from ${change.earlier_label} as well`) ||
    ""
  );
}

function roomMarkers(room, item) {
  const markers = Array.isArray(room?.markers) ? room.markers : [];
  if (!item) return markers;
  return markers.filter((marker) => !marker.evidence_id || marker.evidence_id === item.id);
}

/* A marker with no document is not a footnote — it is the moment the system
   has to speak: "this was installed, and nothing on file covers it." The
   request becomes an open item on the space, so it can be chased. */
/* Asking from inside the sphere asks for the invoice that would actually
   exist: the one covering this trade, not one covering this single outlet. */
function requestMarkerDocument(room, marker) {
  if (!room || !window.MDAITrades360) return;
  const guess = window.MDAITrades360.classify(marker.detail || marker.label);
  const coverage = projectCoverage();
  const trade = coverage?.trades.find((entry) => entry.key === guess.trade) || {
    key: guess.trade,
    label: guess.label,
    state: "no_money",
    spaces: [room.name],
    amount: 0,
  };
  requestTradeDocument(trade);
}

function reviewMarker(room, marker, state) {
  if (!room) return;
  marker.reviewed_at = new Date().toISOString();
  saveRooms(
    state === "confirmed"
      ? "Marker confirmed by a person"
      : state === "rejected"
        ? "Marker marked incorrect"
        : "Marker sent back for more evidence",
  );
  renderFocusStudio();
}

function placeMarker(room, marker) {
  if (!room) return;
  room.markers = Array.isArray(room.markers) ? room.markers : [];
  room.markers.push(marker);
  saveRooms("Marker placed");
  renderFocusStudio();
}

function evidenceThumbnail(item, className = "room-thumb") {
  if (!item?.src) return `<span class="${className}"></span>`;
  if (isImage(item)) {
    /* Tagged so a thumbnail whose signature died while the page sat open can
       find its own file again instead of staying a broken square. */
    return `<img class="${className}" src="${escapeText(item.src)}" data-evidence-thumb="${escapeText(item.id || "")}" alt="">`;
  }
  if (isVideo(item)) {
    return `<span class="${className} video-thumb" aria-hidden="true">▶</span>`;
  }
  return `<span class="${className} document-thumb" aria-hidden="true">DOC</span>`;
}

/* Image load failures do not bubble, so this listens in the capture phase and
   covers every thumbnail on every screen, including ones drawn after it. One
   renewal per element: a file that is genuinely gone must not become an
   endless loop of signing requests. */
const thumbnailsRenewed = new Set();
document.addEventListener("error", (event) => {
  const image = event.target;
  if (!(image instanceof HTMLImageElement)) return;
  const id = image.dataset?.evidenceThumb;
  if (!id || thumbnailsRenewed.has(id)) return;
  thumbnailsRenewed.add(id);
  const item = rooms.flatMap((room) => room.evidence || []).find((entry) => entry.id === id);
  if (!item) return;
  freshEvidenceSrc(item, { force: true })
    .then((url) => { if (url) image.src = url; })
    .catch(() => { /* leave the broken square; it is the truthful one */ });
}, true);

function loadRooms() {
  try {
    return (
      JSON.parse(localStorage.getItem(STORAGE_KEY)) ||
      structuredClone(seedRooms)
    );
  } catch {
    return structuredClone(seedRooms);
  }
}

function loadJobs() {
  try {
    return JSON.parse(localStorage.getItem(JOBS_KEY)) || [];
  } catch {
    return [];
  }
}

function openFileDatabase() {
  if (fileDatabase) return Promise.resolve(fileDatabase);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("mdai-studio-files", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("files");
    request.onsuccess = () => {
      fileDatabase = request.result;
      resolve(fileDatabase);
    };
    request.onerror = () => reject(request.error);
  });
}

async function storeEvidenceFile(id, file) {
  const database = await openFileDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("files", "readwrite");
    transaction.objectStore("files").put(file, id);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
}

async function deleteStoredEvidenceFile(id) {
  if (!id) return;
  const database = await openFileDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("files", "readwrite");
    transaction.objectStore("files").delete(id);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes)) return "unknown size";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex ? 1 : 0)} ${units[unitIndex]}`;
}

async function uploadEvidenceToCloud(file, room, mediaType, metadata, onProgress) {
  const now = new Date();
  if (!window.MDAIObjectStorage) throw new Error("The secure S3 uploader did not load. Reload the page and retry.");
  /* The caller measures the file before handing it over — dimensions, duration,
     equirectangular projection, the capture key that links an export back to the
     camera originals, the trim window that keeps the operator out of the
     analysis. All of it was computed and then dropped here, because this built
     source_metadata from a fixed list of keys instead of forwarding what it was
     given. Reading a project back therefore lost every one of them: no duration
     to trim against, no capture key to reconcile an export with its pair.
     Whatever the caller measured travels with the file. */
  const { subject, context, intakeMode, evidenceCategory, vr, ...measured } = metadata || {};
  const sourceMetadata = {
    ...measured,
    source: "measured-decision-studio",
    last_modified: file.lastModified || null,
    subject: subject || null,
    context: context || null,
    intake_mode: intakeMode || null,
    evidence_category: evidenceCategory || null,
    vr: vr || null,
  };
  const result = await window.MDAIObjectStorage.upload({
    client: cloud.client,
    entityType: "evidence",
    organizationId: cloud.organizationId,
    propertyId: cloud.propertyId,
    spaceId: room.id,
    file,
    metadata: {
      media_type: mediaType,
      captured_at: now.toISOString(),
      source_metadata: sourceMetadata,
    },
    onProgress,
  });
  const data = result.record;

  return {
    id: data.id,
    src: result.signed_url || "",
    storagePath: data.storage_path,
    storageProvider: data.storage_provider,
    storageBucket: data.storage_bucket,
    name: file.name,
    type: mediaType,
    mimeType: file.type || "application/octet-stream",
    byteSize: file.size,
    date: formatEvidenceDate(now.toISOString()),
    status: "Private cloud original · Awaiting analysis",
    subject: subject || "",
    context: context || "",
    sourceMetadata,
  };
}

async function hydrateEvidenceFiles() {
  const database = await openFileDatabase();
  const pending = rooms
    .flatMap((room) => room.evidence)
    .filter((item) => item.fileRef && !item.src);
  await Promise.all(
    pending.map(
      (item) =>
        new Promise((resolve) => {
          const request = database
            .transaction("files", "readonly")
            .objectStore("files")
            .get(item.fileRef);
          request.onsuccess = () => {
            if (request.result) {
              item.src = URL.createObjectURL(request.result);
              objectUrls.push(item.src);
            }
            resolve();
          };
          request.onerror = resolve;
        }),
    ),
  );
}

function saveRooms(message = cloud.schemaReady ? "Cloud record updated" : "Saved locally") {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(rooms, (key, value) =>
      key === "src" && String(value).startsWith("blob:") ? "" : value,
    ),
  );
  elements.autosave.textContent = message;
  setTimeout(
    () =>
      (elements.autosave.textContent = cloud.schemaReady
        ? `Cloud connected · ${cloud.role}`
        : "Saved locally"),
    1300,
  );
  updateMetrics();
}

function saveJobs() {
  localStorage.setItem(JOBS_KEY, JSON.stringify(jobs));
  renderJobs();
  updatePipeline();
}

function jobErrorLabel(errorCode) {
  const code = String(errorCode || "").toLowerCase();
  if (!code) return "Open the room and run the analysis again.";
  if (code.includes("insufficient_quota")) {
    return "OpenAI API billing or credits are not active.";
  }
  if (code.includes("invalid_api_key") || code.startsWith("openai_401")) {
    return "The OpenAI API key is invalid or no longer active.";
  }
  if (code.includes("rate_limit") || code.startsWith("openai_429")) {
    return "OpenAI temporarily rejected the request because of quota or rate limits.";
  }
  if (code.includes("model_not_found") || code.includes("model_not_available")) {
    return "The configured OpenAI model is not available to this API project.";
  }
  if (code === "suggestion_write_failed") {
    return "The AI response was produced but could not be saved.";
  }
  if (code === "openai_incomplete") {
    return "OpenAI stopped before completing the structured result.";
  }
  if (code.startsWith("openai_400")) {
    return "OpenAI rejected the analysis request format.";
  }
  return `Worker error: ${code}`;
}

async function functionInvocationError(error) {
  const fallback = error?.message || "Secure AI worker failed";
  const response = error?.context;
  if (!response || typeof response.json !== "function") {
    return new Error(fallback);
  }
  try {
    const payload = await (typeof response.clone === "function" ? response.clone() : response).json();
    const detail = payload?.error || fallback;
    const code = payload?.code ? ` (${payload.code})` : "";
    return new Error(`${detail}${code}`);
  } catch {
    return new Error(fallback);
  }
}

function visionBlockerLabel(code = "") {
  if (code === "approved_plan_baseline_required") return "Approve the current plan baseline";
  if (code === "verified_spatial_evidence_required") return "Add reviewed spatial evidence";
  if (code.startsWith("space_review_required:")) return "Confirm every included room";
  if (code.startsWith("field_task_verification_required:")) return "Complete the linked field assignment";
  if (code.startsWith("current_interpretation_required:")) return "Run AI on the current room evidence";
  if (code.startsWith("interpretation_review_required:")) return "Human-confirm the current AI interpretation";
  return code.replaceAll("_", " ");
}

function normalizedVisionRelease(release) {
  if (!release) return null;
  return {
    ...release,
    blockers: Array.isArray(release.blockers)
      ? release.blockers
      : Array.isArray(release.manifest?.blockers)
        ? release.manifest.blockers
        : [],
  };
}

function renderVisionReleaseStatus() {
  const status = $("#vision-release-status");
  const state = $("#vision-release-state");
  const approve = $("#approve-vision-release");
  const build = $("#build-vision-release");
  const canGovern = ["owner", "admin", "reviewer"].includes(cloud.role);
  /* The published side of the same release: the Owner View renders only
     what a person approved, for the people who watch rather than build. */
  const ownerView = $("#open-owner-view");
  if (ownerView && cloud.propertyId) ownerView.href = `owner-view/?property=${encodeURIComponent(cloud.propertyId)}`;
  void renderOwnerViewAccess();
  build.disabled = !canGovern;
  approve.hidden = true;
  status.className = "vision-release-status";

  if (!visionRelease) {
    state.textContent = "No governed release yet";
    $("#vision-release-version").textContent = "—";
    status.textContent = canGovern
      ? "Build a release after the plan baseline, field work, and room evidence have been reviewed."
      : "A project reviewer must build and approve the first Vision release.";
    renderVisionReadiness();
    updatePipeline();
    return;
  }

  $("#vision-release-version").textContent = `v${visionRelease.version}`;
  if (visionRelease.state === "approved") {
    state.textContent = "Approved · available to Vision client";
    status.classList.add("approved");
    status.textContent = `Version ${visionRelease.version} is the current immutable release. The Vision client receives temporary private media links on demand.`;
  } else if (visionRelease.blockers.length) {
    state.textContent = `Draft · ${visionRelease.blockers.length} blocker${visionRelease.blockers.length === 1 ? "" : "s"}`;
    status.classList.add("blocked");
    const production = approvedVisionRelease
      ? ` Approved v${approvedVisionRelease.version} remains live.`
      : " Nothing is live yet.";
    status.textContent = `${visionRelease.blockers.slice(0, 3).map(visionBlockerLabel).join(" · ")}.${production}`;
  } else {
    state.textContent = "Draft · ready for named approval";
    status.textContent = "Every governance check passed. A reviewer can approve this exact version for the Vision client.";
    approve.hidden = !canGovern;
  }
  renderVisionReadiness();
  updatePipeline();
}

async function invokeVisionRelease(body) {
  const { data, error } = await cloud.client.functions.invoke("vision-release", { body });
  if (error) throw await functionInvocationError(error);
  if (data?.error) throw new Error(data.error);
  return data;
}

/* The owner's key to this one door. Only a project owner or admin hands it
   out or takes it back; the list below is the live truth from the record —
   who was invited, whether they have signed in yet, when the key expires. */
async function renderOwnerViewAccess() {
  const panel = $("#owner-view-access");
  if (!panel || !cloud.client || !cloud.propertyId) return;
  const mayManage = ["owner", "admin"].includes(cloud.role);
  panel.hidden = !mayManage;
  if (!mayManage) return;
  const { data: invitations } = await cloud.client
    .from("property_invitations")
    .select("id, invited_email, state, expires_at, accepted_at")
    .eq("property_id", cloud.propertyId)
    .neq("state", "revoked")
    .order("created_at", { ascending: false });
  $("#owner-view-grants").innerHTML = (invitations || []).map((invitation) => `
    <div class="owner-grant-row">
      <span>${escapeText(invitation.invited_email)}</span>
      <small>${invitation.state === "accepted" ? "signed in" : "invited"}${invitation.expires_at ? ` · until ${String(invitation.expires_at).slice(0, 10)}` : ""}</small>
      <button class="text-button" type="button" data-revoke-owner="${escapeText(invitation.invited_email)}">Revoke</button>
    </div>`).join("");
  $("#owner-view-grants").querySelectorAll("[data-revoke-owner]").forEach((button) => {
    button.addEventListener("click", async () => {
      const { error } = await cloud.client.rpc("revoke_owner_view", {
        p_property_id: cloud.propertyId, p_email: button.dataset.revokeOwner,
      });
      if (error) { notify(error.message || "The access could not be revoked"); return; }
      notify(`Owner access revoked for ${button.dataset.revokeOwner}.`);
      void renderOwnerViewAccess();
    });
  });
}

async function refreshVisionReleaseStatus() {
  if (!cloud.client || !cloud.propertyId) return;
  const data = await invokeVisionRelease({ action: "status", property_id: cloud.propertyId });
  const releases = (data?.releases || []).map(normalizedVisionRelease);
  visionRelease = releases[0] || null;
  approvedVisionRelease = releases.find((release) => release.state === "approved") || null;
  renderVisionReleaseStatus();
}

function currentRoom() {
  return rooms.find((room) => room.id === activeRoomId) || rooms[0];
}
function escapeText(value) {
  const span = document.createElement("span");
  span.textContent = value;
  return span.innerHTML;
}

function renderRooms() {
  elements.roomList.innerHTML = rooms
    .map((room) => {
      const thumb = room.evidence.find((item) => item.src);
      return `<button class="room-card ${room.id === activeRoomId ? "active" : ""}" data-room="${room.id}" type="button">
      ${evidenceThumbnail(thumb)}
      <span><strong>${escapeText(room.name)}</strong><small>${escapeText(room.level)} · ${room.evidence.length} item${room.evidence.length === 1 ? "" : "s"}</small></span>
      <i class="status-dot ${room.status === "confirmed" ? "confirmed" : room.evidence.length ? "" : "empty"}"></i>
    </button>`;
    })
    .join("");
  elements.roomList.querySelectorAll("[data-room]").forEach((button) =>
    button.addEventListener("click", () => {
      activeRoomId = button.dataset.room;
      render();
    }),
  );
}

function renderRoom() {
  const room = currentRoom();
  if (!room) {
    elements.title.textContent = "No rooms yet";
    elements.level.textContent = "Create the property space map";
    elements.count.textContent = "0 evidence items";
    elements.image.hidden = true;
    elements.video.hidden = true;
    elements.document.hidden = true;
    elements.strip.innerHTML = "";
    elements.visible.innerHTML = "<li>Add the first room or area to begin</li>";
    elements.unknown.innerHTML = "<li>No room evidence has been captured</li>";
    elements.analysisSummary.hidden = true;
    elements.followUpBlock.hidden = true;
    elements.followUp.innerHTML = "";
    elements.note.value = "";
    elements.badge.textContent = "Setup required";
    elements.badge.className = "review-badge needs";
    return;
  }
  const evidence =
    room.evidence.find((item) => item.id === activeEvidenceId) ||
    room.evidence[0];
  elements.title.textContent = room.name;
  elements.level.textContent = `${room.building} · ${room.level}`;
  elements.count.textContent = `${room.evidence.length} evidence item${room.evidence.length === 1 ? "" : "s"}`;
  showEvidence(evidence, room.name);
  elements.strip.innerHTML = room.evidence
    .filter((item) => item.src)
    .map(
      (item) =>
        `<button class="evidence-thumb" data-evidence-id="${escapeText(item.id)}" type="button">${evidenceThumbnail(item, "strip-thumb")}</button>`,
    )
    .join("");
  elements.strip
    .querySelectorAll("[data-evidence-id]")
    .forEach((button) =>
      button.addEventListener("click", () => {
        const item = room.evidence.find(
          (candidate) => candidate.id === button.dataset.evidenceId,
        );
        if (item) showEvidence(item, room.name);
      }),
    );
  elements.visible.innerHTML = (
    room.visible.length ? room.visible : ["No observations recorded"]
  )
    .map((item) => `<li>${escapeText(item)}</li>`)
    .join("");
  elements.unknown.innerHTML = (
    room.unknown.length ? room.unknown : ["Evidence has not been reviewed"]
  )
    .map((item) => `<li>${escapeText(item)}</li>`)
    .join("");
  const analysis = room.analysis;
  elements.analysisSummary.hidden = !analysis;
  elements.analysisSummaryText.textContent = analysis?.summary || "";
  elements.analysisQuality.textContent = analysis?.capture_quality
    ? `${analysis.capture_quality} capture · human verification required`
    : "Human verification required";
  const followUps = Array.isArray(analysis?.follow_up_captures)
    ? analysis.follow_up_captures
    : [];
  elements.followUpBlock.hidden = !followUps.length;
  elements.followUp.innerHTML = followUps
    .map(
      (item) =>
        `<li><strong>${escapeText(item.request || "Additional capture")}</strong>${item.reason ? ` — ${escapeText(item.reason)}` : ""}</li>`,
    )
    .join("");
  elements.note.value = room.note || "";
  const confirmed = room.status === "confirmed";
  elements.badge.textContent = confirmed
    ? "Human confirmed"
    : "Needs verification";
  elements.badge.className = `review-badge ${confirmed ? "confirmed" : "needs"}`;
}

function showEvidence(item, roomName = currentRoom()?.name || "Room") {
  activeEvidenceId = item?.id || null;
  elements.video.pause();
  elements.image.hidden = true;
  elements.video.hidden = true;
  elements.document.hidden = true;
  elements.image.removeAttribute("src");
  elements.video.removeAttribute("src");
  elements.documentOpen.removeAttribute("href");

  if (item?.mimeType === "application/x-insta360-capture") {
    elements.documentName.textContent = item.name || "360 capture";
    elements.document.hidden = false;
    elements.documentOpen.hidden = true;
    elements.type.textContent = "360 capture · paired camera originals";
    elements.sourceName.textContent = `${item.sourceIds?.length || 1} protected INSV originals`;
    elements.sourceDate.textContent = item.date || "—";
    elements.sourceSubject.textContent = item.subject || "Full-room 360 evidence";
    elements.sourceStatus.textContent = item.status;
    $("#expand-image").hidden = true;
    $("#delete-selected-evidence").hidden = true;
    return;
  }

  if (!item?.src) {
    elements.image.alt = "No evidence uploaded";
    elements.type.textContent = "No evidence selected";
    elements.sourceName.textContent = "—";
    elements.sourceDate.textContent = "—";
    elements.sourceSubject.textContent = "—";
    elements.sourceStatus.textContent = "Awaiting upload";
    $("#expand-image").hidden = true;
    $("#delete-selected-evidence").hidden = true;
    return;
  }

  /* Renewed if the page has been open a while. This runs without waiting so the
     panel never blanks; the element gets the current URL first and the renewed
     one a moment later if it differs. */
  const showWith = (url) => {
    if (isVideo(item)) {
      elements.video.src = url;
      elements.video.hidden = false;
    } else if (isImage(item)) {
      elements.image.src = url;
      elements.image.alt = `${roomName} evidence capture`;
      elements.image.hidden = false;
    } else {
      elements.documentName.textContent = item.name || "Document evidence";
      elements.documentOpen.href = url;
      elements.documentOpen.hidden = false;
      elements.document.hidden = false;
    }
  };
  const showing = item.src;
  showWith(showing);
  if (signedUrlIsStale(item)) {
    freshEvidenceSrc(item, { force: true }).then((url) => {
      /* Somebody may have moved to another file while this was in flight, and
         painting the old one back over it would be worse than a stale link. */
      if (!url || url === showing || activeEvidenceId !== item.id) return;
      showWith(url);
    }).catch(() => { /* the panel keeps what it had */ });
  }

  $("#expand-image").hidden = !isImage(item);
  $("#delete-selected-evidence").hidden = !canDeleteEvidence();
  elements.type.textContent = item.type || "Evidence";
  elements.sourceName.textContent = item.name || "—";
  elements.sourceDate.textContent = item.date || "—";
  elements.sourceSubject.textContent = item.subject || "Not described";
  elements.sourceStatus.textContent = item.status || "Original preserved";
}

function updateMetrics() {
  const evidenceCount = rooms.reduce(
    (sum, room) => sum + room.evidence.length,
    0,
  );
  const confirmed = rooms.filter((room) => room.status === "confirmed").length;
  $("#metric-rooms").textContent = rooms.length;
  $("#metric-evidence").textContent = evidenceCount;
  $("#metric-evidence-copy").textContent =
    `${evidenceCount} evidence item${evidenceCount === 1 ? "" : "s"}`;
  $("#metric-review").textContent = `${confirmed}/${rooms.length}`;
  $("#metric-review-copy").textContent =
    `${rooms.length - confirmed} require verification`;
  $("#review-nav-count").textContent = rooms.length - confirmed;
}

function roomOptions(selectedId, allowNew = false) {
  const existing = rooms
    .map(
      (room) =>
        `<option value="${room.id}" ${room.id === selectedId ? "selected" : ""}>${escapeText(room.name)} · ${escapeText(room.level)}</option>`,
    )
    .join("");
  return `${existing}${allowNew ? '<option value="__new__">＋ Create a new room…</option>' : ""}`;
}

function renderUploadRooms() {
  elements.uploadRoom.innerHTML = roomOptions(activeRoomId);
}
function renderInventory() {
  const evidence = rooms.flatMap((room) =>
    room.evidence.map((item) => ({
      ...item,
      room: room.name,
      roomStatus: room.status,
    })),
  );
  $("#inventory-count").textContent =
    `${evidence.length} item${evidence.length === 1 ? "" : "s"}`;
  $("#inventory-table").innerHTML = evidence.length
    ? evidence
        .map(
          (item) =>
            `<article class="inventory-row"><span class="file-icon">${isVideo(item) ? "▶" : item.type?.includes("Plan") ? "⌑" : isImage(item) ? "◫" : "DOC"}</span><div><strong>${escapeText(item.subject || item.name)}</strong><small>${escapeText(item.name)} · ${escapeText(item.type)} · ${escapeText(item.room)}</small></div><span>${escapeText(item.date || "Date unavailable")}</span><span class="inventory-status ${item.roomStatus}">${item.roomStatus === "confirmed" ? "Human confirmed" : "Review required"}</span><div class="inventory-actions"><button class="mini-button inventory-edit" data-edit-evidence="${item.id}" type="button">Edit</button>${canDeleteEvidence() ? `<button class="mini-button inventory-delete" data-delete-evidence="${item.id}" type="button">Delete</button>` : ""}</div></article>`,
        )
        .join("")
    : `<div class="empty-state"><strong>No evidence yet</strong><p>Add source material to begin the governed record.</p></div>`;
  $("#inventory-table")
    .querySelectorAll("[data-edit-evidence]")
    .forEach((button) =>
      button.addEventListener("click", () => openEvidenceEditor(button.dataset.editEvidence)),
    );
  $("#inventory-table")
    .querySelectorAll("[data-delete-evidence]")
    .forEach((button) =>
      button.addEventListener("click", () => openEvidenceDelete(button.dataset.deleteEvidence)),
    );
}

function renderJobs() {
  const list = $("#job-list");
  if (!list) return;
  $("#queue-count").textContent =
    `${jobs.length} job${jobs.length === 1 ? "" : "s"}`;
  $("#queue-nav-count").textContent = jobs.filter((job) =>
    ["Queued for AI", "Analyzing evidence"].includes(job.status),
  ).length;
  list.innerHTML = jobs.length
    ? jobs
        .map(
          (job) =>
            `<article class="job-card"><div class="job-state"><i></i><span>${escapeText(job.status)}</span></div><div><strong>${escapeText(job.roomName)}</strong><p>${job.evidenceCount} evidence item${job.evidenceCount === 1 ? "" : "s"} · ${escapeText(job.profile)}</p>${job.status === "Failed" ? `<small class="job-error">${escapeText(jobErrorLabel(job.errorCode))}</small>` : ""}</div><time>${escapeText(job.createdAt)}</time><button class="mini-button" data-job-room="${job.roomId}" type="button">Open room</button></article>`,
        )
        .join("")
    : `<div class="empty-state"><strong>No processing jobs</strong><p>Open a room and request AI interpretation.</p></div>`;
  list.querySelectorAll("[data-job-room]").forEach((button) =>
    button.addEventListener("click", () => {
      activeRoomId = button.dataset.jobRoom;
      activateView("property");
      render();
    }),
  );
}

function renderReviewQueue() {
  const queue = $("#review-queue");
  queue.innerHTML = rooms.length
    ? rooms
    .map((room) => {
      const activeJob = jobs.find(
        (job) =>
          job.roomId === room.id &&
          ["Queued for AI", "Analyzing evidence"].includes(job.status),
      );
      const aiStatus = room.analysis
        ? "AI suggestion ready"
        : activeJob
          ? activeJob.status
          : "No AI suggestion";
      const editAction = canManageSpaces()
        ? `<button class="mini-button" data-edit-space="${room.id}" type="button">Edit</button>`
        : "";
      return `<article class="review-queue-card"><div class="review-room-thumb">${evidenceThumbnail(room.evidence.find((item) => item.src), "review-thumb-media")}</div><div><p>${escapeText(room.building)} · ${escapeText(room.level)}</p><h2>${escapeText(room.name)}</h2><small>${room.evidence.length} source item${room.evidence.length === 1 ? "" : "s"} · ${escapeText(aiStatus)}</small></div><span class="review-badge ${room.status === "confirmed" ? "confirmed" : "needs"}">${room.status === "confirmed" ? "Human confirmed" : "Needs verification"}</span><div class="review-card-actions">${editAction}<button class="secondary-button" data-review-room="${room.id}" type="button">Open record</button></div></article>`;
    })
    .join("")
    : `<div class="empty-state"><strong>No spaces in this property</strong><p>Add a room or area when you are ready to begin a new record.</p></div>`;
  queue.querySelectorAll("[data-review-room]").forEach((button) =>
    button.addEventListener("click", () => {
      activeRoomId = button.dataset.reviewRoom;
      activateView("property");
      render();
    }),
  );
  queue.querySelectorAll("[data-edit-space]").forEach((button) =>
    button.addEventListener("click", () => openSpaceEditor(button.dataset.editSpace)),
  );
}

function renderVisionReadiness() {
  const evidenceCount = rooms.reduce(
    (sum, room) => sum + room.evidence.length,
    0,
  );
  const allReviewed =
    rooms.length > 0 && rooms.every((room) => room.status === "confirmed");
  const checks = [
    {
      label: "Property and room structure",
      ready: rooms.length > 0,
      note: `${rooms.length} spaces indexed`,
    },
    {
      label: "Source evidence",
      ready: evidenceCount > 0,
      note: `${evidenceCount} items referenced`,
    },
    {
      label: "Human review",
      ready: allReviewed,
      note: allReviewed
        ? "All spaces confirmed"
        : `${rooms.filter((room) => room.status !== "confirmed").length} spaces require review`,
    },
    {
      label: "Private media delivery",
      ready:
        cloud.schemaReady &&
        evidenceCount > 0 &&
        rooms.every((room) =>
          room.evidence.every((item) => Boolean(item.storagePath)),
        ),
      note: cloud.schemaReady
        ? evidenceCount
          ? "Private signed delivery configured"
          : "Upload evidence to verify delivery"
        : "Supabase Storage not connected",
    },
    {
      label: "Governed Vision release",
      ready: visionRelease?.state === "approved",
      note:
        visionRelease?.state === "approved"
          ? `Version ${visionRelease.version} approved`
          : visionRelease
            ? `Version ${visionRelease.version} is ${visionRelease.blockers?.length ? "blocked" : "awaiting approval"}`
            : "Build a versioned release",
    },
  ];
  const readyCount = checks.filter((item) => item.ready).length;
  $("#readiness-score").textContent =
    `${Math.round((readyCount / checks.length) * 100)}%`;
  $("#readiness-list").innerHTML = checks
    .map(
      (item) =>
        `<div class="readiness-item ${item.ready ? "ready" : "blocked"}"><i>${item.ready ? "✓" : "!"}</i><p><strong>${escapeText(item.label)}</strong><small>${escapeText(item.note)}</small></p></div>`,
    )
    .join("");
}

function updatePipeline() {
  const evidenceCount = rooms.reduce(
    (sum, room) => sum + room.evidence.length,
    0,
  );
  const allReviewed =
    rooms.length > 0 && rooms.every((room) => room.status === "confirmed");
  const states = [
    evidenceCount > 0,
    rooms.length > 0,
    jobs.some((job) => job.status === "Completed"),
    allReviewed,
    visionRelease?.state === "approved",
  ];
  $("#pipeline-steps")
    .querySelectorAll("li")
    .forEach((item, index) => item.classList.toggle("done", states[index]));
}

function render() {
  $("#property-name").textContent = propertyRecord.name;
  $("#property-description").textContent = propertyRecord.description;
  $("#vision-property-name").textContent = propertyRecord.name;
  renderRooms();
  renderRoom();
  updateMetrics();
  renderUploadRooms();
  renderInventory();
  renderJobs();
  renderReviewQueue();
  renderVisionReadiness();
  updatePipeline();
}
function notify(message, duration = 2600) {
  const now = Date.now();
  if (notify.lastMessage === message && now - (notify.lastAt || 0) < 8000) return;
  notify.lastMessage = message;
  notify.lastAt = now;
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  window.clearTimeout(notify.timer);
  notify.timer = window.setTimeout(() => elements.toast.classList.remove("show"), duration);
}

function setAuthMessage(message, tone = "neutral") {
  elements.authMessage.textContent = message;
  elements.authMessage.dataset.tone = tone;
}

function isPasswordRecoveryUrl() {
  return new URLSearchParams(window.location.search).get("recovery") === "1";
}

function passwordRecoveryUrlError() {
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return query.get("error_description") || hash.get("error_description") || "";
}

function clearPasswordRecoveryUrl() {
  window.history.replaceState({}, document.title, `${window.location.origin}/studio/`);
}

function setAccountSecurityMessage(message, tone = "neutral") {
  elements.accountSecurityMessage.textContent = message;
  elements.accountSecurityMessage.dataset.tone = tone;
}

function openAccountSecurity(mode = "set", session = cloud.session) {
  if (!session?.user) return;
  accountSecurityMode = mode;
  cloud.session = session;
  const isRecovery = mode === "recovery";
  $("#account-security-eyebrow").textContent = isRecovery
    ? "Password recovery"
    : "Account security";
  $("#account-security-title").textContent = isRecovery
    ? "Choose a new password"
    : "Set your Studio password";
  $("#account-security-copy").textContent = isRecovery
    ? "This secure recovery session is connected to your existing Studio account."
    : "Add email and password access to this account without removing Google sign-in.";
  $("#save-account-password").textContent = isRecovery
    ? "Update password"
    : "Save password";
  $("#close-account-security").hidden = isRecovery;
  $("#account-security-email").value = session.user.email || "";
  $("#new-account-password").value = "";
  $("#confirm-account-password").value = "";
  setAccountSecurityMessage("");
  if (!elements.accountSecurityDialog.open) {
    elements.accountSecurityDialog.showModal();
  }
  $("#new-account-password").focus();
}

function sessionInitials(session) {
  const email = session?.user?.email || "Authorized user";
  return (
    email
      .split("@")[0]
      .split(/[._-]/)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join("") || "AU"
  );
}

function formatEvidenceDate(value) {
  if (!value) return "Date unavailable";
  return new Date(value).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/* Client-side events the server would otherwise never learn about.

   Never let recording an event break the thing it describes: a report that
   opened is a report that opened, whether or not the note about it landed. */
async function recordClientEvent(action, detail = {}) {
  if (!cloud.schemaReady || !cloud.propertyId) return;
  try {
    await cloud.client.rpc("record_client_event", {
      p_property_id: cloud.propertyId,
      p_action: action,
      p_detail: detail,
    });
  } catch (error) {
    console.warn("Could not record a client event", error);
  }
}

/* A signed URL is a fact with an expiry date, and the Studio used to treat it
   as a fact with none: every file was signed once when the project opened, and
   the signature was good for exactly one hour.
 *
 * Nothing then refreshed it. After an hour on the same page — which is every
 * real working session — every link on the screen was dead at once. Thumbnails
 * stopped loading, opening a capture failed, and "Process with AI" died in a
 * tenth of a second because the browser could not read a single frame out of a
 * video it was no longer allowed to fetch. It read as "all my files are
 * broken", and none of them were.
 *
 * Two sibling screens already had this right: operations and capture sign at
 * the moment of use. This brings the Studio in line. Time spent on the page
 * stops meaning anything. */
const SIGNED_URL_TTL_MS = 60 * 60 * 1000;
/* Re-signed with ten minutes to spare, because a URL that expires between the
   click and the request has expired. */
const SIGNED_URL_REFRESH_MS = 50 * 60 * 1000;

function signedUrlIsStale(item) {
  if (!item?.src) return true;
  /* A local object URL belongs to this page and outlives nothing but it. */
  if (item.src.startsWith("blob:")) return false;
  return Date.now() - (item.srcSignedAt || 0) >= SIGNED_URL_REFRESH_MS;
}

/* The URL to use right now. Never read item.src directly for anything that can
   fail in front of a person. */
async function freshEvidenceSrc(item, { force = false } = {}) {
  if (!item?.id) return item?.src || "";
  if (item.src?.startsWith("blob:")) return item.src;
  if (!force && !signedUrlIsStale(item)) return item.src;
  const url = await signedEvidenceUrl(item.storagePath, {
    id: item.id,
    storage_provider: item.storageProvider,
  });
  if (url) {
    item.src = url;
    item.srcSignedAt = Date.now();
  }
  return item.src || "";
}

async function signedEvidenceUrl(storagePath, record = null) {
  if (!storagePath) return "";
  if (record?.storage_provider === "aws-s3") {
    try {
      return await window.MDAIObjectStorage.getSignedUrl(cloud.client, "evidence", record.id);
    } catch (error) {
      console.error("Could not sign S3 evidence URL", error);
      return "";
    }
  }
  const { data, error } = await cloud.client.storage
    .from(config.storageBucket)
    .createSignedUrl(storagePath, 60 * 60);
  if (error) return "";
  return data?.signedUrl || "";
}

function propertyTypeLabel(value) {
  const labels = {
    single_family: "Single-family residence",
    multifamily: "Multifamily",
    commercial: "Commercial building",
    hospitality: "Hotel / hospitality",
    industrial: "Industrial",
    construction_site: "Construction site",
    other: "Other property",
  };
  return labels[value] || "Property";
}

function renderPropertyDirectory() {
  const properties = cloud.properties || [];
  /* Two actions per row now, so the row can no longer be one button — a button
     inside a button is not valid and the inner one stops being reachable. */
  elements.propertyDirectory.innerHTML = properties
    .map(
      (property) =>
        `<article class="property-directory-card">
        <button class="property-open" type="button" data-property-id="${escapeText(property.id)}">
          <h2>Open ${escapeText(property.name)}</h2>
          <small>→</small>
        </button>
        <button class="property-remove" type="button" data-remove-property="${escapeText(property.id)}" data-property-name="${escapeText(property.name)}" aria-label="Remove ${escapeText(property.name)}">Remove</button>
      </article>`,
    )
    .join("");
  $("#empty-property-state").hidden = properties.length > 0;
  elements.propertyDirectory.hidden = properties.length === 0;
  elements.propertyDirectory
    .querySelectorAll("[data-property-id]")
    .forEach((button) =>
      button.addEventListener("click", () => openProperty(button.dataset.propertyId)),
    );
  elements.propertyDirectory
    .querySelectorAll("[data-remove-property]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        removeProject(button.dataset.removeProperty, button.dataset.propertyName)),
    );
}

/* Removing a project hides it. It does not destroy anything: the evidence, the
   rooms and the audit trail all stay exactly where they were, and the removal
   is itself an audited event naming who did it and what was inside at the time.
   Saying that plainly is the difference between a person removing a test
   project and a person afraid to touch the button. */
async function removeProject(propertyId, name) {
  if (!propertyId) return;
  const confirmed = window.confirm(
    `Remove "${name}" from your projects?\n\n` +
    "Nothing is destroyed. The evidence, the rooms and the record stay as they are, " +
    "and the project can be put back from \"Removed projects\" below.",
  );
  if (!confirmed) return;
  try {
    const { error } = await cloud.client.rpc("soft_delete_project", {
      p_property_id: propertyId,
      p_reason: null,
    });
    if (error) throw error;
    notify(`${name} was removed. It can be put back from "Removed projects".`);
    await loadPropertyDirectory();
  } catch (error) {
    console.error(error);
    /* The database owns the rule about who may remove a project, so what it
       refused is what the person is told. */
    notify(error.message || "This project could not be removed.");
  }
}

async function restoreProject(propertyId, name) {
  try {
    const { error } = await cloud.client.rpc("restore_project", { p_property_id: propertyId });
    if (error) throw error;
    notify(`${name} is back in your projects.`);
    await loadPropertyDirectory();
  } catch (error) {
    console.error(error);
    notify(error.message || "This project could not be put back.");
  }
}

/* What was removed, and the way back. Only an owner or administrator sees
   anything here, because removed_projects() answers for nobody else. */
async function renderRemovedProjects() {
  const panel = $("#removed-projects");
  const list = $("#removed-projects-list");
  if (!panel || !list) return;
  const { data, error } = await cloud.client.rpc("removed_projects");
  const removed = error ? [] : (data || []);
  panel.hidden = removed.length === 0;
  $("#removed-projects-count").textContent = removed.length ? `· ${removed.length}` : "";
  list.innerHTML = removed
    .map(
      (project) =>
        `<div class="removed-project">
        <div><strong>${escapeText(project.name)}</strong><small>Removed ${escapeText(formatEvidenceDate(project.deleted_at))}. Nothing was destroyed.</small></div>
        <button class="secondary-button" type="button" data-restore-property="${escapeText(project.id)}" data-property-name="${escapeText(project.name)}">Put it back</button>
      </div>`,
    )
    .join("");
  list.querySelectorAll("[data-restore-property]").forEach((button) =>
    button.addEventListener("click", () =>
      restoreProject(button.dataset.restoreProperty, button.dataset.propertyName)),
  );
}

async function loadPropertyDirectory() {
  const { data, error } = await cloud.client
    .from("properties")
    .select("id, name, address, access_classification, created_at")
    .eq("organization_id", cloud.organizationId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  cloud.properties = data || [];
  renderPropertyDirectory();
  /* Never lets the list fail to load: somebody whose role cannot see removed
     projects still gets their projects. */
  renderRemovedProjects().catch((removedError) => console.error("Removed projects", removedError));
}

async function hydrateCloudRecord() {
  if (!cloud.propertyId) throw new Error("Select a property before loading Studio.");
  const { data: property, error: propertyError } = await cloud.client
    .from("properties")
    .select("id, name, address, access_classification")
    .eq("organization_id", cloud.organizationId)
    .eq("id", cloud.propertyId)
    .single();
  if (propertyError) throw propertyError;
  if (!property) {
    elements.autosave.textContent = "Cloud connected · No property assigned";
    return;
  }

  const address = property.address || {};
  const profile = address.profile || {};
  propertyRecord = {
    id: property.id,
    name: property.name,
    city: address.city || "",
    state: address.state || "",
    description: [
      [address.city, address.state].filter(Boolean).join(", "),
      propertyTypeLabel(profile.property_type),
      profile.square_feet
        ? `${Number(profile.square_feet).toLocaleString()} sq ft`
        : "",
    ]
      .filter(Boolean)
      .join(" · "),
    access: property.access_classification,
    profile,
  };

  rooms = [];
  jobs = [];
  activeRoomId = null;
  activeEvidenceId = null;
  const [{ data: spaceRows, error: spacesError }, { data: evidenceRows, error: evidenceError }] =
    await Promise.all([
      cloud.client
        .from("spaces")
        .select("id, name, building, level, review_state")
        .eq("property_id", property.id)
        .order("created_at", { ascending: true }),
      cloud.client
        .from("evidence_items")
        .select(
          "id, space_id, storage_path, storage_provider, storage_bucket, object_version_id, original_filename, media_type, mime_type, byte_size, captured_at, created_at, source_metadata",
        )
        .eq("property_id", property.id)
        .order("created_at", { ascending: true }),
    ]);
  if (spacesError) throw spacesError;
  if (evidenceError) throw evidenceError;
  /* Fresh signatures for everything below, so a thumbnail that gave up once is
     allowed to try again. */
  thumbnailsRenewed.clear();
  /* Only asked for when it can change what the screen says: a project with no
     rooms is the one case where the plan set decides the next step. */
  if (!(spaceRows || []).length) await hydratePlanState(property.id);

  const evidenceWithUrls = collapseInsta360Sources(await Promise.all(
    (evidenceRows || []).map(async (item) => ({
      id: item.id,
      /* The room travels on the item. Without it the collapse below cannot tell
         two rooms apart, and the room filter had to look every id back up in
         the raw rows — which also meant the collapsed tile was placed by
         whichever row happened to be first. */
      spaceId: item.space_id || null,
      src: await signedEvidenceUrl(item.storage_path, item),
      /* When that signature was minted, so anything about to use it can tell
         whether it is still worth anything. */
      srcSignedAt: Date.now(),
      storagePath: item.storage_path,
      storageProvider: item.storage_provider,
      storageBucket: item.storage_bucket,
      name: item.original_filename,
      type: item.media_type,
      mimeType: item.mime_type,
      byteSize: item.byte_size,
      date: formatEvidenceDate(item.captured_at || item.created_at),
      capturedAt: item.captured_at || item.created_at || null,
      createdAt: item.created_at || null,
      status: "Private cloud original · Awaiting analysis",
      subject: item.source_metadata?.subject || "",
      context: item.source_metadata?.context || "",
      sourceMetadata: item.source_metadata || {},
    })),
  ));

  rooms = (spaceRows || []).map((space) => ({
    id: space.id,
    name: space.name,
    building: space.building || "Property",
    level: space.level || "Unspecified level",
    status: space.review_state === "confirmed" ? "confirmed" : "needs",
    note: "",
    evidence: evidenceWithUrls.filter((item) => item.spaceId === space.id),
    visible: [],
    unknown: [
      "Uploaded material has not been analyzed",
      "No factual observations have been confirmed",
    ],
  }));
  activeRoomId = rooms[0]?.id || null;

  loadProjectCosts();
  await hydrateProjectCosts();
  await hydrateStitchJobs();
  await hydrateMachineRun();
  scheduleStitchPoll();

  const { data: jobRows, error: jobsError } = await cloud.client
    .from("analysis_jobs")
    .select("id, space_id, state, profile, created_at, evidence_ids, error_code")
    .eq("property_id", property.id)
    .order("created_at", { ascending: false });
  if (!jobsError) {
    jobs = (jobRows || []).map((job) => {
      const room = rooms.find((item) => item.id === job.space_id);
      return {
        id: job.id,
        roomId: job.space_id,
        roomName: room?.name || "Property",
        evidenceCount: job.evidence_ids?.length || 0,
        profile: job.profile,
        errorCode: job.error_code || "",
        status:
          job.state === "queued"
            ? "Queued for AI"
            : job.state === "processing"
              ? "Analyzing evidence"
            : job.state.charAt(0).toUpperCase() + job.state.slice(1),
        createdAt: new Date(job.created_at).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }),
      };
    });
  }

  const { data: suggestionRows, error: suggestionsError } = await cloud.client
    .from("ai_suggestions")
    .select("id, space_id, body, evidence_ids, created_at")
    .eq("property_id", property.id)
    .eq("suggestion_type", "room_interpretation")
    .order("created_at", { ascending: false });
  if (!suggestionsError) {
    for (const suggestion of suggestionRows || []) {
      const room = rooms.find((item) => item.id === suggestion.space_id);
      const currentEvidenceIds = new Set(
        room?.evidence.map((item) => item.id) || [],
      );
      const matchesCurrentEvidence =
        suggestion.evidence_ids?.length === currentEvidenceIds.size &&
        suggestion.evidence_ids.every((id) => currentEvidenceIds.has(id));
      if (room && !room.suggestionId && matchesCurrentEvidence) {
        applyAnalysisResult(room, suggestion.body, suggestion.id);
        if (room.status === "needs" && spaceRows?.length) {
          const sourceSpace = spaceRows.find((item) => item.id === room.id);
          room.status =
            sourceSpace?.review_state === "confirmed" ? "confirmed" : "needs";
        }
      }
    }
  }
}

async function openProperty(propertyId) {
  cloud.propertyId = propertyId;
  visionRelease = null;
  approvedVisionRelease = null;
  const plansHref = `plans/?property=${encodeURIComponent(propertyId)}`;
  const operationsHref = `operations/?property=${encodeURIComponent(propertyId)}`;
  const plansNavigation = $("#plans-navigation");
  const operationsNavigation = $("#operations-navigation");
  const projectPlansLink = $("#project-plans-link");
  if (plansNavigation) plansNavigation.href = plansHref;
  if (operationsNavigation) operationsNavigation.href = operationsHref;
  if (projectPlansLink) projectPlansLink.href = plansHref;
  elements.propertyGate.hidden = true;
  elements.focusStudio.hidden = true;
  elements.shell.hidden = true;
  elements.autosave.textContent = "Loading property…";
  try {
    await hydrateCloudRecord();
    $("#connector-status").innerHTML = "<i></i> Supabase connected";
    elements.autosave.textContent = `Cloud connected · ${cloud.role}`;
    window.MDAIRecentProjects?.remember({ id: propertyId, name: propertyRecord.name });
    if (new URLSearchParams(window.location.search).get("advanced") === "1") {
      elements.shell.hidden = false;
      activateView("property");
      render();
      refreshVisionReleaseStatus().catch((error) => console.error("Vision release status", error));
    } else {
      elements.focusStudio.hidden = false;
      openFocusStudio();
    }
  } catch (error) {
    console.error(error);
    elements.shell.hidden = true;
    elements.focusStudio.hidden = true;
    elements.propertyGate.hidden = false;
    notify("This property could not be opened.");
  }
}

function showPropertyDirectory() {
  elements.shell.hidden = true;
  elements.focusStudio.hidden = true;
  elements.propertyGate.hidden = false;
  renderPropertyDirectory();
}

async function hydrateCloudContext() {
  if (!cloud.client || !cloud.session) return;
  const { data, error } = await cloud.client
    .from("organization_members")
    .select("organization_id, role")
    .eq("user_id", cloud.session.user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    cloud.schemaReady = false;
    $("#connector-status").innerHTML = "<i></i> Schema setup required";
    elements.autosave.textContent = "Cloud schema not applied";
    return;
  }
  if (!data) {
    cloud.schemaReady = true;
    $("#connector-status").innerHTML = "<i></i> Account needs organization";
    elements.autosave.textContent = "Signed in · Workspace setup required";
    $("#property-gate-message").textContent =
      "Create your first property to finish setting up your private workspace.";
    return;
  }
  cloud.schemaReady = true;
  cloud.organizationId = data.organization_id;
  cloud.role = data.role;
  $("#property-gate-message").textContent = "";
  try {
    await loadPropertyDirectory();
    $("#connector-status").innerHTML = "<i></i> Supabase connected";
    elements.autosave.textContent = `Cloud connected · ${data.role}`;
  } catch (recordError) {
    cloud.schemaReady = false;
    $("#connector-status").innerHTML = "<i></i> Cloud record unavailable";
    elements.autosave.textContent = "Cloud record could not load";
    console.error(recordError);
  }
}

async function enterWorkspace(session) {
  cloud.session = session;
  window.MDAIProjectIntake?.hide();
  elements.gate.hidden = true;
  elements.shell.hidden = true;
  elements.focusStudio.hidden = true;
  elements.propertyGate.hidden = false;
  $(".avatar").textContent = sessionInitials(session);
  await hydrateEvidenceFiles();
  await hydrateCloudContext();
  renderPropertyDirectory();
  await openStudioDeepLink();
}

/* A shared link is how spatial evidence reaches a headset: the same project
   route opens straight on the file that has to be inspected. */
async function openStudioDeepLink() {
  const params = new URLSearchParams(window.location.search);
  const propertyId = params.get("property");
  if (!propertyId || !cloud.organizationId) return;
  await openProperty(propertyId);
  /* The unread-rooms pointer promised reading, so it lands on the reading
     stage — the picker, already opened on a readable room — not one press
     short of it. Nothing runs: reading stays a person's deliberate click. */
  if (params.get("stage") === "read") showFocusStage("process");
  const evidenceId = params.get("evidence");
  if (!evidenceId) return;
  const { item, room } = tileFor(evidenceId);
  if (item) openEvidenceViewer(item, room);
  else notify("That evidence is not part of this project, or it has been removed.", 6000);
}

async function initializeAuth() {
  if (!cloud.client) {
    setAuthMessage(
      "Supabase client failed to load. Refresh and try again.",
      "error",
    );
    return;
  }
  const { data, error } = await cloud.client.auth.getSession();
  if (error) {
    setAuthMessage(error.message, "error");
    return;
  }
  const recoveryRequested = isPasswordRecoveryUrl();
  const recoveryError = passwordRecoveryUrlError();
  if (data.session && recoveryRequested) {
    elements.gate.hidden = false;
    openAccountSecurity("recovery", data.session);
  } else if (data.session) {
    await enterWorkspace(data.session);
  } else if (recoveryRequested) {
    setAuthMessage(
      recoveryError
        ? `This recovery link is invalid or expired. ${recoveryError}`
        : "This recovery link is invalid or expired. Request a new one.",
      "error",
    );
  }
  cloud.client.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT") {
      cloud.session = null;
      elements.shell.hidden = true;
      elements.focusStudio.hidden = true;
      elements.propertyGate.hidden = true;
      elements.gate.hidden = true;
      window.MDAIProjectIntake?.showLanding();
      setAuthMessage("Team workspace sign-in ready.");
    } else if (event === "PASSWORD_RECOVERY" && session) {
      elements.gate.hidden = false;
      openAccountSecurity("recovery", session);
    } else if (event === "SIGNED_IN" && session && isPasswordRecoveryUrl()) {
      elements.gate.hidden = false;
      openAccountSecurity("recovery", session);
    } else if (event === "SIGNED_IN" && session && !cloud.session) {
      window.setTimeout(() => enterWorkspace(session), 0);
    }
  });
}

function activateView(name) {
  document.querySelectorAll("[data-view]").forEach((view) => {
    const active = view.dataset.view === name;
    view.hidden = !active;
    view.classList.toggle("active", active);
  });
  document
    .querySelectorAll("[data-view-target]")
    .forEach((button) =>
      button.classList.toggle("active", button.dataset.viewTarget === name),
    );
  $("#sidebar").classList.remove("open");
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (name === "vision" && cloud.propertyId) {
    refreshVisionReleaseStatus().catch((error) => console.error("Vision release status", error));
  }
}

$("#continue-google").addEventListener("click", async () => {
  if (!cloud.client) {
    setAuthMessage("Supabase connection is unavailable.", "error");
    return;
  }
  const button = $("#continue-google");
  button.disabled = true;
  setAuthMessage("Opening secure Google sign-in…");
  const { error } = await cloud.client.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${window.location.origin}/studio/`,
      queryParams: {
        prompt: "select_account",
      },
    },
  });
  if (error) {
    button.disabled = false;
    setAuthMessage(error.message, "error");
  }
});

elements.authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!cloud.client) return;
  const submit = $("#enter-studio");
  const password = $("#auth-password").value;
  if (!password) {
    setAuthMessage("Enter your password or request a magic link.", "error");
    return;
  }
  submit.disabled = true;
  setAuthMessage("Verifying account…");
  const { data, error } = await cloud.client.auth.signInWithPassword({
    email: $("#auth-email").value.trim(),
    password,
  });
  submit.disabled = false;
  if (error) {
    setAuthMessage(error.message, "error");
    return;
  }
  setAuthMessage("Access granted.", "success");
  await enterWorkspace(data.session);
});
$("#send-magic-link").addEventListener("click", async () => {
  if (!cloud.client) return;
  const email = $("#auth-email").value.trim();
  if (!email) {
    setAuthMessage("Enter your authorized email address first.", "error");
    return;
  }
  const button = $("#send-magic-link");
  button.disabled = true;
  setAuthMessage("Sending secure sign-in link…");
  const { error } = await cloud.client.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: false,
      emailRedirectTo: `${window.location.origin}/studio/`,
    },
  });
  button.disabled = false;
  setAuthMessage(
    error ? error.message : "Magic link sent. Check your email.",
    error ? "error" : "success",
  );
});
$("#forgot-password").addEventListener("click", async () => {
  if (!cloud.client) return;
  const email = $("#auth-email").value.trim();
  if (!email) {
    setAuthMessage("Enter your authorized email address first.", "error");
    $("#auth-email").focus();
    return;
  }
  const button = $("#forgot-password");
  button.disabled = true;
  setAuthMessage("Sending password recovery email…");
  const { error } = await cloud.client.auth.resetPasswordForEmail(email, {
    redirectTo: PASSWORD_RECOVERY_REDIRECT,
  });
  button.disabled = false;
  setAuthMessage(
    error
      ? error.message
      : "Recovery link sent. Open the email on this device to choose a new password.",
    error ? "error" : "success",
  );
});
$("#account-security").addEventListener("click", () =>
  openAccountSecurity("set"),
);
$("#close-account-security").addEventListener("click", () => {
  if (accountSecurityMode !== "recovery") {
    elements.accountSecurityDialog.close();
  }
});
elements.accountSecurityForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!cloud.client || !cloud.session) return;
  const password = $("#new-account-password").value;
  const confirmation = $("#confirm-account-password").value;
  if (password.length < 8) {
    setAccountSecurityMessage("Use at least 8 characters.", "error");
    return;
  }
  if (password !== confirmation) {
    setAccountSecurityMessage("The passwords do not match.", "error");
    return;
  }
  const button = $("#save-account-password");
  button.disabled = true;
  setAccountSecurityMessage("Saving password…");
  const { error } = await cloud.client.auth.updateUser({ password });
  button.disabled = false;
  if (error) {
    setAccountSecurityMessage(error.message, "error");
    return;
  }
  setAccountSecurityMessage(
    "Password saved. Email and password sign-in is now active.",
    "success",
  );
  window.setTimeout(async () => {
    elements.accountSecurityDialog.close();
    if (accountSecurityMode === "recovery") {
      clearPasswordRecoveryUrl();
      const { data } = await cloud.client.auth.getSession();
      if (data.session) await enterWorkspace(data.session);
    } else {
      notify("Account password saved");
    }
  }, 700);
});
$("#sign-out").addEventListener("click", async () => {
  if (cloud.client) await cloud.client.auth.signOut();
});
$("#property-gate-sign-out").addEventListener("click", async () => {
  if (cloud.client) await cloud.client.auth.signOut();
});
$("#focus-sign-out").addEventListener("click", async () => {
  if (cloud.client) await cloud.client.auth.signOut();
});
$("#switch-property").addEventListener("click", showPropertyDirectory);
$("#focus-projects").addEventListener("click", showPropertyDirectory);
$("#focus-switch-project").addEventListener("click", showPropertyDirectory);

async function ensurePersonalOrganization() {
  if (cloud.organizationId) return true;
  const message = $("#property-gate-message");
  message.classList.remove("error");
  message.textContent = "Preparing your private workspace…";
  const user = cloud.session?.user;
  const displayName =
    user?.user_metadata?.full_name ||
    user?.user_metadata?.name ||
    user?.email?.split("@")[0] ||
    "My";
  const { data, error } = await cloud.client.rpc(
    "bootstrap_personal_organization",
    { workspace_name: `${displayName} Property Workspace` },
  );
  if (error) {
    console.error(error);
    message.classList.add("error");
    message.textContent =
      "Workspace setup is not active yet. Please contact the Studio administrator.";
    return false;
  }
  const membership = Array.isArray(data) ? data[0] : data;
  if (!membership?.organization_id) {
    message.classList.add("error");
    message.textContent = "The private workspace could not be created.";
    return false;
  }
  cloud.organizationId = membership.organization_id;
  cloud.role = membership.role || "owner";
  cloud.schemaReady = true;
  $("#connector-status").innerHTML = "<i></i> Supabase connected";
  elements.autosave.textContent = `Cloud connected · ${cloud.role}`;
  message.textContent = "";
  return true;
}

async function openPropertyDialog() {
  const ready = await ensurePersonalOrganization();
  if (!ready) return;
  $("#property-form").reset();
  $("#property-form-message").textContent = "";
  $("#property-dialog").showModal();
}

$("#create-property").addEventListener("click", openPropertyDialog);
$("#create-first-property").addEventListener("click", openPropertyDialog);
$("#property-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = $("#save-property");
  const name = $("#profile-property-name").value.trim();
  const city = $("#profile-city").value.trim() || "Project";
  const state = $("#profile-state").value.trim() || "Private";
  if (!name) return;
  const numberOrNull = (selector) => {
    const value = $(selector).value;
    return value === "" ? null : Number(value);
  };
  const address = {
    street: $("#profile-street").value.trim(),
    city,
    state,
    postal_code: $("#profile-postal").value.trim(),
    profile: {
      property_type: $("#profile-property-type").value,
      project_stage: $("#profile-project-stage").value,
      bedrooms: numberOrNull("#profile-bedrooms"),
      bathrooms: numberOrNull("#profile-bathrooms"),
      floors: numberOrNull("#profile-floors"),
      square_feet: numberOrNull("#profile-square-feet"),
      year_built: numberOrNull("#profile-year-built"),
      purpose: $("#profile-purpose").value.trim(),
    },
  };
  submit.disabled = true;
  submit.textContent = "Creating project…";
  const { data, error } = await cloud.client
    .from("properties")
    .insert({
      organization_id: cloud.organizationId,
      name,
      address,
      access_classification: "private",
      created_by: cloud.session.user.id,
    })
    .select("id, name, address, access_classification, created_at")
    .single();
  submit.disabled = false;
  submit.textContent = "Create project";
  if (error) {
    $("#property-form-message").textContent = `Project was not created: ${error.message}`;
    return;
  }
  cloud.properties.push(data);
  $("#property-dialog").close();
  renderPropertyDirectory();
  notify(`${name} project created`);
  await openProperty(data.id);
});
$("#mobile-menu").addEventListener("click", () =>
  $("#sidebar").classList.toggle("open"),
);
document
  .querySelectorAll("[data-view-target]")
  .forEach((button) =>
    button.addEventListener("click", () =>
      activateView(button.dataset.viewTarget),
    ),
  );

async function createRoomRecord({ name, building, level }) {
  let id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`;
  if (cloud.schemaReady && cloud.propertyId) {
    const { data, error } = await cloud.client
      .from("spaces")
      .insert({
        organization_id: cloud.organizationId,
        property_id: cloud.propertyId,
        name,
        building,
        level,
        review_state: "needs_review",
        created_by: cloud.session.user.id,
      })
      .select("id")
      .single();
    if (error) throw error;
    id = data.id;
  }
  const room = {
    id,
    name,
    building,
    level,
    status: "needs",
    note: "",
    evidence: [],
    visible: [],
    unknown: ["Evidence has not been uploaded or reviewed"],
  };
  rooms.push(room);
  return room;
}

/* ---------------------------------------------------------------------------
   Focus Studio.

   One route, no dead ends:
     Project today → Evidence → AI findings → Verification → Next action

   Every number on screen is attached to the thing it counts, and every status
   either opens something or explains why it cannot be opened yet.
   --------------------------------------------------------------------------- */

const FOCUS_STAGE_ORDER = { upload: 1, process: 2, results: 3 };
let focusStage = "upload";
let focusUploadBusy = false;
/* How many files the last upload actually carried. Zero means this screen is
   showing a project somebody came back to, not an upload that just finished. */
let focusLastUploadCount = 0;
let focusProcessingComplete = false;
let focusProcessingRows = [];
let uploadRoomId = "";
let analyzeRoomId = "";
let analyzeRoomChosen = false;
let focusSheetRoomId = null;
let focusSheetReturnStage = "today";

function focusAllEvidence() {
  return rooms.flatMap((room) => room.evidence || []);
}

function focusSourceCount(item) {
  return Array.isArray(item?.sourceIds) && item.sourceIds.length
    ? item.sourceIds.length
    : 1;
}

function focusIsCameraOriginal(item) {
  const name = String(item?.name || "").toLowerCase();
  return Boolean(
    item?.mimeType === "application/x-insta360-capture" || /\.(insv|insp|lrv)$/.test(name),
  );
}

function focusIsDocument(item) {
  const name = String(item?.name || "").toLowerCase();
  return Boolean(item?.mimeType === "application/pdf" || name.endsWith(".pdf"));
}

function focusEvidenceCategory(item) {
  if (focusIsCameraOriginal(item)) return "360";
  if (isImage(item)) return "photo";
  if (isVideo(item)) return "video";
  if (focusIsDocument(item)) return "document";
  return "file";
}

/* A file is spatial when it can actually be rendered as a sphere: an
   equirectangular export, not a protected camera original. */
function focusIsSpatial(item) {
  if (focusIsCameraOriginal(item) || !item?.src) return false;
  if (!isVideo(item) && !isImage(item)) return false;
  const meta = item.sourceMetadata || {};
  if (meta.vr?.playback_ready) return true;
  if (meta.ready_360) return true;
  if (meta.projection === "equirectangular") return true;
  const width = Number(meta.width);
  const height = Number(meta.height);
  if (width && height) {
    const ratio = width / height;
    if (ratio >= 1.9 && ratio <= 2.1) return true;
  }
  return /(360|equirect|spatial|pano)/.test(String(item.name || "").toLowerCase());
}

/* One policy decides the usable window, so the AI, the sphere viewer and the
   GPU master all read the same capture. Evidence uploaded before the policy
   existed still gets a window, computed from the stream that is playing. */
function evidenceTrimWindow(item, durationSeconds) {
  if (!window.MDAITrim360 || !item) return null;
  if (!isVideo(item) || !focusIsSpatial(item)) return null;
  return window.MDAITrim360.resolve(item.sourceMetadata || {}, durationSeconds);
}

/* Say what is hidden, wherever the file is listed. A window nobody is told
   about is indistinguishable from evidence quietly going missing. */
function focusEvidenceTrimNote(item) {
  const recorded = item?.sourceMetadata?.trim;
  if (recorded?.mode === "cut_at_processing") {
    return `${recorded.head_seconds}s cut from each end`;
  }
  const usable = evidenceTrimWindow(item, item?.sourceMetadata?.duration_seconds);
  if (!usable?.applied) return "";
  return usable.head_seconds === usable.tail_seconds
    ? `first and last ${usable.head_seconds}s hidden`
    : `first ${usable.head_seconds}s and last ${usable.tail_seconds}s hidden`;
}

function focusEvidenceLabel(item) {
  if (focusIsSpatial(item)) return "360";
  const category = focusEvidenceCategory(item);
  if (category === "360") return "Camera original";
  if (category === "photo") return "Photo";
  if (category === "video") return "Video";
  if (category === "document") return "Document";
  return "File";
}

function focusTimestamp(item) {
  const value = Date.parse(item?.createdAt || item?.capturedAt || "");
  return Number.isFinite(value) ? value : 0;
}

function focusDayKey(time) {
  /* The day boundary is the person's midnight, not Greenwich's. Grouped by UTC,
     an evening upload in California was reported as "added today" the next
     morning — the record claiming something happened on a day it did not. */
  if (!time) return "";
  const date = new Date(time);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function focusRelativeDay(time) {
  if (!time) return "date unavailable";
  // Calendar days in the person's timezone, not 24-hour buckets: an upload
  // last evening is "yesterday" even when fewer than twelve hours have passed.
  const today = focusDayKey(Date.now());
  const day = focusDayKey(time);
  if (day === today) return "today";
  if (day === focusDayKey(Date.now() - 86400000)) return "yesterday";
  const days = Math.round((Date.now() - time) / 86400000);
  if (days < 7) return `${days} days ago`;
  return new Date(time).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/* ------------------------------------------------------- 360 stitching queue */

const STITCH_ACTIVE_STATES = new Set(["waiting_for_sdk", "queued", "processing"]);

async function hydrateStitchJobs() {
  if (!cloud.schemaReady || !cloud.propertyId) return;
  const { data, error } = await cloud.client
    .from("capture_360_jobs")
    .select("id, state, stage, progress, error_code, updated_at, created_at, started_at, finished_at, capture_360_groups(capture_key, state)")
    .eq("property_id", cloud.propertyId)
    .order("created_at", { ascending: true });
  if (error) return;
  stitchJobs = (data || []).map((job) => ({
    id: job.id,
    state: job.state,
    stage: job.stage || "",
    progress: Number(job.progress) || 0,
    error: job.error_code || "",
    captureKey: job.capture_360_groups?.capture_key || "",
    queuedAt: job.created_at || null,
    startedAt: job.started_at || null,
    finishedAt: job.finished_at || null,
  }));
}

/* The machine's own account of itself.

   Until this existed the Studio inferred the machine's state from our job rows:
   nothing marked 'processing' was read as "the machine is not running". That is
   a fact about our database, not about a computer in Ohio, and it was wrong
   often enough that a person waited on a machine that had already stopped. Now
   the machine writes one row per boot and this reads it. */
async function hydrateMachineRun() {
  if (!cloud.schemaReady) return;
  const { data, error } = await cloud.client
    .from("worker_machine_runs")
    .select("state, step, message, exit_code, jobs_claimed, jobs_completed, jobs_failed, started_at, last_seen_at, finished_at, instance_id")
    .order("started_at", { ascending: false })
    .limit(1);
  /* An error is not silence. If the record cannot answer, say nothing about the
     machine rather than announcing that it never reported. */
  if (error) return;
  machineRunLoaded = true;
  machineRun = data?.[0] || null;
}

/* How long silence is allowed to last before it means the machine went away
   rather than that it is busy — and it depends entirely on what it is doing.
   Once it is working the queue, every step is shorter than three minutes, so
   three minutes of quiet is a machine that died.
   Preparing is a different animal: fetching the licensed SDK and building the
   worker image emit nothing between them and take ten to twenty minutes the
   first time. Three minutes there declared a perfectly healthy machine dead and
   told somebody to start the machine that was already building itself. */
const MACHINE_SILENT_MINUTES = 3;
const MACHINE_PREPARING_MINUTES = 25;

function machineSilenceAllowance(state) {
  return state === "starting" || state === "preparing"
    ? MACHINE_PREPARING_MINUTES
    : MACHINE_SILENT_MINUTES;
}

function machineStatus() {
  if (!machineRunLoaded) return { known: false };
  if (!machineRun) return { known: true, everRan: false };
  const seen = Date.parse(machineRun.last_seen_at || machineRun.started_at || "");
  const minutes = Number.isFinite(seen) ? Math.floor((Date.now() - seen) / 60000) : null;
  const finished = machineRun.state === "finished" || machineRun.state === "stopped";
  const preparing = machineRun.state === "starting" || machineRun.state === "preparing";
  return {
    known: true,
    everRan: true,
    finished,
    stopped: machineRun.state === "stopped",
    preparing: preparing && !finished,
    /* minutes is checked against null on purpose: an unreadable timestamp is not
       a machine that reported one second ago. */
    awake: !finished && minutes != null && minutes < machineSilenceAllowance(machineRun.state),
    minutes,
    step: machineRun.step || "",
    message: machineRun.message || "",
    exitCode: machineRun.exit_code,
    claimed: Number(machineRun.jobs_claimed) || 0,
    completed: Number(machineRun.jobs_completed) || 0,
    failed: Number(machineRun.jobs_failed) || 0,
  };
}

function machineAgo(minutes) {
  if (minutes == null) return "";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/* One sentence about the machine, and only what it actually said. */
function machineLine() {
  const machine = machineStatus();
  if (!machine.known) return "";
  if (!machine.everRan) return "The 360 machine has never reported in";
  /* Without a readable time there is no "ago" to give, and inventing one would
     turn an hour-old machine into a live one. */
  if (machine.minutes == null) {
    return `The 360 machine reported "${machine.step || "an unnamed step"}" without a readable time`;
  }
  if (machine.awake) {
    /* Building itself is not the same as working the queue, and a person
       waiting deserves to know which one they are watching. */
    if (machine.preparing) {
      return `The 360 machine is getting itself ready — ${machine.step || "preparing"}`;
    }
    const done = machine.completed ? ` · ${machine.completed} stitched so far` : "";
    return `The 360 machine is running — ${machine.step || "working"}${done}`;
  }
  if (machine.stopped) {
    const untouched = machine.claimed ? "" : " No capture was touched.";
    const why = machine.message ? ` — ${machine.message}` : "";
    const code = machine.exitCode != null ? ` (code ${machine.exitCode})` : "";
    return `The 360 machine stopped ${machineAgo(machine.minutes)}${why}${code}.${untouched}`;
  }
  if (machine.finished) {
    const failed = machine.failed ? `, ${machine.failed} failed` : "";
    return `The 360 machine finished ${machineAgo(machine.minutes)} — ${machine.completed} capture${machine.completed === 1 ? "" : "s"} stitched${failed}`;
  }
  return `The 360 machine last reported ${machineAgo(machine.minutes)}, at "${machine.step || "an unnamed step"}", and has said nothing since`;
}

function stitchSummary() {
  const active = stitchJobs.filter((job) => STITCH_ACTIVE_STATES.has(job.state));
  const running = active.filter((job) => job.state === "processing");
  const failed = stitchJobs.filter((job) => job.state === "failed");
  return { active, running, failed, done: stitchJobs.filter((job) => job.state === "completed") };
}

/* How long a stitch actually took, from the record's own stamps rather than
   from anybody's stopwatch. Kept apart from the wait: a machine that had to
   wake up first is a slow start, not a slow stitch, and rolling them together
   would quietly answer the wrong question. */
function stitchDuration(job) {
  const from = Date.parse(job?.startedAt || "");
  const to = Date.parse(job?.finishedAt || "");
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return "";
  const seconds = Math.round((to - from) / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/* What a person actually needs to know: is anything happening, and is the
   machine that does it awake. A queued job with no worker running is not
   progress, and saying so is the difference between waiting and being stuck. */
function stitchLine() {
  const { active, running, failed } = stitchSummary();
  const machine = machineLine();
  if (running.length) {
    const job = running[0];
    const extra = running.length > 1 ? ` (+${running.length - 1} more)` : "";
    return `Stitching now — ${job.stage || "working"} · ${job.progress}%${extra}`;
  }
  if (active.length) {
    const waiting = `${active.length} capture${active.length === 1 ? "" : "s"} queued for stitching`;
    return machine ? `${waiting} · ${machine}` : waiting;
  }
  if (failed.length) {
    const broke = `${failed.length} capture${failed.length === 1 ? "" : "s"} failed to stitch${failed[0].error ? ` — ${failed[0].error}` : ""}`;
    return machine ? `${broke} · ${machine}` : broke;
  }
  /* Nothing queued is not nothing to say: a machine that is awake, or that
     stopped at a gate an hour ago, is exactly what a person is looking for.
     And when the queue is empty because the work is done, how long the last
     one took is the number that decides whether this happens every week. */
  const machineNow = machineStatus();
  const { done } = stitchSummary();
  const lastDone = done[done.length - 1];
  const took = stitchDuration(lastDone);
  const idle = machineNow.awake || machineNow.stopped ? machine : "";
  if (!took) return idle;
  const sentence = `Last capture stitched in ${took}`;
  return idle ? `${idle} · ${sentence.toLowerCase()}` : sentence;
}

/* Poll only while something is in flight, and stop as soon as it lands. A
   finished stitch means a new file exists, so the project is reloaded rather
   than left showing a record that is already out of date. */
function scheduleStitchPoll() {
  window.clearTimeout(stitchPollTimer);
  /* Keep watching while the machine is awake even with nothing queued: it may be
     building itself, and a person waiting deserves to see that finish. */
  if (!stitchSummary().active.length && !machineStatus().awake) return;
  stitchPollTimer = window.setTimeout(async () => {
    const before = stitchSummary().active.length;
    await hydrateStitchJobs();
    await hydrateMachineRun();
    const after = stitchSummary().active.length;
    if (after < before) {
      await hydrateCloudRecord().catch(() => {});
      render();
      notify("A 360 capture finished stitching and is now playable", 6000);
    }
    renderFocusStudio();
    scheduleStitchPoll();
  }, 10000);
}

function roomLastActivity(room) {
  return (room?.evidence || []).reduce((latest, item) => Math.max(latest, focusTimestamp(item)), 0);
}

function focusEvidenceStats() {
  const items = focusAllEvidence();
  const spaces = rooms.filter((room) => room.evidence?.length);
  const categories = { photo: 0, video: 0, document: 0, "360": 0, file: 0 };
  items.forEach((item) => {
    categories[focusEvidenceCategory(item)] += focusSourceCount(item);
  });
  const paired360 = items.filter(
    (item) => focusIsCameraOriginal(item) && (item.sourceIds?.length || 0) >= 2,
  ).length;
  const waiting360 = items.filter(
    (item) => focusIsCameraOriginal(item) && (item.sourceIds?.length || 0) < 2,
  ).length;
  const spatial = items.filter(focusIsSpatial);
  const documents = items.filter(focusIsDocument);
  const analyzableRooms = spaces.filter((room) =>
    room.evidence.some((item) => isImage(item) || isVideo(item)),
  );
  const analyzedRooms = spaces.filter((room) => room.analysis);
  /* The screen has to point at what just happened, not at the oldest thing that
     was never finished. Sorting by when a space last received evidence is what
     stops a room from six weeks ago sitting on top of the files uploaded five
     minutes ago. */
  const byRecentEvidence = (a, b) => roomLastActivity(b) - roomLastActivity(a);
  const awaitingReview = spaces
    .filter((room) => room.analysis && room.status !== "confirmed")
    .sort(byRecentEvidence);
  const confirmedRooms = spaces.filter((room) => room.status === "confirmed");
  const unanalyzedRooms = analyzableRooms.filter((room) => !room.analysis).sort(byRecentEvidence);
  const followUps = spaces.flatMap((room) =>
    (room.analysis?.follow_up_captures || []).map((entry) => ({
      room,
      request: entry.request || "Additional capture",
      reason: entry.reason || "",
    })),
  );
  const openQuestions = spaces.flatMap((room) =>
    room.analysis ? (room.unknown || []).map((text) => ({ room, text })) : [],
  );
  const lastUpdate = items.reduce((latest, item) => Math.max(latest, focusTimestamp(item)), 0);
  const lastDay = focusDayKey(lastUpdate);
  const latestBatch = lastDay ? items.filter((item) => focusDayKey(focusTimestamp(item)) === lastDay) : [];
  return {
    items,
    spaces,
    categories,
    rawFiles: items.reduce((total, item) => total + focusSourceCount(item), 0),
    paired360,
    waiting360,
    stitch: stitchSummary(),
    stitchLine: stitchLine(),
    spatial,
    documents,
    vrPlayback: spatial.length,
    analyzableRooms,
    analyzedRooms,
    awaitingReview,
    confirmedRooms,
    unanalyzedRooms,
    followUps,
    openQuestions,
    lastUpdate,
    latestBatch,
  };
}

function inferFocusMediaType(file) {
  const name = String(file?.name || "").toLowerCase();
  if (/\.(insv|insp|lrv)$/.test(name)) return "360 camera original";
  if (file?.type?.startsWith("image/")) return "Photo";
  if (file?.type?.startsWith("video/")) return "Video";
  if (file?.type === "application/pdf" || name.endsWith(".pdf")) return "Plan or document";
  return "Project evidence";
}

/* Measure the file instead of guessing from its name. An Insta360 Studio export
   keeps the camera's filename — VID_20250222_043654_00_027.mp4 — which contains
   no hint that it is a sphere, so name matching alone silently files a real 360
   master as ordinary video. */
function measureMediaFile(file) {
  const fileIsVideo = Boolean(file?.type?.startsWith("video/"));
  const fileIsImage = Boolean(file?.type?.startsWith("image/"));
  if (!fileIsVideo && !fileIsImage) return Promise.resolve({});
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const element = document.createElement(fileIsVideo ? "video" : "img");
    const finish = (measured = {}) => {
      URL.revokeObjectURL(url);
      resolve(measured);
    };
    const timeout = window.setTimeout(() => finish(), 15000);
    const done = (measured) => {
      window.clearTimeout(timeout);
      finish(measured);
    };
    if (fileIsVideo) {
      element.preload = "metadata";
      element.onloadedmetadata = () => done({
        width: Number(element.videoWidth || 0),
        height: Number(element.videoHeight || 0),
        duration_seconds: Number(element.duration || 0),
      });
    } else {
      element.onload = () => done({
        width: Number(element.naturalWidth || 0),
        height: Number(element.naturalHeight || 0),
      });
    }
    element.onerror = () => done({});
    element.src = url;
  });
}

/* A full sphere is 2:1. The tolerance matches the rest of the pipeline, including
   the database function that links an export back to its camera originals. */
function equirectangularProjection(measured) {
  const width = Number(measured?.width || 0);
  const height = Number(measured?.height || 0);
  if (!width || !height) return null;
  const ratio = width / height;
  return ratio >= 1.9 && ratio <= 2.1 ? "equirectangular" : null;
}

/* Insta360 Studio keeps the camera name, so the export and its protected pair
   share a capture key once the lens marker is dropped. */
function exportCaptureKey(name) {
  const lower = String(name || "").toLowerCase();
  if (!/\.(mp4|mov|m4v)$/.test(lower)) return null;
  const stem = lower.replace(/\.(mp4|mov|m4v)$/, "");
  const match = stem.match(/^(.*)_(00|10)_([0-9]+)$/);
  return match ? `${match[1]}_${match[3]}` : stem;
}

function focusVrMetadata(file, measured = {}) {
  const name = String(file?.name || "").toLowerCase();
  if (/\.(insv|insp|lrv)$/.test(name)) {
    return {
      role: "camera_original",
      format: name.split(".").pop(),
      original_preserved: true,
      playback_ready: false,
    };
  }
  const projection = equirectangularProjection(measured);
  const namedSpatial = file?.type?.startsWith("video/") && /(360|equirect|spatial|pano)/.test(name);
  const spatial = Boolean(projection) || namedSpatial;
  return {
    role: spatial ? "equirectangular_playback" : "supporting_evidence",
    original_preserved: true,
    playback_ready: spatial,
  };
}

function focusFileAllowed(file) {
  const name = String(file?.name || "").toLowerCase();
  return Boolean(
    file?.type?.startsWith("image/") ||
    file?.type?.startsWith("video/") ||
    file?.type === "application/pdf" ||
    /\.(pdf|insv|insp|lrv)$/.test(name),
  );
}

/* ------------------------------------------------------------- Room selection */

/* Buildings and rooms both come from the approved plan set — Main House, ADU,
   room by room. The picker never invents a destination, and there is no inbox
   to fall into: a file whose room nobody chose is a file nobody can answer for. */
function projectBuildings() {
  const names = [...new Set(rooms.map((room) => room.building || "Property"))];
  return names.sort((a, b) => a.localeCompare(b));
}

function roomsInBuilding(building) {
  return rooms
    .filter((room) => (room.building || "Property") === building)
    .sort((a, b) => `${a.level || ""}${a.name}`.localeCompare(`${b.level || ""}${b.name}`));
}

function fillRoomPicker(prefix, selectedRoomId, onChange, labelFor) {
  const buildingSelect = $(`#${prefix}-building`);
  const roomSelect = $(`#${prefix}-room`);
  if (!buildingSelect || !roomSelect) return;
  const buildings = projectBuildings();
  const current = rooms.find((room) => room.id === selectedRoomId);
  const building = current?.building || buildingSelect.value || buildings[0] || "";
  buildingSelect.innerHTML = buildings.length
    ? buildings.map((name) => `<option value="${escapeText(name)}"${name === building ? " selected" : ""}>${escapeText(name)}</option>`).join("")
    : `<option value="">No plan has been read yet</option>`;
  const list = roomsInBuilding(buildingSelect.value || building);
  roomSelect.innerHTML = list.length
    ? list
        .map((room) => {
          const base = room.level ? `${room.name} · ${room.level}` : room.name;
          const suffix = labelFor ? labelFor(room) : "";
          return `<option value="${escapeText(room.id)}"${room.id === selectedRoomId ? " selected" : ""}>${escapeText(
            suffix ? `${base} ${suffix}` : base,
          )}</option>`;
        })
        .join("")
    : `<option value="">No room in this building yet</option>`;
  if (!buildingSelect.dataset.wired) {
    buildingSelect.dataset.wired = "1";
    buildingSelect.addEventListener("change", () => {
      fillRoomPicker(prefix, roomsInBuilding(buildingSelect.value)[0]?.id || "", onChange);
      onChange?.();
    });
    roomSelect.addEventListener("change", () => onChange?.());
  }
}

function pickedRoom(prefix) {
  return rooms.find((room) => room.id === $(`#${prefix}-room`)?.value) || null;
}

function renderUploadPicker() {
  fillRoomPicker("upload", uploadRoomId || rooms[0]?.id || "", () => {
    uploadRoomId = $("#upload-room").value || "";
    renderUploadPickerNote();
  });
  uploadRoomId = $("#upload-room")?.value || uploadRoomId;
  renderUploadPickerNote();
}

/* The picker's default is a room the AI can actually read — unread captures
   first. "Which room should the AI read?" answered with an empty room that
   happens to sort first is a question answered with a dead end. */
function analyzeReadableRoom(room) {
  return (room.evidence || []).some((item) => isImage(item) || isVideo(item));
}
function analyzeDefaultRoomId() {
  const uploadRoom = rooms.find((room) => room.id === uploadRoomId);
  if (uploadRoom && analyzeReadableRoom(uploadRoom)) return uploadRoom.id;
  return rooms.find((room) => analyzeReadableRoom(room) && !room.analysis)?.id
    || rooms.find((room) => analyzeReadableRoom(room))?.id
    || rooms[0]?.id || "";
}

function renderAnalyzePicker() {
  /* A stale remembered room only wins if a person actually chose it — the
     value auto-captured from an earlier render of a half-loaded select is
     not a choice, and honouring it is how the stage opened on "This room
     is empty" while a readable room sat two entries down. */
  const remembered = rooms.find((room) => room.id === analyzeRoomId);
  const defaultId = (analyzeRoomChosen && remembered) || (remembered && analyzeReadableRoom(remembered))
    ? analyzeRoomId
    : analyzeDefaultRoomId();
  fillRoomPicker("analyze", defaultId, () => {
    analyzeRoomId = $("#analyze-room").value || "";
    analyzeRoomChosen = true;
    renderAnalyzePickerNote();
  }, (room) => (analyzeReadableRoom(room)
    ? (room.analysis ? "· read" : "· ready to read")
    : "· nothing to read yet"));
  analyzeRoomId = $("#analyze-room")?.value || analyzeRoomId;
  renderAnalyzePickerNote();
}

function renderAnalyzePickerNote() {
  const room = pickedRoom("analyze");
  const note = $("#analyze-room-note");
  const run = $("#analyze-room-run");
  if (!note || !run) return;
  const visual = room ? (room.evidence || []).filter((item) => isImage(item) || isVideo(item)) : [];
  if (!room) {
    note.className = "room-picker-note warn";
    note.textContent = "Choose a room to read.";
    run.disabled = true;
    return;
  }
  if (!visual.length) {
    /* The same sentence the button would give, said before it is pressed.
       This note kept its own generic wording — "holds nothing the AI can read,
       add a 360 capture or photos" — for a room holding a complete 360 pair
       waiting on the machine. Two places deciding the same thing, and the one a
       person actually reads was the stale one. */
    note.className = "room-picker-note warn";
    note.textContent = analysisBlocker(room) || `${room.name} holds nothing the AI can read.`;
    run.disabled = true;
    return;
  }
  /* "1 file in Master Bedroom 205A" after uploading two of them reads as a lost
     file. It was never a count of what is in the room — it is a count of what
     the AI can read, and the two camera originals behind it became one stitched
     capture. Say both numbers, so the arithmetic a person does in their head
     comes out right. */
  const originals = (room.evidence || []).filter(focusIsCameraOriginal)
    .reduce((total, item) => total + focusSourceCount(item), 0);
  const preserved = originals
    ? ` · ${originals} camera original${originals === 1 ? "" : "s"} preserved behind ${originals === 1 ? "it" : "them"}`
    : "";
  note.className = "room-picker-note";
  note.textContent = `${visual.length} capture${visual.length === 1 ? "" : "s"} the AI can read in ${room.name}${preserved}${
    room.analysis ? " · already read once, reading again replaces the interpretation" : ""
  }.`;
  run.disabled = false;
  run.textContent = room.analysis ? `Read ${room.name} again` : `Read ${room.name}`;
}

/* A PDF in a project with no rooms is almost certainly the drawings. Judged by
   what it is rather than by what was intended, because the intent is not
   knowable and the file type is. */
function focusIsPlanDocument(file) {
  const name = String(file?.name || "").toLowerCase();
  return file?.type === "application/pdf" || name.endsWith(".pdf");
}

/* Where the plan set actually stands, because "no rooms yet" has three
   different causes and only one of them is answered by "upload the plans".
   Rooms are created when a person approves the roadmap the plans produced —
   analysing them is not enough — so a project that has been read but not
   approved was told to upload plans it already had, which is the same dead end
   one screen further along. */
let planState = { known: false, documents: 0, analysed: false, baseline: null };

async function hydratePlanState(propertyId) {
  planState = { known: false, documents: 0, analysed: false, baseline: null };
  if (!cloud.schemaReady) return;
  const [documents, baselines] = await Promise.all([
    cloud.client.from("project_documents").select("id, status").eq("property_id", propertyId),
    cloud.client.from("document_baselines").select("id, state, version").eq("property_id", propertyId)
      .order("version", { ascending: false }).limit(1),
  ]);
  /* A record that cannot answer is not a record that says no. Saying nothing
     about the plans is better than telling somebody to upload a set they have
     already uploaded. */
  if (documents.error || baselines.error) return;
  planState = {
    known: true,
    documents: (documents.data || []).length,
    analysed: (documents.data || []).some((row) => row.status === "analyzed"),
    baseline: (baselines.data || [])[0] || null,
  };
}

/* One sentence naming where the plan set stands, and the control that moves it
   on. Every branch ends in something pressable. */
function planSetNextStep() {
  if (!planState.known) {
    return { say: "This project has no rooms yet. Rooms come from the plan set, which is read on its own screen.", go: "Open project plans" };
  }
  const baseline = planState.baseline;
  if (baseline && ["draft", "review"].includes(baseline.state)) {
    return {
      say: "The plans have been read. The rooms they name become this project's rooms once you approve the roadmap — that approval is what creates them.",
      go: "Review and approve the roadmap",
    };
  }
  if (baseline && baseline.state === "approved") {
    return {
      say: "The roadmap is approved but this project still has no rooms, which means the plan reading found none. Open the plans to see what it read.",
      go: "Open project plans",
    };
  }
  if (planState.documents) {
    return {
      say: `The plan set is in this project and has not been read yet. Reading it is what produces the rooms. ${planState.documents === 1 ? "1 document is" : `${planState.documents} documents are`} waiting.`,
      go: "Read the plans",
    };
  }
  return {
    say: "This project has no rooms yet, and rooms come from the plan set. Plans are read on their own screen — the drawings are not evidence about a room, they are what the rooms are taken from.",
    go: "Upload the plan set",
  };
}

function renderUploadPickerNote() {
  const room = pickedRoom("upload");
  const note = $("#upload-room-note");
  const card = document.querySelector(".focus-upload-card");
  if (!note) return;
  if (!rooms.length) {
    /* A brand-new project used to deadlock here: no file may be uploaded
       without a room, rooms come from the plan set, and the plan set is
       uploaded somewhere this screen never named. The sentence gave the right
       answer and no way to act on it. */
    const step = planSetNextStep();
    note.className = "room-picker-note warn";
    note.innerHTML = `${escapeText(step.say)} <button type="button" class="room-picker-link" id="upload-open-plans">${escapeText(step.go)} &rarr;</button>`;
    const toPlans = $("#upload-open-plans");
    if (toPlans) toPlans.addEventListener("click", openProjectPlans);
  } else if (!room) {
    note.className = "room-picker-note warn";
    note.textContent = "Choose the room before adding files.";
  } else {
    const files = (room.evidence || []).length;
    note.className = "room-picker-note";
    note.textContent = files
      ? `Everything you add now goes into ${room.name}, which already holds ${files} file${files === 1 ? "" : "s"}.`
      : `Everything you add now goes into ${room.name}, which is empty so far.`;
  }
  if (card) card.classList.toggle("disabled", !room);
}

async function ensureFocusDestination(file) {
  /* An export belongs with the capture it came from, not in a general inbox:
     same room, so the sphere sits beside the protected originals. */
  const chosen = rooms.find((room) => room.id === uploadRoomId);
  if (chosen) return chosen;
  /* An export still joins the capture it was stitched from, so re-uploading a
     master lands beside its originals rather than needing to be re-filed. */
  const captureKey = exportCaptureKey(file?.name);
  if (captureKey) {
    /* Rooms holding that capture — plural, deliberately.
     *
     * This used to take the first room it found. The same capture legitimately
     * sits in two rooms, and then "first" means whichever the array happened to
     * order first: an export filed somewhere nobody chose, silently, which is
     * the fault behind most of a day of reports.
     *
     * One room is an answer. Two is a question, and a question belongs to the
     * person, so it falls through to the picker below. */
    const holders = rooms.filter((room) =>
      (room.evidence || []).some(
        (item) =>
          item.sourceMetadata?.insta360_capture_key === captureKey ||
          insta360CaptureKey(item) === captureKey,
      ),
    );
    if (holders.length === 1) return holders[0];
    if (holders.length > 1) {
      throw new Error(
        `The originals for this capture are in ${holders.length} rooms — ${holders
          .map((room) => room.name)
          .join(", ")}. Choose the room this export belongs to above, then add it again.`,
      );
    }
  }
  /* A plan set dropped on the evidence screen is not a mistake worth scolding.
     It is the right file at the wrong door, and the person needs the other door
     rather than a rule. */
  if (focusIsPlanDocument(file)) {
    throw Object.assign(
      new Error("This looks like a plan set. Plans are read on their own screen, and the rooms come from them — open Project plans and add it there."),
      { openPlans: true },
    );
  }
  throw new Error(
    rooms.length
      ? "Choose the building and room before uploading — a file with no room cannot be answered for."
      : "This project has no rooms yet. Upload the plan set first: the rooms come from it, and evidence belongs to a room.",
  );
}

/* One way in, one way out.
 *
 * This function used to both set the stage and render most of the Studio, while
 * the whole-Studio render ended by calling it. Two renderers, each the other's
 * tail, and neither the single place a change goes through — so a screen was
 * rebuilt only when the path somebody happened to take passed through the right
 * one. That is how the results card kept answering with the room that was
 * current when the project opened.
 *
 * Now: showFocusStage changes state and renders. applyFocusStage only paints
 * from state and never renders anything else, so there is no way round. */
function showFocusStage(name) {
  focusStage = FOCUS_STAGE_ORDER[name] ? name : "upload";
  closeFocusSheet(false);
  renderFocusStudio();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function applyFocusStage() {
  $("#focus-upload-stage").hidden = focusStage !== "upload";
  $("#focus-processing-stage").hidden = focusStage !== "process";
  $("#focus-results-stage").hidden = focusStage !== "results";
  /* The processing screen only means something while a run is in flight. Opened
     with nothing running it kept its hardcoded "Processing… 0% Starting…" —
     a dead screen indistinguishable from a hang. Say what is actually true:
     nothing is running, and here is the way forward. */
  if (focusStage === "process" && !focusProcessingRows.length) {
    /* The meter read 0% directly above a line saying 18%. The progress of the
       thing actually running is the progress this screen is about. */
    const stitch = stitchSummary();
    renderFocusProcessing(
      stitch.running.length ? stitchProgressPercent(stitch) : 0,
      stitch.active.length ? stitchLine() : "Idle",
    );
    $("#focus-view-results").disabled = false;
    $("#focus-view-results").textContent = "Open the record";
  }
  const stats = focusEvidenceStats();
  /* Several actions jump to Upload — add the export, upload more, send a task
     from an empty space. Without a way back that jump is a trapdoor, so every
     step already reached stays clickable. */
  const reachable = {
    upload: true,
    process: focusProcessingComplete || focusProcessingRows.length > 0,
    results: stats.rawFiles > 0,
  };
  document.querySelectorAll("[data-focus-step]").forEach((item) => {
    const step = item.dataset.focusStep;
    if (step === "project") {
      item.classList.add("complete");
      item.classList.remove("active");
      return;
    }
    item.classList.toggle("active", step === focusStage);
    item.classList.toggle(
      "complete",
      (step === "upload" && stats.rawFiles > 0 && focusStage !== "upload") ||
      (step === "process" && focusProcessingComplete && focusStage === "results") ||
      FOCUS_STAGE_ORDER[step] < FOCUS_STAGE_ORDER[focusStage],
    );
    const canOpen = Boolean(reachable[step]) && step !== focusStage;
    item.classList.toggle("reachable", canOpen);
    /* A step that answers by explaining what is missing is still a control, so
       it is announced and reachable by keyboard like any other. */
    const answers = canOpen || (step !== focusStage && Boolean(stepIsNotReadyYet(step)));
    item.classList.toggle("answers", answers && !canOpen);
    item.setAttribute("role", answers ? "button" : "presentation");
    item.tabIndex = answers ? 0 : -1;
  });
}

/* -------------------------------------------------------------- Project today */

function focusNextAction(stats) {
  if (!stats.rawFiles) {
    return {
      title: "Add the first evidence",
      copy: "Plans, photos, video, or Insta360 originals. Nothing can be understood before something is observed.",
      label: "Add evidence",
      owner: "Field operator or project manager",
      run: () => showFocusStage("upload"),
    };
  }
  if (stats.unanalyzedRooms.length) {
    const names = stats.unanalyzedRooms.slice(0, 2).map((room) => room.name).join(", ");
    return {
      title: `Run the AI review on ${stats.unanalyzedRooms.length} space${stats.unanalyzedRooms.length === 1 ? "" : "s"}`,
      copy: `${names}${stats.unanalyzedRooms.length > 2 ? " and others" : ""} ${stats.unanalyzedRooms.length === 1 ? "holds" : "hold"} visual evidence that has not been interpreted yet.`,
      label: "Choose a room to read",
      owner: "Automatic · you stay in control of the result",
      run: () => showFocusStage("process"),
    };
  }
  if (stats.awaitingReview.length) {
    const room = stats.awaitingReview[0];
    return {
      title: `Verify what the AI found in ${room.name}`,
      copy: "The AI interpretation is a suggestion. It becomes part of the record only after a person confirms it.",
      label: `Open ${room.name}`,
      owner: "Project manager or reviewer",
      run: () => openFocusSheet(room.id, "results"),
    };
  }
  if (stats.followUps.length) {
    const followUp = stats.followUps[0];
    return {
      title: "Request another capture",
      copy: `${followUp.room.name}: ${followUp.request}${followUp.reason ? ` — ${followUp.reason}` : ""}`,
      label: "Open field operations",
      owner: "Field operator",
      run: () => openFieldOperations(),
    };
  }
  if (!stats.spatial.length && (stats.paired360 || stats.waiting360)) {
    return {
      title: "Add the 360 export for headset review",
      copy: "Camera originals are preserved, but a full equirectangular MP4 is what makes the space walkable in the viewer and in Vision Pro.",
      label: "Upload the 360 export",
      owner: "Field operator",
      run: () => showFocusStage("upload"),
    };
  }
  if (stats.spatial.length) {
    return {
      title: "Walk the verified record",
      copy: "Every space with evidence has been reviewed. Open the spatial record to inspect the result in place.",
      label: "Open 360 view",
      owner: "Project manager",
      run: () => openFirstSpatial(),
    };
  }
  return {
    title: "Capture the next round",
    copy: "The current record is verified. The next observation is what shows whether anything changed.",
    label: "Add evidence",
    owner: "Field operator",
    run: () => showFocusStage("upload"),
  };
}

function focusChainItems(stats) {
  const analyzed = stats.analyzedRooms.length;
  const analyzable = stats.analyzableRooms.length;
  const confirmed = stats.confirmedRooms.length;
  const verifiable = stats.spaces.length;
  const decided = stats.spaces.filter((room) => room.status === "confirmed" && (room.note || "").trim()).length;
  return [
    {
      key: "plans",
      label: "Plans and documents received",
      state: stats.documents.length ? "done" : "waiting",
      detail: stats.documents.length
        ? `${stats.documents.length} document${stats.documents.length === 1 ? "" : "s"} in the record`
        : "No plan or specification has been uploaded yet",
      actionLabel: "Open plans",
      run: () => openProjectPlans(),
    },
    {
      key: "evidence",
      label: "Evidence received",
      state: stats.rawFiles ? "done" : "waiting",
      detail: stats.rawFiles
        ? `${stats.rawFiles} original file${stats.rawFiles === 1 ? "" : "s"} across ${stats.spaces.length} space${stats.spaces.length === 1 ? "" : "s"}`
        : "Nothing has been observed yet",
      actionLabel: stats.rawFiles ? "See evidence" : "Add evidence",
      run: () => (stats.rawFiles ? showFocusStage("results") : showFocusStage("upload")),
    },
    {
      key: "ai",
      label: "AI review completed",
      state: analyzable && analyzed >= analyzable ? "done" : analyzed ? "active" : "waiting",
      detail: analyzable
        ? `${analyzed} of ${analyzable} visual space${analyzable === 1 ? "" : "s"} interpreted`
        : "No photo or video evidence to interpret yet",
      actionLabel: analyzable && analyzed < analyzable ? "Start AI review" : "See findings",
      run: () =>
        analyzable && analyzed < analyzable ? processFocusEvidence() : showFocusStage("results"),
      blocked: analyzable ? "" : "Upload a photo or video before the AI can interpret a space.",
    },
    {
      key: "verify",
      label: "Human verification",
      state: verifiable && confirmed >= verifiable ? "done" : confirmed ? "active" : "waiting",
      detail: verifiable
        ? `${confirmed} of ${verifiable} space${verifiable === 1 ? "" : "s"} confirmed by a person`
        : "No space is ready for verification",
      actionLabel: "Open verification",
      run: () => {
        const target = stats.awaitingReview[0] || stats.spaces[0];
        if (target) openFocusSheet(target.id, "results");
      },
      blocked: verifiable ? "" : "Verification opens once a space holds evidence.",
    },
    {
      key: "decision",
      label: "Decision recorded",
      state: verifiable && decided >= verifiable ? "done" : decided ? "active" : "waiting",
      detail: verifiable
        ? `${decided} of ${verifiable} confirmed space${verifiable === 1 ? "" : "s"} carry a written factual note`
        : "A decision needs a verified space first",
      actionLabel: "Write the note",
      run: () => {
        const target =
          stats.spaces.find((room) => room.status === "confirmed" && !(room.note || "").trim()) ||
          stats.awaitingReview[0] ||
          stats.spaces[0];
        if (target) openFocusSheet(target.id, "results");
      },
      blocked: verifiable ? "" : "Add evidence and verify a space before recording a decision.",
    },
    {
      key: "spatial",
      label: "Spatial 360 record",
      state: stats.stitch.active.length || stats.stitch.failed.length
        ? "active"
        : stats.spatial.length
          ? "done"
          : stats.paired360 || stats.waiting360
            ? "active"
            : "waiting",
      detail: stats.stitchLine
        ? stats.stitchLine
        : stats.spatial.length
          ? `${stats.spatial.length} space capture${stats.spatial.length === 1 ? "" : "s"} playable in the viewer and in a headset`
          : stats.paired360 || stats.waiting360
            ? `${stats.paired360 + stats.waiting360} camera original${stats.paired360 + stats.waiting360 === 1 ? "" : "s"} preserved, no playable export yet`
            : "No 360 capture in this project yet",
      actionLabel: stats.spatial.length ? "Open 360 view" : "Add the export",
      run: () => (stats.spatial.length ? openFirstSpatial() : showFocusStage("upload")),
    },
  ];
}

/* One row per space, never one row per AI sentence: the individual questions
   belong in the space sheet, and Today has to stay readable on a phone. */
function focusAttentionItems(stats) {
  const entries = [];
  const originalsOnly = [];
  stats.spaces.forEach((room) => {
    const analyzable = room.evidence.some((item) => isImage(item) || isVideo(item));
    const followUps = room.analysis?.follow_up_captures?.length || 0;
    const questions = room.analysis ? (room.unknown || []).length : 0;
    const detail = [
      questions ? `${questions} open question${questions === 1 ? "" : "s"}` : "",
      followUps ? `${followUps} capture${followUps === 1 ? "" : "s"} requested` : "",
    ].filter(Boolean).join(" · ");

    if (analyzable && !room.analysis) {
      entries.push({
        tone: "wait",
        title: room.name,
        copy: "Visual evidence is stored but has not been interpreted.",
        actionLabel: "Start AI review",
        run: () => processFocusEvidence(),
      });
      return;
    }
    if (room.analysis && room.status !== "confirmed") {
      entries.push({
        tone: "review",
        title: room.name,
        copy: [room.analysis.summary || "AI interpretation is waiting for human verification.", detail]
          .filter(Boolean)
          .join(" · "),
        actionLabel: "Open and verify",
        run: () => openFocusSheet(room.id, "results"),
      });
      return;
    }
    if (room.analysis && followUps) {
      entries.push({
        tone: "capture",
        title: `${room.name} · capture requested`,
        copy: `${room.analysis.follow_up_captures[0].request}${followUps > 1 ? ` (+${followUps - 1} more)` : ""}`,
        actionLabel: "Send a field task",
        run: () => openFieldOperations(),
      });
      return;
    }
    if (!analyzable && room.evidence.some(focusIsCameraOriginal) && !room.evidence.some(focusIsSpatial)) {
      originalsOnly.push(room);
    }
  });

  if (originalsOnly.length) {
    entries.push({
      tone: "capture",
      title: `${originalsOnly.length} space${originalsOnly.length === 1 ? "" : "s"} hold camera originals only`,
      copy: `${originalsOnly.slice(0, 3).map((room) => room.name).join(", ")}${originalsOnly.length > 3 ? " and others" : ""} — a browser and the AI both need a full 360 MP4 export before anything can be seen or interpreted.`,
      actionLabel: "Upload the exports",
      run: () => showFocusStage("upload"),
    });
  }
  if (stats.waiting360) {
    entries.push({
      tone: "capture",
      title: "Incomplete 360 capture",
      copy: `${stats.waiting360} capture${stats.waiting360 === 1 ? " is" : "s are"} missing the matching camera original.`,
      actionLabel: "Upload the missing file",
      run: () => showFocusStage("upload"),
    });
  }
  return entries;
}

function focusChangeItems(stats) {
  if (!stats.rawFiles) return [];
  const entries = [];
  /* A capture compared against the one before it is the only entry here that
     answers "what happened", rather than "what arrived". It goes first. */
  stats.spaces
    .filter((room) => room.change)
    .sort((a, b) => Date.parse(b.change.compared_at || 0) - Date.parse(a.change.compared_at || 0))
    .slice(0, 2)
    .forEach((room) => {
      const change = room.change;
      const detail = change.appeared.length
        ? change.appeared.slice(0, 2).map((entry) => entry.text).join("; ")
        : change.gone.length
          ? `${change.gone.length} thing${change.gone.length === 1 ? " is" : "s are"} no longer in view`
          : "Both captures show the same things.";
      entries.push({
        title: `${room.name}: ${change.headline}`,
        copy: `${detail} · compared with ${change.earlier_label} · AI suggestion, not verified`,
      });
    });
  const batchFiles = stats.latestBatch.reduce((total, item) => total + focusSourceCount(item), 0);
  const batchSpaces = new Set();
  stats.latestBatch.forEach((item) => {
    const room = roomOf(item);
    if (room) batchSpaces.add(room.name);
  });
  if (batchFiles) {
    entries.push({
      title: `${batchFiles} file${batchFiles === 1 ? "" : "s"} added ${focusRelativeDay(stats.lastUpdate)}`,
      copy: batchSpaces.size
        ? `In ${[...batchSpaces].slice(0, 3).join(", ")}${batchSpaces.size > 3 ? " and other spaces" : ""}.`
        : "Waiting to be assigned to a space.",
    });
  }
  stats.analyzedRooms
    .filter((room) => room.status !== "confirmed")
    .slice(0, 3)
    .forEach((room) => {
      entries.push({
        title: `${room.name}: new AI interpretation`,
        copy: room.analysis?.summary || "The AI produced a suggestion that no person has confirmed yet.",
      });
    });
  stats.confirmedRooms.slice(0, 3).forEach((room) => {
    entries.push({
      title: `${room.name}: confirmed by a person`,
      copy: (room.note || "").trim() || "Confirmed without a written note.",
    });
  });
  if (entries.length === 1 && !stats.analyzedRooms.length) {
    entries.push({
      title: "No comparison is possible yet",
      copy: "A change can only be shown against an earlier observation of the same space. This is the first round.",
    });
  }
  return entries;
}

function focusHeadline(stats) {
  if (!stats.rawFiles) return "Nothing has been observed yet.";
  if (stats.unanalyzedRooms.length) {
    return `${stats.rawFiles} file${stats.rawFiles === 1 ? "" : "s"} received. ${stats.unanalyzedRooms.length} space${stats.unanalyzedRooms.length === 1 ? "" : "s"} still waiting for the AI review.`;
  }
  if (stats.awaitingReview.length) {
    return `${stats.awaitingReview.length} space${stats.awaitingReview.length === 1 ? "" : "s"} need${stats.awaitingReview.length === 1 ? "s" : ""} human verification.`;
  }
  if (stats.spaces.length && stats.confirmedRooms.length >= stats.spaces.length) {
    return `All ${stats.spaces.length} space${stats.spaces.length === 1 ? "" : "s"} are verified against the evidence.`;
  }
  return `${stats.rawFiles} file${stats.rawFiles === 1 ? "" : "s"} preserved across ${stats.spaces.length} space${stats.spaces.length === 1 ? "" : "s"}.`;
}

function renderFocusToday() {
  const stats = focusEvidenceStats();
  $("#today-headline").textContent = focusHeadline(stats);
  $("#today-updated").textContent = stats.lastUpdate
    ? `Last evidence ${focusRelativeDay(stats.lastUpdate)} · ${new Date(stats.lastUpdate).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`
    : "No evidence has been uploaded to this project.";

  const next = focusNextAction(stats);
  $("#today-next-title").textContent = next.title;
  $("#today-next-copy").textContent = next.copy;
  $("#today-next-owner").textContent = `Who does it: ${next.owner}`;
  const nextButton = $("#today-next-action");
  nextButton.innerHTML = `${escapeText(next.label)} <span>&rarr;</span>`;
  nextButton.onclick = () => next.run();

  const attention = focusAttentionItems(stats);
  $("#today-attention-block").hidden = !attention.length;
  const attentionList = $("#today-attention");
  attentionList.innerHTML = attention
    .map(
      (entry, index) =>
        `<article class="today-item tone-${escapeText(entry.tone)}"><div><strong>${escapeText(entry.title)}</strong><p>${escapeText(entry.copy)}</p></div><button type="button" data-attention="${index}">${escapeText(entry.actionLabel)}</button></article>`,
    )
    .join("");
  attentionList.querySelectorAll("[data-attention]").forEach((button) => {
    button.addEventListener("click", () => attention[Number(button.dataset.attention)]?.run());
  });

  /* Three lines is what a person reads standing up. The full history is in the
     report, which is where a reader who wants all of it is going anyway. */
  const changes = focusChangeItems(stats).slice(0, 3);
  $("#today-changed-block").hidden = !changes.length;
  $("#today-changed").innerHTML = changes
    .map((entry) => `<article class="today-item"><div><strong>${escapeText(entry.title)}</strong><p>${escapeText(entry.copy)}</p></div></article>`)
    .join("");

  const chain = focusChainItems(stats);
  const chainList = $("#today-chain");
  chainList.innerHTML = chain
    .map(
      (step, index) =>
        `<li class="chain-${escapeText(step.state)}"><i aria-hidden="true"></i><div><strong>${escapeText(step.label)}</strong><small>${escapeText(step.detail)}</small></div><button type="button" data-chain="${index}">${escapeText(step.actionLabel)}</button></li>`,
    )
    .join("");
  chainList.querySelectorAll("[data-chain]").forEach((button) => {
    const step = chain[Number(button.dataset.chain)];
    button.addEventListener("click", () => {
      if (step.blocked) {
        notify(step.blocked, 5200);
        return;
      }
      step.run();
    });
  });

}

function openProjectPlans(view) {
  if (!cloud.propertyId) {
    notify("Open a project before its plans can be reviewed");
    return;
  }
  /* Only a literal view name opens a channel — this function also serves as
     a bare click handler, where the argument is the event. */
  const suffix = view === "visual" ? "&view=visual" : "";
  window.location.href = `plans/?property=${encodeURIComponent(cloud.propertyId)}${suffix}`;
}

function openFieldOperations() {
  if (!cloud.propertyId) {
    notify("Open a project before a field task can be sent");
    return;
  }
  window.location.href = `operations/?property=${encodeURIComponent(cloud.propertyId)}`;
}

/* The capture "Open 360 view" opens, and the room it belongs to.

   It used to be spatial[0] — whichever capture happened to sit first in
   creation order across the whole project. With fourteen of them that is an
   arbitrary room, and the button said nothing about which. Somebody who had
   just uploaded a bedroom pressed it and stood in a bathroom captured nine days
   earlier. The newest capture is the one somebody just made, so that is the one
   this opens, and the button says which room before it is pressed. */
/* Naming the room on the button is the difference between a promise and a
   surprise: with fourteen captures in a project, "Open 360 view" does not say
   where you are about to be standing. */
function newestSpatialLabel() {
  const offered = spatialToOffer();
  const room = offered?.room?.name;
  return room ? `Open 360 view — ${room}` : "Open 360 view";
}

/* The room the person is working in, in the order they would expect to be
   understood: the room whose record they have open, then the room chosen for
   the AI review, then the room chosen for uploading. */
function currentFocusRoom() {
  return focusSheetRoom()
    || rooms.find((room) => room.id === analyzeRoomId)
    || rooms.find((room) => room.id === uploadRoomId)
    || null;
}

function spatialForRoom(room) {
  const items = (room?.evidence || []).filter((item) => focusIsSpatial(item));
  if (!items.length) return null;
  return { item: [...items].sort((a, b) => focusTimestamp(b) - focusTimestamp(a))[0], room };
}

/* Which capture the screen offers to stand in.
 *
 * It used to be the newest in the whole project, always. So somebody who had
 * just been looking at Master Bedroom 205A asked to see the result and was
 * offered Hallway 107 — a different room, on a different floor, for no reason
 * they could see except that it happened to have been stitched most recently.
 *
 * The room somebody is in is the room they are asking about. Only when that
 * room has nothing playable does the newest stand in for it, and then the
 * screen says so rather than quietly swapping one room for another. */
function spatialToOffer() {
  return spatialForRoom(currentFocusRoom()) || newestSpatial();
}

function newestSpatial() {
  const spatial = focusEvidenceStats().spatial;
  if (!spatial.length) return null;
  const item = [...spatial].sort((a, b) => focusTimestamp(b) - focusTimestamp(a))[0];
  return { item, room: roomOf(item) };
}

/* Every file in the project, with the room it sits in.
 *
 * "31 files in this project" was a number with nothing under it: no way to see
 * what they were, which room each was in, or that the same capture had been
 * uploaded three times. And the one 360 button on the results screen opens the
 * newest capture and only that one, so a project with nine playable rooms let
 * somebody stand in exactly one of them.
 *
 * This is the list behind the number, and the way into any room from it. */
const fileList = { rows: [], search: "", dupesOnly: false, busy: false, working: null };

function focusFilesPanel() { return $("#focus-files"); }

async function openFileList() {
  const panel = focusFilesPanel();
  if (!panel || !cloud.propertyId) return;
  panel.hidden = false;
  fileList.working = null;
  $("#focus-files-list").innerHTML = `<p class="focus-files-empty">Reading the record…</p>`;
  try {
    const { data, error } = await cloud.client.rpc("project_files", { p_property_id: cloud.propertyId });
    if (error) throw error;
    fileList.rows = data || [];
    renderFileList();
  } catch (error) {
    console.error("project files", error);
    /* Never an empty box. If the list cannot be read, the reason is the list. */
    $("#focus-files-list").innerHTML = `<p class="focus-files-empty">${escapeText(
      error.message || "The file list could not be read.",
    )}</p>`;
  }
}

function closeFileList() {
  const panel = focusFilesPanel();
  if (panel) panel.hidden = true;
}

function fileListVisibleRows() {
  const term = fileList.search.trim().toLowerCase();
  return fileList.rows.filter((row) => {
    if (fileList.dupesOnly && !row.duplicate_name) return false;
    if (!term) return true;
    return `${row.filename} ${row.room_name || ""} ${row.room_level || ""}`.toLowerCase().includes(term);
  });
}

/* "This name appears more than once" said the same thing about two situations
   that mean opposite things, so it said nothing anybody could act on. Somebody
   had to ask what it meant, which is the label failing.

   The same capture in two rooms is a filing mistake: it was taken in one room.
   The same capture twice in one room is a re-upload — usually one that looked
   as though it had failed. Different problems, different sentences. */
function duplicateNote(row, rows) {
  const twins = rows.filter(
    (other) => other.filename.toLowerCase() === String(row.filename || "").toLowerCase(),
  );
  if (twins.length < 2) return "";
  const inThisRoom = twins.filter((other) => other.room_id === row.room_id).length;
  const otherRooms = [...new Set(
    twins.filter((other) => other.room_id !== row.room_id).map((other) => other.room_name).filter(Boolean),
  )];
  if (inThisRoom > 1 && otherRooms.length) {
    /* Both at once, which is exactly what a room full of re-uploads of a
       capture that also lives elsewhere looks like. Saying only one half of it
       leaves the other half to be discovered later. */
    return `${inThisRoom} copies here — the extras are re-uploads — and also in ${otherRooms.join(", ")}`;
  }
  if (inThisRoom > 1) {
    return `${inThisRoom} copies of this file in this room — the extras are re-uploads`;
  }
  return `also in ${otherRooms.join(", ")} — a capture was taken in one room, not two`;
}

/* The record, examined: what is wrong in it right now, each finding with its
 * remedy attached.
 *
 * "The machine should see this and not allow it" — said after a day of filing
 * mistakes that were each individually visible and collectively invisible. The
 * gate above stops new ones at the door. This reads what is already inside:
 * every finding is computed from the same rows the list shows, and every
 * finding carries the action that resolves it, because a warning without a
 * remedy is a chore assigned to whoever reads it.
 *
 * It never acts on its own. The product rule is that the AI présents and a
 * person decides; a cleaner that deletes what it is sure about is the rule
 * broken where it would hurt most — on originals. */
function recordFindings(rows) {
  const findings = [];
  const byName = new Map();
  rows.forEach((row) => {
    const key = String(row.filename || "").toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(row);
  });

  byName.forEach((twins, key) => {
    if (twins.length < 2) return;
    /* Copies inside one room: re-uploads. The keeper is the oldest — it is the
       one the record has known longest — and the extras are named one by one so
       "remove the extras" is a decision about specific files, not a category. */
    const byRoom = new Map();
    twins.forEach((row) => {
      const room = row.room_id || "unfiled";
      if (!byRoom.has(room)) byRoom.set(room, []);
      byRoom.get(room).push(row);
    });
    byRoom.forEach((inRoom) => {
      if (inRoom.length < 2) return;
      const sorted = [...inRoom].sort((a, b) => new Date(a.uploaded_at) - new Date(b.uploaded_at));
      findings.push({
        kind: "repeat_uploads",
        title: `${sorted[0].filename} is in ${sorted[0].room_name || "a room"} ${inRoom.length} times`,
        detail: `Uploaded again on ${sorted.slice(1).map((row) => formatEvidenceDate(row.uploaded_at)).join(", ")} — re-uploads of the copy from ${formatEvidenceDate(sorted[0].uploaded_at)}. The extras add nothing to the record.`,
        remedy: "Remove the extra copies",
        extras: sorted.slice(1).map((row) => row.id),
        keeper: sorted[0].id,
      });
    });
    /* The same capture in two rooms: it was taken in one. Which one is a fact
       about the building, so the machine lays out the choice and stops. */
    const roomsHolding = [...new Set(twins.map((row) => row.room_name).filter(Boolean))];
    if (roomsHolding.length > 1) {
      findings.push({
        kind: "two_rooms",
        title: `${twins[0].filename} is filed in ${roomsHolding.length} rooms`,
        detail: `${roomsHolding.join(" and ")} both hold it. A capture was taken in one room — the other filing is wrong, and which one is something only somebody who was there can say.`,
        remedy: `Open the list and move the wrong one`,
        filter: twins[0].filename,
      });
    }
  });

  /* A lens file with no pair anywhere: the other half was never uploaded. */
  rows.forEach((row) => {
    const match = String(row.filename || "").toLowerCase().match(/^(.*)_(00|10)_([0-9]+)\.insv$/);
    if (!match) return;
    const otherLens = `${match[1]}_${match[2] === "00" ? "10" : "00"}_${match[3]}.insv`;
    const paired = rows.some(
      (other) => other.room_id === row.room_id
        && String(other.filename || "").toLowerCase() === otherLens,
    );
    if (!paired) {
      findings.push({
        kind: "missing_lens",
        title: `${row.filename} in ${row.room_name || "a room"} is one lens of a pair`,
        detail: `The matching ${otherLens} is not in that room, so the 360 machine cannot stitch this capture. Upload the other half, or move it here if it is filed elsewhere.`,
        remedy: "Show this capture",
        filter: `${match[1]}_`.replace(/^vid_/, "vid_"),
      });
    }
  });

  return findings;
}

function renderRecordFindings() {
  const box = $("#focus-files-findings");
  if (!box) return;
  /* While one finding is being worked on, the panel is that finding and the
     way back — so pressing its remedy visibly changed the screen, and the list
     under it is the files it names. */
  if (fileList.working) {
    box.hidden = false;
    box.innerHTML = `
      <article class="focus-finding working">
        <div><strong>${escapeText(fileList.working.title)}</strong><small>${escapeText(fileList.working.detail)} The list below is these files — choose the correct room on the wrong one.</small></div>
        <button type="button" data-finding-back>All findings</button>
      </article>`;
    box.querySelector("[data-finding-back]")?.addEventListener("click", () => {
      fileList.working = null;
      fileList.search = "";
      const search = $("#focus-files-search");
      if (search) search.value = "";
      renderFileList();
    });
    return;
  }
  const findings = recordFindings(fileList.rows);
  if (!findings.length) {
    box.hidden = false;
    box.innerHTML = `<p class="focus-findings-clear">✓ The record is consistent — no repeated uploads, no capture filed in two rooms, no half of a pair missing.</p>`;
    return;
  }
  box.hidden = false;
  box.innerHTML = `<p class="focus-findings-head">${findings.length} thing${findings.length === 1 ? "" : "s"} in this record need${findings.length === 1 ? "s" : ""} a decision. Nothing is changed until you choose.</p>` +
    findings.map((finding, index) => `
      <article class="focus-finding">
        <div><strong>${escapeText(finding.title)}</strong><small>${escapeText(finding.detail)}</small></div>
        <button type="button" data-finding="${index}">${escapeText(finding.remedy)}</button>
      </article>`).join("");
  box.querySelectorAll("[data-finding]").forEach((button) => {
    button.addEventListener("click", () => actOnFinding(findings[Number(button.dataset.finding)]));
  });
}

async function actOnFinding(finding) {
  if (!finding) return;
  if (finding.kind === "repeat_uploads") {
    const ok = window.confirm(
      `Remove ${finding.extras.length} extra cop${finding.extras.length === 1 ? "y" : "ies"}?\n\nThe original from the first upload stays exactly as it is. The removals go on the audit record with your name.`,
    );
    if (!ok) return;
    let removed = 0;
    for (const id of finding.extras) {
      const { error } = await cloud.client.rpc("soft_delete_evidence", {
        p_evidence_id: id,
        p_reason: "Duplicate upload of the same file into the same room",
      });
      if (error) { notify(error.message || "A copy could not be removed", 6000); break; }
      removed += 1;
    }
    if (removed) {
      notify(`${removed} extra cop${removed === 1 ? "y" : "ies"} removed. The first upload is untouched.`, 6000);
      await hydrateCloudRecord();
      await openFileList();
    }
    return;
  }
  /* The findings that need a person: narrow the list to the files in question
     and let them decide with the move control that already exists.

     The first version narrowed the list and left the findings panel exactly as
     it was — six findings tall, filling the visible area. The change happened
     below the fold, and a click with no visible answer reads as a button that
     does not work. That was reported as "not clickable", and it effectively
     was. The panel now collapses to the one finding being worked on. */
  fileList.search = finding.filter || "";
  fileList.dupesOnly = false;
  fileList.working = finding;
  const search = $("#focus-files-search");
  if (search) search.value = fileList.search;
  const dupes = $("#focus-files-dupes");
  if (dupes) dupes.checked = false;
  renderFileList();
  $("#focus-files-list")?.scrollTo({ top: 0 });
}

function renderFileList() {
  const list = $("#focus-files-list");
  const visible = fileListVisibleRows();
  const dupes = fileList.rows.filter((row) => row.duplicate_name).length;
  $("#focus-files-count").textContent = `${fileList.rows.length} file${fileList.rows.length === 1 ? "" : "s"}`;
  renderRecordFindings();
  $("#focus-files-note").textContent = dupes
    ? `${dupes} of them share a name with another file. The same capture in two rooms is legitimate; the same capture twice in one room is usually an upload that looked like it failed.`
    : "Every file the record holds for this project, and the room it is filed in.";

  if (!visible.length) {
    list.innerHTML = `<p class="focus-files-empty">${
      fileList.rows.length ? "Nothing matches that filter." : "This project holds no files yet."
    }</p>`;
    return;
  }

  const options = rooms
    .map((room) => `<option value="${escapeText(room.id)}">${escapeText(room.level ? `${room.name} · ${room.level}` : room.name)}</option>`)
    .join("");

  list.innerHTML = visible.map((row) => {
    const when = row.happened_at ? formatEvidenceDate(row.happened_at) : "date unavailable";
    const size = row.byte_size ? formatFileSize(row.byte_size) : "";
    const note = row.duplicate_name ? duplicateNote(row, fileList.rows) : "";
    return `
    <article class="focus-file-row">
      <div class="focus-file-name">
        <strong title="${escapeText(row.filename)}">${escapeText(row.filename)}</strong>
        <small>${escapeText(row.media_type || "Evidence")} · ${escapeText(when)}${size ? ` · ${escapeText(size)}` : ""}${
          note ? ` · <span class="focus-file-dupe">${escapeText(note)}</span>` : ""
        }</small>
      </div>
      <select class="focus-file-room" data-file-room="${escapeText(row.id)}" aria-label="Room for ${escapeText(row.filename)}">
        ${options.replace(`value="${escapeText(row.room_id || "")}"`, `value="${escapeText(row.room_id || "")}" selected`)}
      </select>
      <div class="focus-file-actions">
        <!-- Never disabled. A browser cannot play a camera original, but that is
             something to say, not a reason to hand somebody a grey button and
             no explanation. -->
        <button type="button" data-file-open="${escapeText(row.id)}">Open</button>
      </div>
    </article>`;
  }).join("");

  list.querySelectorAll("[data-file-room]").forEach((select) => {
    select.addEventListener("change", () => moveFileToRoom(select.dataset.fileRoom, select.value, select));
  });
  list.querySelectorAll("[data-file-open]").forEach((button) => {
    button.addEventListener("click", () => openFileFromList(button.dataset.fileOpen));
  });
}

/* Opening any capture, from anywhere in the project. The results screen offers
   exactly one — the newest — which is why a project with nine playable rooms
   let somebody stand in one of them. */
/* Pressing Open on a camera original.
 *
 * A browser cannot play the camera's INSV format, and the first version of this
 * list answered that with a greyed-out button and no explanation — a dead end
 * dressed as a control.
 *
 * What somebody pressing it wants is to see the space. If the machine has
 * already stitched this capture into a playable master, and that master is in
 * the same room, that is the thing to open — the original and the master are
 * two halves of one capture. If it has not, the viewer says so in words. Either
 * way the press does something. */
/* The capture a playable master came from.
 *
 * The machine names its output <capture key>-vr-master.mp4, so comparing the
 * export key straight against the originals' key never matched: one said
 * vid_..._011 and the other vid_..._011-vr-master. What the record actually
 * states, when the reconciliation has run, is ready_360.capture_key — that is
 * read first, and the name is only the fallback. */
function masterCaptureKey(item) {
  const declared = item?.sourceMetadata?.ready_360?.capture_key
    || item?.sourceMetadata?.insta360_capture_key;
  if (declared) return String(declared).toLowerCase();
  const stem = exportCaptureKey(item?.name);
  return stem ? stem.replace(/-vr-master$/, "") : null;
}

function openFileFromList(evidenceId) {
  const row = fileList.rows.find((entry) => entry.id === evidenceId);
  const { item, room } = tileFor(evidenceId);
  if (!item) {
    notify("That file is in the record but is not something the viewer can open.", 5000);
    return;
  }
  let opening = item;
  if (focusIsCameraOriginal(item) || item.mimeType === "application/x-insta360-capture") {
    const key = insta360CaptureKey(item) || item.sourceMetadata?.insta360_capture_key;
    const master = key
      ? (room?.evidence || []).find(
          (entry) => focusIsSpatial(entry) && masterCaptureKey(entry) === key,
        )
      : null;
    if (master) opening = master;
  }
  closeFileList();
  openEvidenceViewer(opening, room);
}

async function moveFileToRoom(evidenceId, spaceId, select) {
  const row = fileList.rows.find((entry) => entry.id === evidenceId);
  if (!row || fileList.busy || spaceId === row.room_id) return;
  const target = rooms.find((entry) => entry.id === spaceId);
  if (!target) return;
  fileList.busy = true;
  select.disabled = true;
  try {
    const { error } = await cloud.client.rpc("move_evidence_to_room", {
      p_evidence_id: evidenceId,
      p_space_id: spaceId,
      p_reason: null,
    });
    if (error) throw error;
    row.room_id = spaceId;
    row.room_name = target.name;
    row.room_level = target.level;
    /* The file did not change; only where the record says it was taken. Saying
       so is the difference between a correction and a replacement. */
    notify(`${row.filename} is now filed in ${target.name}. The file itself is unchanged.`, 5000);
    await hydrateCloudRecord();
    renderFileList();
  } catch (error) {
    console.error("move evidence", error);
    /* Put the picker back where it was, so the screen never shows a room the
       record did not accept. */
    select.value = row.room_id || "";
    notify(error.message || "That file could not be moved.", 6000);
  } finally {
    fileList.busy = false;
    select.disabled = false;
  }
}

function openFirstSpatial() {
  const newest = spatialToOffer();
  if (!newest) {
    notify("This project has no playable 360 export yet. Upload an equirectangular MP4 to open the space.", 6000);
    showFocusStage("upload");
    return;
  }
  openEvidenceViewer(newest.item, newest.room);
}

/* ------------------------------------------------------------- Evidence viewer */

function focusEvidenceUrl(item) {
  if (!cloud.propertyId || !item?.id) return "";
  return `${window.location.origin}${window.location.pathname}?property=${encodeURIComponent(cloud.propertyId)}&evidence=${encodeURIComponent(item.id)}`;
}

/* The link opens Studio on this capture — after a sign-in, because the record
   is private and a link that skipped that would make evidence public.
   The old message said "open it in Vision Pro Safari" as though that were all
   it took, so somebody who did exactly that landed on a sign-in screen and
   reasonably called the button broken. */
async function copyFocusLink(item) {
  const url = focusEvidenceUrl(item);
  if (!url) return;
  let copied = false;
  try {
    await navigator.clipboard.writeText(url);
    copied = true;
  } catch {
    copied = false;
  }
  /* Shown rather than announced: a clipboard that refused leaves nothing to
     paste, and a toast that fades leaves nothing to read. The link is on the
     screen either way. */
  showLinkForHeadset(url, copied);
}

function showLinkForHeadset(url, copied) {
  const existing = document.getElementById("headset-link-dialog");
  if (existing) existing.remove();
  const dialog = document.createElement("dialog");
  dialog.id = "headset-link-dialog";
  dialog.className = "headset-link";
  dialog.innerHTML = `
    <h3>${copied ? "Link copied" : "Here is the link"}</h3>
    <p>Open it in the headset's browser and sign in — it lands straight on this
       capture. The sign-in is what keeps the record private.</p>
    <input id="headset-link-url" type="text" readonly value="${escapeText(url)}">
    <div class="headset-link-actions">
      <button class="focus-secondary-action" type="button" id="headset-link-copy">${copied ? "Copy again" : "Copy"}</button>
      <button class="focus-primary-action" type="button" id="headset-link-done">Done</button>
    </div>
    <p class="headset-link-note">Already wearing the headset? Open Studio there,
       sign in once, and use <strong>Stand in this room</strong> — no link needed.</p>`;
  document.body.appendChild(dialog);
  const field = dialog.querySelector("#headset-link-url");
  dialog.querySelector("#headset-link-copy").addEventListener("click", async () => {
    field.select();
    try {
      await navigator.clipboard.writeText(url);
      dialog.querySelector("#headset-link-copy").textContent = "Copied";
    } catch {
      /* Selected and ready for a manual copy, which is the fallback that has
         never needed a permission. */
      dialog.querySelector("#headset-link-copy").textContent = "Press ⌘C";
    }
  });
  dialog.querySelector("#headset-link-done").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();
  field.select();
}

/* Async because a signature is renewed before the file opens. Every caller
   fires and forgets, so nothing waits on it. */
async function openEvidenceViewer(item, room, focusMarkerId = null) {
  if (!item) return;
  /* Opening a file to look at it is recorded; a thumbnail appearing in a list is
     not. One is a person choosing to see something and is what "who saw what"
     means; the other is the page loading, and auditing it would bury the first
     under thousands of entries that answer nothing. */
  recordClientEvent("evidence.opened", {
    evidence_id: item.id,
    filename: item.name || null,
    space_id: room?.id || null,
  });
  /* Renewed before the file is opened, not read out of whatever was signed
     when the page loaded. */
  const source = await freshEvidenceSrc(item);
  if (!window.MDAIPano360) {
    if (source) window.open(source, "_blank", "noopener");
    return;
  }
  const spatial = focusIsSpatial(item);
  const roomName = room?.name || "Project evidence";
  const actions = [];

  if (focusIsCameraOriginal(item)) {
    const paired = (item.sourceIds?.length || 0) >= 2;
    const stitchState = stitchLine();
    /* This capture, stitched, anywhere in the project. The person's question is
       "show me the space", and telling them only that this room's copy is
       queued — while the identical capture sits playable one room over — is a
       dead end with the answer in the next sentence. It is offered, not
       silently substituted: the label says whose room it is. */
    const captureKey = insta360CaptureKey(item) || item.sourceMetadata?.insta360_capture_key;
    let masterElsewhere = null;
    if (captureKey) {
      for (const other of rooms) {
        const master = (other.evidence || []).find(
          (entry) => focusIsSpatial(entry) && masterCaptureKey(entry) === captureKey,
        );
        if (master) { masterElsewhere = { item: master, room: other }; break; }
      }
    }
    window.MDAIPano360.open({
      src: "",
      title: item.name || "360 camera original",
      subtitle: paired
        ? `Both camera originals are preserved. A browser cannot play the protected INSV format, so the 360 machine stitches a playable master from this pair. ${
            stitchState || "It is queued; the master appears here when the machine has run."
          }${masterElsewhere ? ` This same capture is already stitched in ${masterElsewhere.room.name}.` : ""}`
        : "One camera original is missing. Upload the matching INSV file — the pair is what the 360 machine stitches from.",
      actions: [
        masterElsewhere
          ? { label: `Open the stitched master — ${masterElsewhere.room.name}`, primary: true, onSelect: () => { window.MDAIPano360.close(); openEvidenceViewer(masterElsewhere.item, masterElsewhere.room); } }
          : null,
        /* This button said "Back to the file list" and went to the upload
           screen. A label that lies is worse than no button. */
        paired
          ? { label: "Back to the file list", primary: !masterElsewhere, onSelect: () => { window.MDAIPano360.close(); openFileList(); } }
          : { label: "Upload the matching original", primary: true, onSelect: () => { window.MDAIPano360.close(); showFocusStage("upload"); } },
        room ? { label: `Back to ${roomName}`, onSelect: () => { window.MDAIPano360.close(); openFocusSheet(room.id, focusStage); } } : null,
      ].filter(Boolean),
    });
    return;
  }

  if (spatial) {
    actions.push({ label: "Copy link for Vision Pro", primary: true, onSelect: () => copyFocusLink(item) });
  }
  if (room) {
    actions.push({
      label: `Findings for ${roomName}`,
      onSelect: () => {
        window.MDAIPano360.close();
        openFocusSheet(room.id, focusStage);
      },
    });
  }
  if (source) {
    /* Signed again at the moment of the press: this panel can sit open for a
       long time before anybody reaches for the original. */
    actions.push({
      label: "Open the original file",
      onSelect: async () => {
        const url = await freshEvidenceSrc(item);
        if (url) window.open(url, "_blank", "noopener");
      },
    });
  }

  const markers = spatial ? decorateRoomMarkers(room, item, roomMarkers(room, item)) : [];

  /* Every room of this project with a viewable 360 capture, offered inside
     the headset: a person standing in one room can walk the whole project
     without taking the headset off — a menu in the sphere, not a dead end. */
  const roomChoices = [];
  if (spatial) {
    /* The moment being stood in. Walking to the next room must not walk you
       silently forward in time: somebody standing in the building as it was
       three weeks ago, stepping through a doorway, expects the next room
       three weeks ago too — not today's, wearing the same room's name. The
       anchor stays the capture they entered by, so the whole walk is one
       moment rather than a drift through the project's history. */
    const standingAt = Date.parse(item.capturedAt || "") || null;
    for (const other of rooms) {
      const captures = (other.evidence || []).filter((entry) => focusIsSpatial(entry));
      if (!captures.length) continue;
      const capture = standingAt
        ? captures.reduce((closest, entry) => {
          const gap = Math.abs((Date.parse(entry.capturedAt || "") || 0) - standingAt);
          const best = Math.abs((Date.parse(closest.capturedAt || "") || 0) - standingAt);
          return gap < best ? entry : closest;
        }, captures[0])
        : captures[0];
      roomChoices.push({ id: other.id, title: other.name || "Room", item: capture, roomRef: other });
    }
  }
  /* The date rides on the label. Even with the nearest capture chosen, a room
     may simply have no capture from that week, and a person in a headset must
     never have to guess which day they are looking at. */
  const roomList = (currentId) =>
    roomChoices.map((entry) => ({
      id: entry.id,
      title: entry.item.date ? `${entry.title} · ${entry.item.date}` : entry.title,
      current: entry.id === currentId,
    }));
  const chooseRoom = async (roomId) => {
    const choice = roomChoices.find((entry) => entry.id === roomId);
    if (!choice) return;
    /* A swap is a person opening evidence, exactly as the first open was. */
    recordClientEvent("evidence.opened", {
      evidence_id: choice.item.id,
      filename: choice.item.name || null,
      space_id: choice.id,
    });
    const nextSource = await freshEvidenceSrc(choice.item);
    if (!nextSource) return;
    window.MDAIPano360.swapRoom({
      src: nextSource,
      mediaType: choice.item.mimeType || "",
      trim: evidenceTrimWindow(choice.item, choice.item.sourceMetadata?.duration_seconds),
      title: choice.item.subject || choice.item.name || "Evidence",
      subtitle: [choice.title, focusEvidenceLabel(choice.item), choice.item.date || "date unavailable", focusEvidenceTrimNote(choice.item)]
        .filter(Boolean)
        .join(" · "),
      markers: decorateRoomMarkers(choice.roomRef, choice.item, roomMarkers(choice.roomRef, choice.item)),
      evidenceId: choice.item.id,
      canReviewMarkers: canManageSpaces(),
      onMarkerReview: (marker, reviewState) => reviewMarker(choice.roomRef, marker, reviewState),
      onMarkerPlace: canManageSpaces() ? (marker) => placeMarker(choice.roomRef, marker) : null,
      onMarkerRequest: (marker) => requestMarkerDocument(choice.roomRef, marker),
      rooms: roomList(choice.id),
      onRoomChosen: chooseRoom,
    });
  };

  window.MDAIPano360.open({
    src: source,
    mediaType: item.mimeType || "",
    spatial,
    trim: evidenceTrimWindow(item, item.sourceMetadata?.duration_seconds),
    title: item.subject || item.name || "Evidence",
    subtitle: [roomName, focusEvidenceLabel(item), item.date || "date unavailable", focusEvidenceTrimNote(item)]
      .filter(Boolean)
      .join(" · "),
    actions,
    // Reviewing in the sphere is the point: the person looking at the thing is
    // the one who can say whether the AI read it right, and they should not
    // have to leave the space to say so.
    markers,
    evidenceId: item.id,
    canReviewMarkers: Boolean(room) && canManageSpaces(),
    onMarkerReview: room ? (marker, state) => reviewMarker(room, marker, state) : null,
    onMarkerPlace: room && canManageSpaces() ? (marker) => placeMarker(room, marker) : null,
    onMarkerRequest: room ? (marker) => requestMarkerDocument(room, marker) : null,
    focusMarkerId,
    rooms: roomChoices.length > 1 ? roomList(room?.id || null) : [],
    onRoomChosen: chooseRoom,
  });
}

/* What a marker carries beyond its position: provenance, change since the
   previous capture, cost at the level cost exists at. Shared between the
   first open of a room and every in-headset room change after it. */
function decorateRoomMarkers(targetRoom, targetItem, list) {
  list.forEach((marker) => {
    marker.source_name = targetItem.subject || targetItem.name || "this capture";
    /* "Since the previous capture" stops being a promise the moment a
       comparison exists: the marker carries what the difference actually said
       about the thing it points at. */
    marker.change = markerChangeLine(targetRoom, marker);
    /* Cost is quoted at the level it exists at. "$12,400 for rough electrical
       across the project" is true; a price for this one outlet is not. */
    const guess = window.MDAITrades360?.classify(marker.detail || marker.label);
    const trade = guess && projectCoverage()?.trades.find((entry) => entry.key === guess.trade);
    marker.cost = trade?.has_amount
      ? `${trade.amount_label} recorded for ${trade.label.toLowerCase()} across this project`
      : trade
        ? `No cost recorded for ${trade.label.toLowerCase()} yet`
        : "";
    marker.document = trade?.invoices.length ? `Invoice ${trade.invoices.join(", ")}` : "";
    marker.requested = Boolean(
      (targetRoom.requests || []).some((entry) => entry.trade === guess?.trade && entry.state === "open"),
    );
  });
  return list;
}

/* --------------------------------------------------------------- Space detail */

/* Finding things in the record.
 *
 * The record already holds everything. Reaching any of it meant remembering
 * which screen it lived on and clicking down to it — "the 360 of the master
 * bedroom from last time" is a five-second question that took two minutes.
 *
 * It finds, it does not conclude. Asked about framing it returns the framing
 * invoice, the room, the capture and the AI's note about framing; it never says
 * whether the framing is done. An interpretation carries whether a person
 * confirmed it, and the row says so out loud, because a search result is
 * exactly the place a suggestion could escape as a fact. */
let searchToken = 0;
let searchTimer = null;

const SEARCH_KIND_LABEL = {
  evidence: "Evidence",
  room: "Room",
  document: "Document",
  finding: "AI reading",
  capture: "Planned capture",
};

function closeFocusSearch() {
  const results = $("#focus-search-results");
  const input = $("#focus-search-input");
  if (results) { results.hidden = true; results.innerHTML = ""; }
  if (input) input.setAttribute("aria-expanded", "false");
}

function searchResultLine(row) {
  const kind = SEARCH_KIND_LABEL[row.kind] || "In this project";
  const where = row.room_name ? ` · ${escapeText(row.room_name)}` : "";
  const when = row.happened_at ? ` · ${escapeText(formatEvidenceDate(row.happened_at))}` : "";
  /* The one thing a result must never do is present an AI reading as settled.
     Said on the row itself, not behind a click. */
  const standing = row.kind === "finding"
    ? (row.confirmed
        ? `<em class="search-confirmed">Confirmed by a person</em>`
        : `<em class="search-unconfirmed">A suggestion — nobody has confirmed this</em>`)
    : "";
  return `<button class="focus-search-hit" type="button" role="option"
     data-hit-kind="${escapeText(row.kind)}" data-hit-id="${escapeText(row.id)}"
     data-hit-room="${escapeText(row.room_id || "")}">
    <span class="search-kind">${escapeText(kind)}${where}${when}</span>
    <strong>${escapeText(row.title || "Untitled")}</strong>
    ${row.detail ? `<small>${escapeText(row.detail)}</small>` : ""}
    ${standing}
  </button>`;
}

async function runFocusSearch(term) {
  const results = $("#focus-search-results");
  const input = $("#focus-search-input");
  if (!results) return;
  const query = String(term || "").trim();
  if (query.length < 2) { closeFocusSearch(); return; }
  if (!cloud.schemaReady || !cloud.propertyId) { closeFocusSearch(); return; }

  /* Every keystroke starts a search and answers arrive out of order. Only the
     newest one is allowed to write to the screen, or a slow early answer lands
     on top of a fast later one. */
  const token = ++searchToken;
  results.hidden = false;
  input?.setAttribute("aria-expanded", "true");
  results.innerHTML = `<p class="focus-search-note">Looking…</p>`;
  try {
    const { data, error } = await cloud.client.rpc("search_project_record", {
      p_property_id: cloud.propertyId,
      p_query: query,
      p_limit: 30,
    });
    if (token !== searchToken) return;
    if (error) throw error;
    /* An answer of "no rows" and no answer at all are different facts, and only
       one of them is a statement about the project. Anything that is not a list
       is not an answer, and saying "nothing matches" over it would be the
       record claiming to be empty when it never spoke. */
    if (!Array.isArray(data)) throw new Error("The record returned no answer");
    const rows = data;
    if (!rows.length) {
      /* Saying what was searched is the difference between "nothing here" and
         "something is broken". */
      results.innerHTML = `<p class="focus-search-note">Nothing in this project matches “${escapeText(query)}”.</p>`;
      return;
    }
    results.innerHTML = rows.map(searchResultLine).join("");
    results.querySelectorAll("[data-hit-id]").forEach((hit) =>
      hit.addEventListener("click", () => openSearchHit(hit.dataset)),
    );
  } catch (error) {
    if (token !== searchToken) return;
    console.error(error);
    results.innerHTML = `<p class="focus-search-note">The record could not be searched just now.</p>`;
  }
}

/* Where a result takes you. Everything that belongs to a room opens that room,
   because the room is where its evidence, its reading and its history are shown
   together; a document opens the screen documents live on. */
function openSearchHit(data) {
  closeFocusSearch();
  const input = $("#focus-search-input");
  if (input) input.value = "";
  if (data.hitKind === "document") { openProjectPlans(); return; }
  const roomId = data.hitKind === "room" ? data.hitId : data.hitRoom;
  if (roomId && rooms.some((room) => room.id === roomId)) {
    openFocusSheet(roomId, focusStage);
    return;
  }
  /* A capture task with no room yet, or evidence filed outside one. Rather than
     going nowhere, the results screen is where the project as a whole is. */
  showFocusStage("results");
  notify("This one is not filed under a room yet.");
}

function focusSheetRoom() {
  return rooms.find((room) => room.id === focusSheetRoomId) || null;
}

function openFocusSheet(roomId, returnStage = focusStage) {
  const room = rooms.find((candidate) => candidate.id === roomId);
  if (!room) return;
  focusSheetRoomId = roomId;
  focusSheetReturnStage = FOCUS_STAGE_ORDER[returnStage] ? returnStage : "results";
  renderFocusSheet();
  $("#focus-sheet").hidden = false;
  document.body.style.overflow = "hidden";
  window.scrollTo({ top: 0 });
}

function closeFocusSheet(restoreStage = true) {
  const sheet = $("#focus-sheet");
  if (!sheet || sheet.hidden) return;
  sheet.hidden = true;
  focusSheetRoomId = null;
  document.body.style.overflow = "";
  if (restoreStage) showFocusStage(focusSheetReturnStage);
}

function renderFocusSheet() {
  const room = focusSheetRoom();
  if (!room) return;
  const spatialItems = room.evidence.filter(focusIsSpatial);
  const confirmed = room.status === "confirmed";

  $("#sheet-title").textContent = room.name;
  $("#sheet-edit-space").hidden = !canManageSpaces();
  $("#sheet-subtitle").textContent = [room.building, room.level].filter(Boolean).join(" · ");
  const status = $("#sheet-status");
  status.textContent = confirmed
    ? "Human verified"
    : room.analysis
      ? "Needs verification"
      : "Not interpreted yet";
  status.className = `sheet-status ${confirmed ? "is-confirmed" : room.analysis ? "is-review" : "is-waiting"}`;

  const sources = room.evidence.reduce((total, item) => total + focusSourceCount(item), 0);
  $("#sheet-evidence-count").textContent = `${sources} original file${sources === 1 ? "" : "s"}`;
  const evidenceList = $("#sheet-evidence");
  evidenceList.innerHTML = room.evidence.length
    ? room.evidence
        .map((item, index) => {
          const label = focusEvidenceLabel(item);
          const preview = isImage(item) && item.src
            ? `<img src="${escapeText(item.src)}" alt="" loading="lazy">`
            : `<span class="sheet-evidence-icon">${escapeText(label === "360" ? "360" : label === "Video" ? "▶" : label === "Document" ? "PDF" : label === "Camera original" ? "INSV" : "IMG")}</span>`;
          /* Deleting a wrong file must not require a hidden admin view: the
             person looking at the file is the person who knows it does not
             belong. The dialog still stands between the press and the loss. */
          const remove = canDeleteEvidence() && item.id
            ? `<button class="sheet-evidence-remove" type="button" data-remove-evidence="${escapeText(item.id)}" aria-label="Delete ${escapeText(item.name || "this file")}">Delete</button>`
            : "";
          return `<div class="sheet-evidence-row"><button class="sheet-evidence-item" type="button" data-evidence="${index}">${preview}<span><strong>${escapeText(item.subject || item.name || "Evidence")}</strong><small>${escapeText([label, item.date || "date unavailable", focusEvidenceTrimNote(item)].filter(Boolean).join(" · "))}</small></span></button>${remove}</div>`;
        })
        .join("")
    : `<p class="sheet-empty">No evidence is attached to this space yet.</p>`;
  evidenceList.querySelectorAll("[data-evidence]").forEach((button) => {
    button.addEventListener("click", () => openEvidenceViewer(room.evidence[Number(button.dataset.evidence)], room));
  });
  evidenceList.querySelectorAll("[data-remove-evidence]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      openEvidenceDelete(button.dataset.removeEvidence);
    });
  });

  const findings = $("#sheet-findings");
  if (room.analysis) {
    const visible = room.visible?.length ? room.visible : [];
    const unknown = room.unknown?.length ? room.unknown : [];
    const followUps = room.analysis.follow_up_captures || [];
    findings.innerHTML = `
      <p class="sheet-summary">${escapeText(room.analysis.summary || "The AI produced no written summary.")}</p>
      <p class="sheet-confidence">Capture quality: ${escapeText(room.analysis.capture_quality || "not stated")} · Source: ${sources} file${sources === 1 ? "" : "s"} in this space</p>
      <div class="sheet-findings-group"><h4>Visible in the evidence</h4><ul>${
        (visible.length ? visible : ["Nothing was recorded as visible."]).map((text) => `<li>${escapeText(text)}</li>`).join("")
      }</ul></div>
      <div class="sheet-findings-group"><h4>Not established</h4><ul>${
        (unknown.length ? unknown : ["No open questions were recorded."]).map((text) => `<li>${escapeText(text)}</li>`).join("")
      }</ul></div>
      ${followUps.length
        ? `<div class="sheet-findings-group"><h4>Capture requested</h4><ul>${followUps
            .map((entry) => `<li><strong>${escapeText(entry.request || "Additional capture")}</strong>${entry.reason ? ` — ${escapeText(entry.reason)}` : ""}</li>`)
            .join("")}</ul></div>`
        : ""}`;
  } else {
    /* Said on the card rather than only in a toast, so nobody has to press a
       button to find out why the button will not work. */
    const blocked = analysisBlocker(room);
    findings.innerHTML = `<p class="sheet-empty">${escapeText(
      blocked || "No AI interpretation has been produced for this space yet.",
    )}</p>`;
  }

  /* The one thing a single capture can never say. It goes above the findings,
     because "what appeared since last time" is the question the money depends
     on, and the description of the room is context for it. */
  const change = room.change;
  if (change) {
    const line = (entry, mark) =>
      `<li><b>${escapeText(mark)}</b> ${escapeText(entry.text)}${
        entry.nearest_previous ? ` <em>· closest earlier note: ${escapeText(entry.nearest_previous)}</em>` : ""
      }</li>`;
    const block = document.createElement("div");
    block.className = "sheet-findings-group sheet-change";
    block.innerHTML = `
      <h4>Compared with ${escapeText(change.earlier_label)}</h4>
      <p class="sheet-change-headline">${escapeText(change.headline)}</p>
      <span class="marker-state review">AI suggestion · not verified</span>
      ${change.appeared.length
        ? `<ul class="sheet-change-list appeared">${change.appeared.map((entry) => line(entry, "＋")).join("")}</ul>`
        : `<p class="sheet-change-empty">Nothing new is visible in the later capture.</p>`}
      ${change.gone.length
        ? `<h4>No longer in view</h4><ul class="sheet-change-list gone">${change.gone.map((entry) => line(entry, "?")).join("")}</ul>
           <p class="sheet-change-empty">A thing can leave the frame without leaving the room. These are questions, not removals.</p>`
        : ""}
      ${change.unchanged.length
        ? `<p class="sheet-change-empty">${change.unchanged.length} thing${change.unchanged.length === 1 ? " was" : "s were"} present in both captures.</p>`
        : ""}
      ${change.reliability_note ? `<p class="sheet-change-empty">${escapeText(change.reliability_note)}</p>` : ""}`;
    findings.appendChild(block);
  }

  /* The sphere is where a marker lives, but the space record has to say the
     markers exist — and which of them the record is still missing a document
     for. A row here is a way into the sphere, not a substitute for it. */
  const markers = roomMarkers(room);
  const openRequests = (room.requests || []).filter((entry) => entry.state === "open");
  if (markers.length || openRequests.length) {
    const extra = document.createElement("div");
    extra.className = "sheet-findings-group sheet-markers";
    const target = spatialItems[0];
    extra.innerHTML = `
      ${markers.length
        ? `<h4>Marked in the sphere</h4><ul class="sheet-marker-list">${markers
            .map(
              (marker) =>
                `<li><button type="button" data-sheet-marker="${escapeText(marker.id)}"><span>${escapeText(marker.label)}</span><em class="marker-state ${escapeText(window.MDAIMarkers360?.stateTone(marker.state) || "review")}">${escapeText(window.MDAIMarkers360?.stateLabel(marker.state) || "Seen by AI")}</em></button></li>`,
            )
            .join("")}</ul>`
        : ""}
      ${openRequests.length
        ? `<h4>Waiting on a document</h4><ul>${openRequests
            .map((entry) => `<li>${escapeText(entry.text)}</li>`)
            .join("")}</ul>`
        : ""}`;
    findings.appendChild(extra);
    extra.querySelectorAll("[data-sheet-marker]").forEach((button) => {
      button.addEventListener("click", () => {
        if (!target) {
          notify("This space has no playable 360 export yet, so the marker cannot be shown in place.", 6000);
          return;
        }
        openEvidenceViewer(target, room, button.dataset.sheetMarker);
      });
    });
  }

  $("#sheet-note").value = room.note || "";
  $("#sheet-verify-state").textContent = confirmed
    ? "A person confirmed this record."
    : "Nothing here counts as a fact until a person confirms it.";
  $("#sheet-confirm").disabled = !room.evidence.length;
  $("#sheet-confirm").textContent = confirmed ? "Reopen for verification" : "Confirm visible record";

  const foot = $("#sheet-foot");
  const actions = [
    spatialItems.length
      ? { label: "Open 360 view", primary: true, run: () => openEvidenceViewer(spatialItems[0], room) }
      : { label: "Open 360 view", disabled: true, reason: "This space has no playable equirectangular export yet. Upload one from Insta360 Studio.", run: () => showFocusStage("upload") },
    {
      label: "Add photos to this room",
      run: () => {
        uploadRoomId = room.id;
        closeFocusSheet(false);
        showFocusStage("upload");
        $("#focus-evidence-files").click();
      },
    },
    room.analysis
      ? { label: "Read this room again", run: () => runFocusRoomAnalysis(room) }
      : { label: "Read this room", run: () => runFocusRoomAnalysis(room) },
    roomCanCompare(room)
      ? { label: room.change ? "Compare again" : "Compare with the previous capture", run: () => runRoomComparison(room) }
      : null,
    room.analysis ? { label: "Report for this room", run: () => openRoomReport(room) } : null,
    { label: "Request another capture", run: () => openFieldOperations() },
  ].filter(Boolean);
  foot.innerHTML = actions
    .map(
      (action, index) =>
        `<button type="button" class="${action.primary ? "primary" : ""}${action.disabled ? " muted" : ""}" data-sheet-action="${index}">${escapeText(action.label)}</button>`,
    )
    .join("");
  foot.querySelectorAll("[data-sheet-action]").forEach((button) => {
    const action = actions[Number(button.dataset.sheetAction)];
    button.addEventListener("click", () => {
      if (action.disabled && action.reason) notify(action.reason, 6000);
      action.run();
    });
  });
}

async function runRoomComparison(room) {
  if (!cloud.schemaReady || !cloud.propertyId) {
    notify("A secure Supabase connection is required to compare captures");
    return;
  }
  focusProcessingComplete = false;
  closeFocusSheet(false);
  showFocusStage("process");
  $("#focus-processing-title").textContent = "Comparing captures…";
  $("#focus-processing-copy").textContent = `Reading each capture of ${room.name} on its own, then differencing them.`;
  focusProcessingRows = [{ roomId: room.id, name: room.name, state: "running", detail: "Starting" }];
  renderFocusProcessing(8, "Preparing both captures…");
  try {
    let step = 0;
    const change = await compareRoomCaptures(room, (message) => {
      step += 1;
      focusProcessingRows[0].detail = message;
      renderFocusProcessing(Math.min(88, 8 + step * 18), message);
    });
    focusProcessingRows[0].state = "done";
    focusProcessingRows[0].detail = change.headline;
  } catch (error) {
    console.error(error);
    focusProcessingRows[0].state = "failed";
    focusProcessingRows[0].detail = error.message || "The comparison failed";
  }
  focusProcessingComplete = true;
  finishFocusProcessing();
  offerMoneyQuestions();
}

/* The moment the record learns what kind of work it just saw is the moment to
   ask what it cost — while the person is still holding the phone in the room
   that prompted the question. */
function offerMoneyQuestions() {
  const coverage = projectCoverage();
  if (!coverage?.questions.length) return;
  window.setTimeout(() => openMoneyQuestions(coverage.questions[0].key), 700);
}

/* Why the AI cannot read this room yet, in words that name the next move.

   The old sentence — "Add a visual capture first" — was true in the narrow sense
   and useless in every other. Someone who has just uploaded both lens files of a
   360 capture has added the only visual capture they have; telling them to add
   one sends them back to do the thing they already did. A room holding a
   complete camera pair is not missing evidence, it is waiting for the machine
   that turns that evidence into something a model can read.

   Returns null when the room is ready. */
function analysisBlocker(room) {
  const evidence = room?.evidence || [];
  if (evidence.some((item) => isImage(item) || isVideo(item))) return null;
  if (!evidence.length) {
    return "This room is empty. Add a photo, a video, or a 360 capture.";
  }
  const originals = evidence.filter(focusIsCameraOriginal);
  if (originals.length) {
    /* A dual-lens capture is normally one tile carrying two source ids, but
       counting tiles would report "2 captures" for one capture if it ever
       arrived uncollapsed. Count the captures themselves. */
    const paired = [...new Set(
      originals
        .filter((item) => (item.sourceIds?.length || 0) >= 2)
        .map((item) => [...item.sourceIds].sort().join("|")),
    )];
    if (paired.length) {
      /* What the machine did yesterday is not what is happening to this file.
         "The 360 machine finished 1 day ago — 2 captures stitched" appended to
         a capture uploaded a minute ago reads as reassurance that it is being
         handled. It is not: the machine is off, and this capture will sit in
         the queue until somebody starts it. Say which of those is true. */
      const machine = machineStatus();
      /* Composed from the machine's own report rather than wrapped around
         machineLine(), which already opens with "The 360 machine is running"
         and produced a stutter when quoted inside another sentence. */
      let now;
      if (machine.awake && machine.preparing) {
        now = `The 360 machine is getting itself ready — ${machine.step || "preparing"}. The first build takes ten to twenty minutes, then it works the queue in order.`;
      } else if (machine.awake) {
        const done = machine.completed ? `, ${machine.completed} stitched so far` : "";
        now = `The 360 machine is running now — ${machine.step || "working"}${done} — and it takes the queue in order.`;
      } else if (machine.known && machine.everRan && machine.minutes != null) {
        const what = machine.stopped ? "stopped" : machine.finished ? "finished" : "last reported";
        now = `Nothing is stitching this right now: the 360 machine ${what} ${machineAgo(machine.minutes)} and has to be started again before this capture can be read.`;
      } else {
        now = "Nothing is stitching this right now — the 360 machine has to be started before this capture can be read.";
      }
      return `This room holds ${paired.length === 1 ? "a complete 360 capture" : `${paired.length} complete 360 captures`}. The original${paired.length === 1 ? " is" : "s are"} safe and linked to this project. A browser cannot read the camera's INSV format, so the 360 machine stitches ${paired.length === 1 ? "it" : "them"} into a playable master first — the AI reads that. ${now}`;
    }
    return "One lens file of this 360 capture is missing. Both halves are what the 360 machine stitches from — upload the matching INSV file.";
  }
  return "This room holds documents only. The AI reads photos, video and stitched 360 captures; add one of those to interpret the space.";
}

/* Why the AI cannot read this room yet, kept on screen, with the way forward.
   A capture waiting for the machine is not a dead end: a 360 MP4 exported from
   Insta360 Studio is playable in a browser and readable by the model today,
   without waiting for anything of ours. */
function showBlockedProcessing(room, blocked) {
  showFocusStage("process");
  const waitingForMachine = !machineStatus().awake && /360 machine/.test(blocked);
  $("#focus-processing-title").textContent = waitingForMachine
    ? "Waiting for the 360 machine"
    : "The AI cannot read this room yet";
  $("#focus-processing-copy").textContent = blocked;
  const meter = document.querySelector(".focus-processing-meter");
  /* A meter at 0% beside a headline about waiting suggests something is
     counting. Nothing is. */
  if (meter) meter.hidden = true;
  $("#focus-processing-status").textContent = room?.name ? `Room: ${room.name}` : "";
  $("#focus-processing-machine").hidden = true;
  $("#focus-processing-list").innerHTML = waitingForMachine
    ? `<p class="focus-processing-alt">You do not have to wait for it. Insta360 Studio exports a full 360 MP4 from the same capture — that plays in a browser and the AI reads it straight away. The camera originals stay in the record either way.</p>`
    : "";
  const view = $("#focus-view-results");
  if (view) { view.hidden = true; view.disabled = true; }
  const action = $("#focus-blocked-action");
  if (action) {
    action.hidden = false;
    action.textContent = waitingForMachine ? "Upload a 360 export instead" : "Back to the upload screen";
    action.dataset.openPicker = waitingForMachine ? "1" : "";
  }
  /* The machine is started from here now, not from a cloud console. Uploading a
     capture already asks for it on its own; this is the same request made
     deliberately by somebody looking at the room that is waiting. */
  const start = $("#focus-start-machine");
  if (start) {
    start.hidden = !waitingForMachine;
    start.disabled = false;
    start.textContent = "Start the 360 machine";
  }
}

/* What came back is what is shown. "Starting…" over "nothing is queued" or over
   "it is already running" would be a lie, and those are useful answers. */
async function startCaptureMachine() {
  const button = $("#focus-start-machine");
  if (!button || button.disabled) return;
  if (!cloud.schemaReady || !cloud.session) {
    notify("Sign in before starting the 360 machine");
    return;
  }
  button.disabled = true;
  button.textContent = "Asking the machine to start…";
  try {
    const { data, error } = await cloud.client.functions.invoke("capture-machine", { body: {} });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    const said = {
      started: "The 360 machine is starting. It takes a couple of minutes to come up, then it works the queue in order.",
      already_awake: "The 360 machine is already running — it takes the queue in order.",
      nothing_queued: "Nothing is waiting to be stitched, so the machine was left alone.",
      too_soon: "The machine was started a few minutes ago and is still coming up.",
      not_configured: "No 360 machine is connected to this deployment yet, so nothing could be started.",
      failed: "The 360 machine could not be started. The capture is safe and still queued.",
    }[data?.outcome] || data?.detail || "The machine was asked to start.";
    notify(said, 9000);
    $("#focus-processing-copy").textContent = said;
    /* A machine that is coming up will report in on its own; the screen catches
       up the next time the record is read rather than guessing at it here. */
    if (data?.outcome === "started" || data?.outcome === "already_awake") {
      button.textContent = "The machine is coming up";
      scheduleStitchPoll();
      return;
    }
  } catch (error) {
    console.error(error);
    notify("The 360 machine could not be reached. The capture is safe and still queued.");
  }
  button.disabled = false;
  button.textContent = "Start the 360 machine";
}

/* Every other path through this stage is a real run, so both controls go back
   to what they were before anything is shown. */
function resetProcessingStageControls() {
  const meter = document.querySelector(".focus-processing-meter");
  if (meter) meter.hidden = false;
  const start = $("#focus-start-machine");
  if (start) { start.hidden = true; start.disabled = false; }
  const view = $("#focus-view-results");
  if (view) view.hidden = false;
  const action = $("#focus-blocked-action");
  if (action) { action.hidden = true; action.dataset.openPicker = ""; }
}

async function runFocusRoomAnalysis(room) {
  const blocked = analysisBlocker(room);
  if (blocked) {
    /* A sentence that vanishes in nine seconds is what "I press Process with AI
       and nothing happens" actually looks like. The answer stays on screen, and
       it carries the one thing a person can still do. */
    showBlockedProcessing(room, blocked);
    return;
  }
  if (!cloud.schemaReady || !cloud.propertyId) {
    notify("A secure Supabase connection is required for AI analysis");
    return;
  }
  const previous = room.analysis;
  room.analysis = null;
  focusProcessingComplete = false;
  closeFocusSheet(false);
  /* This stage may still be wearing the answer it gave for a room that could not
     be read. Left alone, "Start the 360 machine" and "Upload a 360 export
     instead" sat under a live AI run — offering to start a machine whose work
     was already finished — while the meter stayed hidden and "View results"
     never came back. */
  resetProcessingStageControls();
  /* Rows first, then the screen: showFocusStage reads them to decide what the
     screen is about, and an empty list means "nothing is running". */
  focusProcessingRows = [{ roomId: room.id, name: room.name, state: "queued", detail: "Queued" }];
  showFocusStage("process");
  renderFocusProcessing(10, "Preparing the evidence…");
  try {
    await analyzeFocusRoom(room, (message) => {
      focusProcessingRows[0].state = "running";
      focusProcessingRows[0].detail = message;
      renderFocusProcessing(55, message);
    });
    focusProcessingRows[0].state = "done";
    focusProcessingRows[0].detail = "Interpretation ready";
  } catch (error) {
    console.error(error);
    room.analysis = previous;
    focusProcessingRows[0].state = "failed";
    focusProcessingRows[0].detail = error.message || "The analysis failed";
  }
  focusProcessingComplete = true;
  finishFocusProcessing();
  offerMoneyQuestions();
}

/* --------------------------------------------------------------- Results view */

function focusReadyCopy(stats) {
  if (!stats.rawFiles) return "Ready for evidence.";
  const captureCopy = stats.paired360
    ? ` · ${stats.paired360} paired 360 capture${stats.paired360 === 1 ? "" : "s"}`
    : "";
  return `${stats.rawFiles} file${stats.rawFiles === 1 ? "" : "s"} ready${captureCopy}.`;
}

/* The report is what the client actually receives: the Studio is where the
   record is made, the report is where it is handed over. It is assembled from
   the same record the screen shows, so the two can never disagree. */
function buildReportModel() {
  const stats = focusEvidenceStats();
  const next = focusNextAction(stats);
  const spatial = stats.spatial[0];
  const now = new Date();
  return {
    project: {
      name: propertyRecord.name || "Project",
      prepared_at: now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
      prepared_by: cloud.session?.user?.email || "",
      last_evidence: stats.lastUpdate
        ? new Date(stats.lastUpdate).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
        : "no evidence yet",
      studio_url: `${window.location.origin}${window.location.pathname}?property=${cloud.propertyId}`,
    },
    headline: focusHeadline(stats),
    summary: {
      originals: stats.rawFiles,
      spaces: stats.spaces.length,
      interpreted: stats.analyzableRooms.length
        ? `${stats.analyzedRooms.length}/${stats.analyzableRooms.length}`
        : "—",
      confirmed: stats.spaces.length ? `${stats.confirmedRooms.length}/${stats.spaces.length}` : "—",
    },
    vr: { count: stats.spatial.length, link: spatial ? focusEvidenceUrl(spatial) : "" },
    spaces: stats.spaces.map((room) => {
      const files = room.evidence.reduce((total, item) => total + focusSourceCount(item), 0);
      const roomSpatial = room.evidence.find(focusIsSpatial);
      return {
        name: room.name,
        location: [room.building, room.level].filter(Boolean).join(" · "),
        status: room.status === "confirmed" ? "confirmed" : room.analysis ? "review" : "not_interpreted",
        summary: room.analysis?.summary ||
          "Evidence is preserved for this space. No interpretation has been produced yet.",
        visible: room.visible || [],
        unknown: room.unknown || [],
        note: (room.note || "").trim(),
        capture_requests: room.analysis?.follow_up_captures || [],
        change: room.change || null,
        markers: roomMarkers(room).map((marker) => ({
          label: marker.label,
          state: window.MDAIMarkers360?.stateLabel(marker.state) || "Seen by AI · not verified",
          at: window.MDAIMarkers360?.timecode(marker.timestamp_seconds) || "",
        })),
        document_requests: (room.requests || [])
          .filter((entry) => entry.state === "open")
          .map((entry) => entry.text),
        files_line: `${files} original file${files === 1 ? "" : "s"} preserved`,
        trim_note: roomSpatial ? focusEvidenceTrimNote(roomSpatial) : "",
        spatial_link: roomSpatial ? focusEvidenceUrl(roomSpatial) : "",
        /* Photographs carry the report; a signed link expires, which the
           footer says plainly rather than leaving a reader with dead images. */
        thumbnails: room.evidence.filter((item) => isImage(item) && item.src).slice(0, 6).map((item) => item.src),
      };
    }),
    changed: focusChangeItems(stats),
    next: { title: next.title, copy: next.copy, owner: next.owner },
    open_questions: stats.openQuestions.map((entry) => `${entry.room.name}: ${entry.text}`),
    capture_requests: stats.followUps.map((entry) =>
      `${entry.room.name}: ${entry.request}${entry.reason ? ` — ${entry.reason}` : ""}`,
    ),
    /* A gap between what the record shows and what the paperwork covers is a
       request, not a remark: it names the document and the space it belongs to. */
    document_requests: stats.spaces.flatMap((room) =>
      (room.requests || [])
        .filter((entry) => entry.state === "open")
        .map((entry) => entry.text),
    ),
    money: projectCoverage(),
  };
}

/* The same document, narrowed to one room. A room report is what a person
   actually sends about a room; the project report is what a client receives. */
function openRoomReport(room) {
  const model = buildReportModel();
  const only = model.spaces.filter((space) => space.name === room.name);
  if (!only.length) {
    notify("This room has nothing to report yet");
    return;
  }
  const scoped = {
    ...model,
    headline: `${room.name} · ${[room.building, room.level].filter(Boolean).join(" · ")}`,
    spaces: only,
    summary: { ...model.summary, spaces: 1 },
    changed: model.changed.filter((entry) => String(entry.title || "").startsWith(room.name)),
    open_questions: model.open_questions.filter((text) => String(text).startsWith(`${room.name}:`)),
  };
  if (!window.MDAIReport?.open(scoped)) {
    notify("Allow pop-ups for this site to open the report");
    return;
  }
  recordClientEvent("report.generated", { scope: "space", space_id: room.id, space_name: room.name });
}

/* The decision log and the pilot metrics live behind the audit table, which
   the browser cannot read directly — the RPC hands them to the roles that run
   the project. A viewer still gets the report; its decision section says who
   holds the log instead of pretending there is none. */
async function fetchOwnerReportData() {
  try {
    const { data, error } = await cloud.client.rpc("owner_report_data", { p_property_id: cloud.propertyId });
    if (error) throw error;
    return data || null;
  } catch (error) {
    console.warn("owner report data unavailable", error);
    return null;
  }
}

async function openProjectReport() {
  const stats = focusEvidenceStats();
  if (!stats.rawFiles) {
    notify("The report needs evidence first");
    showFocusStage("upload");
    return;
  }
  /* The tab opens inside the click — a popup opened after an await is a popup
     the browser blocks — and fills in once the decision log arrives. */
  const page = window.open("", "_blank");
  if (!page) {
    notify("Allow pop-ups for this site to open the report");
    return;
  }
  page.document.write('<p style="font:15px/1.5 -apple-system,Arial,sans-serif;padding:32px;color:#4a6076">Preparing the report — gathering the decision log…</p>');
  const model = buildReportModel();
  model.owner = await fetchOwnerReportData();
  window.MDAIReport.openInto(page, model);
  /* A report is the document that leaves the building, so who produced one and
     when is exactly the sort of thing a customer will one day ask us. */
  recordClientEvent("report.generated", {
    scope: "project",
    space_count: stats.spaces.length,
    evidence_count: stats.rawFiles,
  });
}

function renderFocusResults() {
  const stats = focusEvidenceStats();
  const metrics = [
    {
      value: String(stats.rawFiles),
      label: "Original files preserved",
      hint: "Nothing is altered or re-encoded",
    },
    {
      value: String(stats.spaces.length),
      label: "Spaces with evidence",
      hint: "Open one to see its record",
    },
    {
      value: stats.analyzableRooms.length ? `${stats.analyzedRooms.length}/${stats.analyzableRooms.length}` : "—",
      label: "Spaces interpreted by AI",
      hint: stats.analyzableRooms.length ? "Suggestions, not verified facts" : "No visual evidence yet",
    },
    {
      value: stats.spaces.length ? `${stats.confirmedRooms.length}/${stats.spaces.length}` : "—",
      label: "Confirmed by a person",
      hint: "Only these count as record",
    },
  ];
  $("#focus-result-metrics").innerHTML = metrics
    .map(
      (metric) =>
        `<article><strong>${escapeText(metric.value)}</strong><small>${escapeText(metric.label)}</small><em>${escapeText(metric.hint)}</em></article>`,
    )
    .join("");

  const vrCard = $("#focus-vr-card");
  /* Our processing queue is not a finding about the building. It is reported
     here, beside the captures it concerns, and never as the project's next
     decision — a person reading the top of this screen is asking what to do
     about the property, not about our GPU. */
  /* "The camera originals are untouched" was appended to every one of these
     lines, including "Stitching now — 41%", where it reads as a contradiction:
     the machine is plainly touching them. The promise being made is that we
     never alter an original — stitching writes a new file beside it — so it is
     now worded as the rule it is, and holds while the machine is working. */
  const stitchNote = stats.stitchLine
    ? `<p class="focus-vr-note">${escapeText(stats.stitchLine)}. Originals are never altered — a stitch writes a new file beside them.</p>`
    : "";
  if (stats.spatial.length) {
    /* Naming the room the person is in, and — when it has nothing playable —
       saying that plainly instead of offering another room as though it were
       the answer to the question they asked. */
    const here = currentFocusRoom();
    const hereHasOne = Boolean(spatialForRoom(here));
    const standingIn = here && !hereHasOne
      ? `<p class="focus-vr-elsewhere">${escapeText(here.name)} has no playable 360 yet — its camera originals are preserved and waiting on the machine. The capture below is in ${escapeText(spatialToOffer()?.room?.name || "another room")}.</p>`
      : "";
    vrCard.innerHTML = `<header><h3>Spatial evidence</h3><span class="focus-vr-badge">VR-ready</span></header><p>${stats.spatial.length} capture${stats.spatial.length === 1 ? " is" : "s are"} playable as a full sphere. Open one here, or send the link to a headset for review in place.</p>${standingIn}${stitchNote}<div class="focus-vr-actions"><button class="focus-primary-action" type="button" data-vr-action="open">${escapeText(newestSpatialLabel())} <span>&rarr;</span></button>${
      /* This card offered exactly one room — the newest capture — so a project
         with nine playable rooms let somebody stand in one of them and gave no
         way to reach the rest. */
      stats.spatial.length > 1
        ? `<button class="focus-secondary-action" type="button" data-vr-action="choose">Stand in another room (${stats.spatial.length})</button>`
        : ""
    }<button class="focus-secondary-action" type="button" data-vr-action="copy">Copy link for Vision Pro</button></div>`;
  } else if (stats.paired360 || stats.waiting360) {
    const pairText = `${stats.paired360} paired 360 capture${stats.paired360 === 1 ? "" : "s"}`;
    const waitingText = stats.waiting360
      ? ` ${stats.waiting360} capture${stats.waiting360 === 1 ? " is" : "s are"} waiting for a matching lens file.`
      : "";
    vrCard.innerHTML = `<header><h3>Spatial evidence</h3><span class="focus-vr-badge">Originals secured</span></header><p>${pairText} preserved and linked to the project.${waitingText} A browser cannot play the protected camera format — export a full 360 MP4 in Insta360 Studio and upload it to make the space walkable.</p>${stitchNote}<div class="focus-vr-actions"><button class="focus-secondary-action" type="button" data-vr-action="upload">Upload the 360 export</button></div>`;
  } else {
    vrCard.innerHTML = `<header><h3>Spatial evidence</h3><span class="focus-vr-badge">Not captured</span></header><p>This project has no 360 capture yet. A photo record still works, but only a full sphere lets a reviewer stand inside the space.</p>${stitchNote}<div class="focus-vr-actions"><button class="focus-secondary-action" type="button" data-vr-action="upload">Add a 360 capture</button></div>`;
  }
  vrCard.querySelectorAll("[data-vr-action]").forEach((button) => {
    const action = button.dataset.vrAction;
    button.addEventListener("click", () => {
      if (action === "open") openFirstSpatial();
      else if (action === "copy") copyFocusLink(spatialToOffer()?.item || stats.spatial[0]);
      else if (action === "choose") {
        /* Straight into the list, already narrowed to the captures somebody can
           stand in, so choosing a room is one press rather than a hunt. */
        fileList.search = "vr-master";
        fileList.dupesOnly = false;
        openFileList().then(() => {
          const search = $("#focus-files-search");
          if (search) search.value = fileList.search;
          const dupes = $("#focus-files-dupes");
          if (dupes) dupes.checked = false;
        });
      }
      else showFocusStage("upload");
    });
  });

  /* Short by construction: one row per kind of work, not per thing seen. The
     row that leads is money recorded against work nobody can find. */
  const coverage = projectCoverage();
  const moneyCard = $("#focus-money-card");
  if (coverage && coverage.trades.length) {
    const row = (trade) => {
      const tone = trade.state === "no_evidence" ? "alarm" : trade.state === "no_money" ? "ask" : "ok";
      const right = trade.state === "no_evidence"
        ? `<b>not visible on the property</b>`
        : trade.state === "no_money"
          ? `<em>no cost recorded</em>`
          : escapeText(trade.amount_label);
      return `<button class="money-row tone-${tone}" type="button" data-trade-row="${escapeText(trade.key)}">
        <span class="money-row-work">${escapeText(trade.label)}<small>${
          trade.evidence_count
            ? `${trade.evidence_count} seen in ${escapeText(trade.spaces.slice(0, 2).join(", "))}${trade.spaces.length > 2 ? " +" + (trade.spaces.length - 2) : ""}${trade.new_count ? ` · ${trade.new_count} new` : ""}`
            : "nothing seen in the capture record"
        }</small></span>
        <span class="money-row-amount">${right}</span>
      </button>`;
    };
    moneyCard.hidden = false;
    moneyCard.innerHTML = `
      <header><h3>Work and money</h3>${
        coverage.recorded_label ? `<span class="focus-vr-badge">${escapeText(coverage.recorded_label)} recorded</span>` : ""
      }</header>
      <p class="money-headline${coverage.alarms.length ? " alarm" : ""}">${escapeText(coverage.headline)}</p>
      <div class="money-rows">${coverage.trades.filter((trade) => trade.billable || trade.has_amount).map(row).join("")}</div>
      <div class="focus-vr-actions">
        ${coverage.questions.length
          ? `<button class="focus-primary-action" type="button" data-money="ask">Record what these cost</button>`
          : ""}
        ${coverage.alarms.length
          ? `<button class="focus-secondary-action" type="button" data-money="alarm">Ask where ${escapeText(coverage.alarms[0].label.toLowerCase())} was done</button>`
          : ""}
      </div>
      ${costsWaitingInBrowser && costsAreInTheRecord
        ? `<p class="money-headline alarm">${costsWaitingInBrowser} figure${costsWaitingInBrowser === 1 ? "" : "s"} ${
            costsWaitingInBrowser === 1 ? "is" : "are"
          } in this browser only — not in the project record, not in the export, and gone if this cache is cleared.</p>
          <div class="focus-vr-actions"><button class="focus-primary-action" type="button" data-money="move">Move ${
            costsWaitingInBrowser === 1 ? "it" : "them"
          } into the record</button></div>`
        : ""}
      <p class="focus-vr-note">Money is only ever entered by a person. The AI never reads an amount and never decides which invoice belongs to which work.</p>`;
    moneyCard.querySelectorAll("[data-trade-row]").forEach((button) =>
      button.addEventListener("click", () => openTradeEditor(button.dataset.tradeRow)),
    );
    moneyCard.querySelector('[data-money="move"]')?.addEventListener("click", () => { void moveBrowserCostsIntoRecord(); });
    moneyCard.querySelector('[data-money="ask"]')?.addEventListener("click", () => openMoneyQuestions());
    moneyCard.querySelector('[data-money="alarm"]')?.addEventListener("click", () => requestTradeDocument(coverage.alarms[0]));
  } else {
    moneyCard.hidden = true;
    moneyCard.innerHTML = "";
  }

  const list = $("#focus-result-list");
  /* Every space, not only the ones holding files. A space created by mistake and
     left empty used to vanish from this list, which made it unreachable — and an
     unreachable space cannot be opened, renamed, or deleted. */
  const orderedSpaces = rooms.slice().sort((a, b) => roomLastActivity(b) - roomLastActivity(a));
  list.innerHTML = orderedSpaces.length
    ? orderedSpaces
        .map((room) => {
          const rawCount = room.evidence.reduce((total, item) => total + focusSourceCount(item), 0);
          const spatialCount = room.evidence.filter(focusIsSpatial).length;
          const status = !rawCount
            ? "Empty"
            : room.status === "confirmed"
              ? "Human verified"
              : room.analysis
                ? "Needs verification"
                : "Not interpreted";
          const tone = !rawCount ? "wait" : room.status === "confirmed" ? "ok" : room.analysis ? "review" : "wait";
          const summary = room.analysis?.summary || room.visible?.[0] ||
            (rawCount
              ? "Evidence is preserved. No interpretation has been produced for this space yet."
              : "No evidence has been added to this space yet. Open it to add files, rename it, or remove it.");
          const tags = [
            `${rawCount} file${rawCount === 1 ? "" : "s"}`,
            spatialCount ? `${spatialCount} × 360` : "",
          ].filter(Boolean).join(" · ");
          return `<button class="focus-result-card tone-${tone}" type="button" data-space="${escapeText(room.id)}"><header><h3>${escapeText(room.name)}</h3><b>${escapeText(status)}</b></header><p>${escapeText(summary)}</p><footer><small>${escapeText(tags)}</small><span>Open evidence &rarr;</span></footer></button>`;
        })
        .join("")
    : `<p class="sheet-empty">No space holds evidence yet. Upload files and they will be organized here.</p>`;
  list.querySelectorAll("[data-space]").forEach((button) => {
    button.addEventListener("click", () => openFocusSheet(button.dataset.space, "results"));
  });
}

function focusStatusLine(stats) {
  if (!stats.rawFiles) return "Evidence required";
  if (!focusProcessingComplete) return "Ready for AI processing";
  if (stats.awaitingReview.length) return "Human verification required";
  if (stats.confirmedRooms.length && stats.confirmedRooms.length >= stats.spaces.length) return "Record verified";
  return "Project record ready";
}

function renderFocusStudio() {
  const stats = focusEvidenceStats();
  $("#focus-project-name").textContent = propertyRecord.name || "Project";
  $("#focus-project-summary").textContent = `\u25CF ${focusStatusLine(stats)}`;
  const uploaded = $("#focus-upload-done");
  uploaded.hidden = !stats.rawFiles;
  /* What was just uploaded, not what the project happens to contain. This line
     sits directly under "Upload complete · 100%", so a project-wide total read
     as a description of the upload that had only just finished: two files went
     up and the screen said forty-two. */
  $("#focus-upload-done-copy").textContent = focusLastUploadCount
    ? `${focusLastUploadCount} file${focusLastUploadCount === 1 ? "" : "s"} uploaded · ${stats.rawFiles} in this project`
    : `${stats.rawFiles} file${stats.rawFiles === 1 ? "" : "s"} in this project`;
  $("#focus-upload-more").hidden = !stats.rawFiles;
  $("#focus-process").disabled = !stats.rawFiles || focusUploadBusy;
  renderFocusToday();
  renderFocusResults();
  /* The pickers are part of the screen, not part of arriving at it. Rendered
     only on arrival, they held whatever they were built with — which is the
     same snapshot fault, one control lower down. */
  renderUploadPicker();
  renderAnalyzePicker();
  if ($("#focus-sheet") && !$("#focus-sheet").hidden) renderFocusSheet();
  applyFocusStage();
}

function openFocusStudio() {
  focusUploadBusy = false;
  focusLastUploadCount = 0;
  focusProcessingRows = [];
  focusProcessingComplete = window.localStorage.getItem(`mdai-focus-processed:${cloud.propertyId}`) === "1";
  /* Opening a project always lands on the one action that moves it forward. */
  focusStage = "upload";
  renderFocusStudio();
}

/* --------------------------------------------------------------------- Upload */

/* The gate: what the record already knows about a file, said before the bytes
 * move.
 *
 * Every filing mistake in this record so far was knowable at the moment of
 * upload — the same capture already in another room, the same file already in
 * this one — and the Studio knew it and said nothing. The person found out a
 * day later, from a count that did not add up. "The machine should have seen
 * this" is exactly right: this is where it sees it.
 *
 * It warns and asks; it does not silently refuse. The person may genuinely
 * mean it — a re-shoot with the same filename, a corrected export — and a gate
 * that cannot be overridden is a different bug wearing a safety vest. */
function uploadGateQuestions(files) {
  const questions = [];
  for (const file of files) {
    const name = String(file.name || "").toLowerCase();
    const chosen = rooms.find((room) => room.id === uploadRoomId) || null;
    /* A PDF with a room already chosen used to file itself silently: an
       invoice or a plan set became a room document the AI's room reading
       cannot use, and the comparison starved without anyone being told.
       With no room chosen the destination check below already redirects;
       this is the same answer for the door that would otherwise stay quiet. */
    if (chosen && focusIsPlanDocument(file)) {
      questions.push(`${file.name} is a PDF. Plan sets and delivery paperwork are read on the Project plans screen — that reading is what fills the comparison. Uploaded here it becomes a room document in ${chosen.name} that the AI's room reading cannot use.`);
    }
    const holders = [];
    for (const room of rooms) {
      const holds = (room.evidence || []).some((item) =>
        (item.sourceNames || [item.name]).some((entry) => String(entry || "").toLowerCase() === name),
      );
      if (holds) holders.push(room);
    }
    if (!holders.length) continue;
    const here = chosen && holders.some((room) => room.id === chosen.id);
    const elsewhere = holders.filter((room) => !chosen || room.id !== chosen.id);
    if (here) {
      questions.push(`${file.name} is already in ${chosen.name}. Uploading it again makes a second copy there — it does not replace the first.`);
    }
    if (elsewhere.length) {
      questions.push(`${file.name} is already in ${elsewhere.map((room) => room.name).join(", ")}. A capture was taken in one room — if it is filed wrongly, move it from "See every file" instead of uploading it again.`);
    }
  }
  return questions;
}

async function uploadFocusEvidence(pickedFiles) {
  const files = [...pickedFiles].filter(focusFileAllowed);
  if (!files.length || focusUploadBusy) {
    if (pickedFiles?.length) notify("Choose photos, video, PDF, INSV, INSP, or LRV files");
    return;
  }
  const questions = uploadGateQuestions(files);
  if (questions.length) {
    const proceed = window.confirm(
      `${questions.join("\n\n")}\n\nUpload anyway?`,
    );
    if (!proceed) {
      notify("Nothing was uploaded. The files already in the record are untouched.", 6000);
      /* Saying no to a misfiled PDF must not end in nothing: the door the
         file actually belongs to is offered, not described. */
      if (files.some((file) => focusIsPlanDocument(file))) {
        $("#focus-upload-progress").hidden = false;
        $("#focus-upload-progress-title").textContent = "Nothing was uploaded";
        $("#focus-upload-progress-detail").innerHTML =
          `PDFs are read on the plans screen, where they fill the comparison. <button type="button" class="room-picker-link" id="upload-error-plans">Open Project plans &rarr;</button>`;
        $("#upload-error-plans")?.addEventListener("click", openProjectPlans);
      }
      return;
    }
  }
  focusUploadBusy = true;
  focusProcessingComplete = false;
  window.localStorage.removeItem(`mdai-focus-processed:${cloud.propertyId}`);
  const progressBox = $("#focus-upload-progress");
  const progressBar = $("#focus-upload-progress-bar");
  const progressPercent = $("#focus-upload-progress-percent");
  const progressDetail = $("#focus-upload-progress-detail");
  progressBox.hidden = false;
  $("#focus-process").disabled = true;
  $("#focus-evidence-files").value = "";
  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const room = await ensureFocusDestination(file);
      $("#focus-upload-progress-title").textContent = `Uploading ${index + 1} of ${files.length}`;
      progressDetail.textContent = file.name;
      const measured = await measureMediaFile(file);
      const projection = equirectangularProjection(measured);
      const captureKey = projection ? exportCaptureKey(file.name) : null;
      const vr = focusVrMetadata(file, measured);
      /* Recorded, never cut: the upload keeps the whole original and states
         which part of it is the space rather than the operator. */
      const trim = file.type?.startsWith("video/") && vr.playback_ready && window.MDAITrim360
        ? window.MDAITrim360.plan(measured.duration_seconds)
        : null;
      const item = await uploadEvidenceToCloud(
        file,
        room,
        inferFocusMediaType(file),
        {
          subject: file.name,
          context: "Automatic project evidence intake",
          intakeMode: "focus-studio",
          evidenceCategory: inferFocusMediaType(file),
          ...measured,
          ...(projection ? { projection } : {}),
          /* reconcile_prestitched_360 reads this to attach the export to the
             INSV pair it was stitched from. */
          ...(captureKey
            ? { ready_360: { capture_key: captureKey, projection, processing_mode: "insta360-studio-export" } }
            : {}),
          ...(trim ? { trim } : {}),
          vr,
        },
        (progress) => {
          const totalPercent = Math.round(((index + progress.percent / 100) / files.length) * 100);
          progressBar.value = totalPercent;
          progressPercent.textContent = `${totalPercent}%`;
          progressDetail.textContent = `${file.name} · ${progress.label}`;
        },
      );
      room.evidence.push(item);
    }
    progressBar.value = 100;
    progressPercent.textContent = "100%";
    progressDetail.textContent = "Evidence secured. Organizing the project record…";
    await hydrateCloudRecord();
    $("#focus-upload-progress-title").textContent = "Upload complete";
    progressDetail.textContent = "Original files preserved and linked to this project.";
    focusLastUploadCount = files.length;
    notify(`${files.length} evidence file${files.length === 1 ? "" : "s"} uploaded`);
  } catch (error) {
    console.error(error);
    $("#focus-upload-progress-title").textContent = "Upload needs attention";
    progressDetail.textContent = error.message || "The upload could not be completed.";
    notify(error.message || "Upload failed", 10000);
    /* Where the file actually belongs, offered rather than described. */
    if (error.openPlans || !rooms.length) {
      progressDetail.innerHTML = `${escapeText(error.message || "The upload could not be completed.")} <button type="button" class="room-picker-link" id="upload-error-plans">Open Project plans &rarr;</button>`;
      $("#upload-error-plans")?.addEventListener("click", openProjectPlans);
    }
  } finally {
    focusUploadBusy = false;
    renderFocusStudio();
  }
}

/* ----------------------------------------------------------------- Processing */

/* Comparing two captures means reading each of them on its own. The analysis
   already accepts any subset of a space's files, so the same server call does
   both jobs: the whole space, or one day of it. */
async function analyzeFocusRoom(room, onStatus, options = {}) {
  const scope = Array.isArray(options.evidenceItems) ? options.evidenceItems : room.evidence;
  const evidenceIds = scope
    .filter((item) => item.storagePath && (isImage(item) || isVideo(item)))
    .map((item) => item.id);
  if (!evidenceIds.length) return { skipped: true };

  /* Frames first, job row second.
   *
   * It used to be the other way round, and refusing to send then left a row
   * sitting in "queued" for ever — a job the record says was asked for and
   * that nothing will ever finish. Nothing is written down until there is
   * something worth writing down. */
  onStatus(`Preparing ${room.name}`);
  const prepared = await prepareVideoFrames(scope);
  const { frames, warnings } = prepared;
  const blocked = nothingToAnalyse(scope, room.name, prepared);
  if (blocked) throw new Error(blocked);

  const { data: jobRow, error: jobError } = await cloud.client
    .from("analysis_jobs")
    .insert({
      organization_id: cloud.organizationId,
      property_id: cloud.propertyId,
      space_id: room.id,
      state: "queued",
      profile: "property-evidence-conservative",
      profile_version: "0.1",
      evidence_ids: evidenceIds,
      requested_by: cloud.session.user.id,
    })
    .select("id")
    .single();
  if (jobError) throw new Error(`Processing request failed: ${jobError.message}`);
  const localJob = {
    id: jobRow.id,
    roomId: room.id,
    roomName: room.name,
    evidenceCount: evidenceIds.length,
    profile: "Property evidence · conservative",
    status: "Analyzing evidence",
    createdAt: new Date().toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
  };
  jobs.unshift(localJob);
  saveJobs();
  try {
    onStatus(`AI is reviewing ${room.name}`);
    const { data, error } = await cloud.client.functions.invoke(config.aiFunctionName, {
      body: { job_id: jobRow.id, video_frames: frames },
    });
    if (error) throw await functionInvocationError(error);
    if (!data?.analysis) throw new Error(data?.error || "AI returned no result");
    localJob.status = "Completed";
    if (options.apply !== false) applyAnalysisResult(room, data.analysis, data.suggestion_id);
    saveJobs();
    return { warnings, analyzed: true, analysis: data.analysis, suggestionId: data.suggestion_id, evidenceIds };
  } catch (error) {
    localJob.status = "Failed";
    localJob.errorCode = error.message || "analysis_failed";
    saveJobs();
    throw error;
  }
}

/* What this screen is about, decided in one place.

   It used to be set inside showFocusStage, which runs *before* the rows for a
   new run exist — so starting an AI review left the previous headline standing.
   A person watching "AI is reviewing Family" was told, in the largest text on
   the screen, that they were waiting for the 360 machine. Two true sentences
   about two different things, one of them answering a question nobody asked. */
/* How far the machine is through what it is doing. Several captures can be in
   flight on one machine, so this is the mean of what is running — one number
   for one meter, and never a number invented for a job with no progress yet. */
function stitchProgressPercent(summary) {
  const running = (summary || stitchSummary()).running;
  if (!running.length) return 0;
  const total = running.reduce((sum, job) => sum + (Number(job.progress) || 0), 0);
  return Math.round(total / running.length);
}

function focusProcessingHeadline() {
  const active = focusProcessingRows.filter((row) => row.state === "queued" || row.state === "running");
  if (active.length) {
    const name = active[0].name || "this space";
    const more = active.length > 1 ? ` (+${active.length - 1} more)` : "";
    return {
      title: `Reading ${name}${more}`,
      copy: "The AI is looking at the evidence in this space. It reads what is there and never fills in what is not.",
    };
  }
  if (focusProcessingRows.length) {
    const failed = focusProcessingRows.filter((row) => row.state === "failed");
    return failed.length
      ? { title: "Some spaces could not be read", copy: "The evidence is untouched and can be retried." }
      : { title: "Done", copy: "The record has been updated with what the AI could establish." };
  }
  const stitch = stitchSummary();
  /* Working and waiting are not the same screen. Saying "waiting for the 360
     machine" while the machine is eighteen per cent through a capture describes
     the queue instead of the work, and reads as a stall to somebody who is in
     fact three minutes from a result. */
  if (stitch.running.length) {
    const more = stitch.active.length > stitch.running.length
      ? ` ${stitch.active.length - stitch.running.length} more queued behind it.`
      : "";
    return {
      title: "The 360 machine is stitching",
      copy: `It has the capture and is working on it.${more} This page keeps itself up to date — you can close it and come back.`,
    };
  }
  if (stitch.active.length) {
    return {
      title: "Waiting for the 360 machine",
      copy: "Captures are queued for stitching. Nothing runs in this browser — the machine picks the queue up when it starts, and Results updates on its own.",
    };
  }
  return {
    title: "Nothing is processing right now",
    copy: "This screen fills in when an AI review or a 360 stitch is running.",
  };
}

function renderFocusProcessing(percent, message) {
  const progress = $("#focus-processing-progress");
  progress.value = Math.max(0, Math.min(100, percent));
  $("#focus-processing-percent").textContent = `${Math.round(progress.value)}%`;
  $("#focus-processing-status").textContent = message;
  /* Re-derived on every render, so it cannot go stale behind a run that started
     after it was written. */
  const headline = focusProcessingHeadline();
  $("#focus-processing-title").textContent = headline.title;
  $("#focus-processing-copy").textContent = headline.copy;
  /* The machine keeps its own line whatever else is on screen — while the AI
     reads one room, the person waiting on a stitch can still see it working. */
  const machine = $("#focus-processing-machine");
  if (machine) {
    const line = focusProcessingRows.length ? stitchLine() : "";
    machine.textContent = line;
    machine.hidden = !line;
  }
  const list = $("#focus-processing-list");
  list.innerHTML = focusProcessingRows
    .map((row, index) => {
      const badge = { queued: "Waiting", running: "Working", done: "Ready", failed: "Failed" }[row.state] || row.state;
      const retry = row.state === "failed"
        ? `<button type="button" data-retry="${index}">Retry</button>`
        : "";
      return `<article class="processing-row state-${escapeText(row.state)}"><div><strong>${escapeText(row.name)}</strong><small>${escapeText(row.detail)}</small></div><span>${escapeText(badge)}</span>${retry}</article>`;
    })
    .join("");
  list.querySelectorAll("[data-retry]").forEach((button) => {
    const row = focusProcessingRows[Number(button.dataset.retry)];
    button.addEventListener("click", () => {
      const room = rooms.find((candidate) => candidate.id === row.roomId);
      if (room) runFocusRoomAnalysis(room);
    });
  });
}

function finishFocusProcessing() {
  const failed = focusProcessingRows.filter((row) => row.state === "failed");
  const done = focusProcessingRows.filter((row) => row.state === "done");
  window.localStorage.setItem(`mdai-focus-processed:${cloud.propertyId}`, "1");
  renderFocusProcessing(100, failed.length
    ? `${failed.length} space${failed.length === 1 ? "" : "s"} could not be interpreted. The evidence is still preserved and can be retried.`
    : "Processing complete.");
  $("#focus-processing-title").textContent = failed.length ? "Partly complete." : "\u2713 Project record is ready";
  $("#focus-processing-copy").textContent = failed.length
    ? "The evidence is organized and preserved. Retry the spaces that failed, or open the results and continue."
    : "The evidence is organized, originals are preserved, and available visual files have been interpreted.";
  const resultsButton = $("#focus-view-results");
  resultsButton.disabled = false;
  resultsButton.textContent = done.length ? "View results" : "Open the record";
  /* The loop closes. A finished reading just fed the installed side of the
     required-vs-installed comparison; the screen that finished it points
     there, instead of leaving the result stranded in this room. */
  const comparisonButton = $("#focus-open-comparison");
  if (comparisonButton) comparisonButton.hidden = done.length === 0;
  $("#focus-process").disabled = false;
  renderFocusStudio();
  document.querySelector('[data-focus-step="upload"]')?.classList.add("complete");
}

/* Test hook: drive the processing-complete state without a paid AI run, so
   the suite can prove what the finished screen offers. */
window.__finishFocusProcessing = (doneCount = 1) => {
  focusProcessingRows = [...Array(doneCount)].map((_, index) => ({
    roomId: `test-${index}`, name: `Room ${index + 1}`, state: "done", detail: "Interpretation ready",
  }));
  finishFocusProcessing();
};

async function processFocusEvidence() {
  const stats = focusEvidenceStats();
  if (!stats.rawFiles) {
    notify("Add evidence before starting the AI review");
    showFocusStage("upload");
    return;
  }
  /* The space a person just uploaded into is the space they are waiting on.
     Reading the oldest unfinished room first is why an upload into a new room
     was answered with the name of a room from weeks ago. */
  const candidates = stats.analyzableRooms
    .filter((room) => !room.analysis)
    .sort((a, b) => roomLastActivity(b) - roomLastActivity(a));
  $("#focus-process").disabled = true;
  closeFocusSheet(false);
  showFocusStage("process");
  resetProcessingStageControls();
  $("#focus-view-results").disabled = true;
  $("#focus-processing-title").textContent = "Processing evidence\u2026";
  $("#focus-processing-copy").textContent = candidates.length > 1
    ? `${candidates.length} spaces still have no interpretation. The one you just added to is read first; the rest follow in the same run.`
    : "Organizing files and building the project record.";
  focusProcessingRows = candidates.map((room) => ({
    roomId: room.id,
    name: room.name,
    state: "queued",
    detail: `${room.evidence.length} file${room.evidence.length === 1 ? "" : "s"} queued`,
  }));
  renderFocusProcessing(8, "Classifying files and preserving originals…");
  await new Promise((resolve) => window.setTimeout(resolve, 180));
  renderFocusProcessing(
    18,
    stats.paired360
      ? `Paired ${stats.paired360} Insta360 capture${stats.paired360 === 1 ? "" : "s"} for the spatial pipeline.`
      : "Evidence organized by type and project context.",
  );

  for (let index = 0; index < candidates.length; index += 1) {
    const room = candidates[index];
    const row = focusProcessingRows[index];
    const base = 18 + Math.round((index / Math.max(1, candidates.length)) * 78);
    row.state = "running";
    row.detail = "Preparing the evidence";
    renderFocusProcessing(base, `Reading ${room.name}…`);
    try {
      await analyzeFocusRoom(room, (message) => {
        row.detail = message;
        renderFocusProcessing(base + 4, message);
      });
      row.state = "done";
      row.detail = room.analysis?.summary
        ? room.analysis.summary.slice(0, 120)
        : "Interpretation ready";
    } catch (error) {
      console.error(error);
      row.state = "failed";
      row.detail = error.message || "The analysis failed";
    }
    renderFocusProcessing(18 + Math.round(((index + 1) / Math.max(1, candidates.length)) * 78), `Reading ${room.name}…`);
  }
  focusProcessingComplete = true;
  finishFocusProcessing();
}

/* -------------------------------------------------------------------- Wiring */

$("#focus-open-comparison")?.addEventListener("click", () => openProjectPlans("visual"));
$("#focus-open-plans")?.addEventListener("click", () => openProjectPlans());
$("#focus-open-files")?.addEventListener("click", openFileList);
$("#focus-files-close")?.addEventListener("click", closeFileList);
$("#focus-files")?.addEventListener("click", (event) => {
  /* Pressing the dimmed area outside the panel closes it, the way every other
     overlay in the Studio behaves. */
  if (event.target === $("#focus-files")) closeFileList();
});
$("#focus-files-search")?.addEventListener("input", (event) => {
  fileList.search = event.target.value || "";
  /* Typing a filter of their own means they have moved on from the finding. */
  fileList.working = null;
  renderFileList();
});
$("#focus-files-dupes")?.addEventListener("change", (event) => {
  fileList.dupesOnly = Boolean(event.target.checked);
  renderFileList();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#focus-files")?.hidden) closeFileList();
});

$("#focus-evidence-files").addEventListener("change", (event) => uploadFocusEvidence(event.target.files));
/* The upload entry, reachable by the test harness. The gate above it is the
   thing that must never rot silently, and a gate nothing can drive is a gate
   nothing can prove. */
window.__uploadFocusEvidence = uploadFocusEvidence;
const focusUploadCard = document.querySelector(".focus-upload-card");
["dragenter", "dragover"].forEach((eventName) => focusUploadCard.addEventListener(eventName, (event) => {
  event.preventDefault();
  focusUploadCard.classList.add("dragging");
}));
["dragleave", "drop"].forEach((eventName) => focusUploadCard.addEventListener(eventName, (event) => {
  event.preventDefault();
  focusUploadCard.classList.remove("dragging");
}));
focusUploadCard.addEventListener("drop", (event) => uploadFocusEvidence(event.dataTransfer.files));
$("#focus-process").addEventListener("click", () => {
  // The room that just received files is the room to read. The picker on the
  // processing stage is there to choose a different one deliberately.
  const room = pickedRoom("upload") || rooms.find((candidate) => candidate.evidence?.length);
  if (!room) {
    notify("Choose a room and add files to it first");
    return;
  }
  analyzeRoomId = room.id;
  runFocusRoomAnalysis(room);
});
$("#focus-view-results").addEventListener("click", () => {
  /* showFocusStage renders. Rendering first was the belt to a brace that no
     longer exists. */
  showFocusStage("results");
});
/* Typing is not a query yet. Waiting a moment after the last keystroke turns a
   word being typed into one question rather than six. */
$("#focus-search-input").addEventListener("input", (event) => {
  const term = event.target.value;
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => runFocusSearch(term), 220);
});
$("#focus-search-input").addEventListener("keydown", (event) => {
  if (event.key === "Escape") { event.target.value = ""; closeFocusSearch(); }
});
/* Clicking anywhere else puts it away. Without this the panel covers the screen
   it was supposed to help somebody read. */
document.addEventListener("click", (event) => {
  const box = $("#focus-search");
  if (box && !box.contains(event.target)) closeFocusSearch();
});
$("#focus-start-machine").addEventListener("click", startCaptureMachine);
$("#focus-blocked-action").addEventListener("click", (event) => {
  const openPicker = event.currentTarget.dataset.openPicker === "1";
  resetProcessingStageControls();
  showFocusStage("upload");
  if (openPicker) $("#focus-evidence-files")?.click();
});
$("#focus-add-more").addEventListener("click", () => showFocusStage("upload"));
$("#focus-open-report").addEventListener("click", openProjectReport);
$("#focus-upload-more").addEventListener("click", () => $("#focus-evidence-files").click());
/* A step that cannot be opened yet still answers when pressed.
   It looks like the steps beside it, and on a phone there is no cursor and no
   hover to tell them apart, so a silent tap reads as a broken button — "кнопка
   никуда не ведёт". Pressing it now says what is missing and goes to the stage
   where that is supplied. */
function stepIsNotReadyYet(step) {
  if (step === "process") {
    return {
      go: "upload",
      say: "The AI review has not run yet. Add evidence to a room, then press Process with AI.",
    };
  }
  if (step === "results") {
    return {
      go: "upload",
      say: "There is nothing to show yet, because no evidence has been added to this project.",
    };
  }
  return null;
}

document.querySelectorAll("[data-focus-step]").forEach((item) => {
  const open = () => {
    const step = item.dataset.focusStep;
    if (!item.classList.contains("reachable")) {
      if (step === focusStage) return;
      const blocked = stepIsNotReadyYet(step);
      if (!blocked) return;
      notify(blocked.say);
      showFocusStage(blocked.go);
      return;
    }
    showFocusStage(step);
  };
  item.addEventListener("click", open);
  item.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  });
});
$("#sheet-back").addEventListener("click", () => closeFocusSheet(true));
$("#analyze-room-run").addEventListener("click", () => {
  const room = pickedRoom("analyze");
  if (room) runFocusRoomAnalysis(room);
});
$("#save-cost").addEventListener("click", saveCostEntry);
$("#save-money-questions").addEventListener("click", saveMoneyQuestions);
$("#cost-dialog").addEventListener("close", () => { costEditor = null; });
$("#sheet-edit-space").addEventListener("click", () => {
  const room = focusSheetRoom();
  if (room) openSpaceEditor(room.id);
});
$("#sheet-confirm").addEventListener("click", async () => {
  const room = focusSheetRoom();
  if (!room) return;
  const reopening = room.status === "confirmed";
  const state = reopening ? "needs_review" : "confirmed";
  const note = $("#sheet-note").value.trim();
  if (!(await persistSuggestionReview(room, state, note))) return;
  if (!(await persistRoomReview(room, state))) return;
  room.status = reopening ? "needs" : "confirmed";
  room.note = note;
  saveRooms(cloud.schemaReady ? "Human review saved to cloud" : "Human review saved");
  renderFocusStudio();
  notify(reopening ? "This space is back in the verification queue" : "Visible record confirmed by human review");
});


function canManageSpaces() {
  return !cloud.schemaReady || ["owner", "admin", "reviewer", "contributor"].includes(cloud.role);
}

function openSpaceEditor(spaceId) {
  if (!canManageSpaces()) return;
  const room = rooms.find((item) => item.id === spaceId);
  if (!room) return;
  editingSpaceId = room.id;
  $("#edit-space-name").value = room.name || "";
  $("#edit-space-building").value = room.building || "";
  $("#edit-space-level").value = room.level || "";
  const removeButton = $("#request-space-delete");
  const hasEvidence = room.evidence.length > 0;
  removeButton.disabled = hasEvidence;
  $("#space-delete-help").textContent = hasEvidence
    ? `Move or delete ${room.evidence.length} source item${room.evidence.length === 1 ? "" : "s"} before removing this space.`
    : "Available because this space has no source material.";
  elements.editSpaceDialog.showModal();
}

document.querySelectorAll("[data-close-space-dialog]").forEach((button) =>
  button.addEventListener("click", () => {
    editingSpaceId = null;
    elements.editSpaceDialog.close();
  }),
);

$("#edit-space-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const room = rooms.find((item) => item.id === editingSpaceId);
  const name = $("#edit-space-name").value.trim();
  const building = $("#edit-space-building").value.trim() || "Property";
  const level = $("#edit-space-level").value.trim() || "Unspecified level";
  if (!room || !name) return;
  const button = $("#save-space-edit");
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    if (cloud.schemaReady && cloud.propertyId) {
      const { data, error } = await cloud.client
        .from("spaces")
        .update({ name, building, level })
        .eq("id", room.id)
        .eq("property_id", cloud.propertyId)
        .select("id");
      if (error) throw error;
      if (!data?.length) throw new Error("Update is not authorized or the space no longer exists");
    }
    room.name = name;
    room.building = building;
    room.level = level;
    jobs.forEach((job) => {
      if (job.roomId === room.id) job.roomName = name;
    });
    saveRooms(cloud.schemaReady ? "Space updated in cloud record" : "Space updated locally");
    elements.editSpaceDialog.close();
    editingSpaceId = null;
    render();
    notify(`${name} updated`);
  } catch (error) {
    notify(`Space was not updated: ${error.message}`, 5000);
  } finally {
    button.disabled = false;
    button.textContent = "Save changes";
  }
});

$("#request-space-delete").addEventListener("click", () => {
  const room = rooms.find((item) => item.id === editingSpaceId);
  if (!room || room.evidence.length) return;
  deletingSpaceId = room.id;
  $("#delete-space-name").textContent = room.name;
  elements.editSpaceDialog.close();
  elements.deleteSpaceDialog.showModal();
});

$("#confirm-space-delete").addEventListener("click", async () => {
  const room = rooms.find((item) => item.id === deletingSpaceId);
  if (!room || room.evidence.length) return;
  const button = $("#confirm-space-delete");
  button.disabled = true;
  button.textContent = "Removing…";
  try {
    if (cloud.schemaReady && cloud.propertyId) {
      const { data, error } = await cloud.client
        .from("spaces")
        .delete()
        .eq("id", room.id)
        .eq("property_id", cloud.propertyId)
        .select("id");
      if (error) throw error;
      if (!data?.length) throw new Error("Removal is not authorized or the space no longer exists");
    }
    rooms = rooms.filter((item) => item.id !== room.id);
    jobs = jobs.filter((job) => job.roomId !== room.id);
    if (activeRoomId === room.id) {
      activeRoomId = rooms[0]?.id || null;
      activeEvidenceId = rooms[0]?.evidence[0]?.id || null;
    }
    saveRooms(cloud.schemaReady ? "Space removed from cloud record" : "Space removed locally");
    saveJobs();
    elements.deleteSpaceDialog.close();
    deletingSpaceId = null;
    editingSpaceId = null;
    render();
    notify(`${room.name} removed`);
  } catch (error) {
    notify(`Space was not removed: ${error.message}`, 5000);
  } finally {
    button.disabled = false;
    button.textContent = "Remove space";
  }
});

elements.deleteSpaceDialog.addEventListener("close", () => {
  deletingSpaceId = null;
});

$("#add-room").addEventListener("click", () => elements.roomDialog.showModal());
$("#save-room").addEventListener("click", async (event) => {
  event.preventDefault();
  const name = $("#new-room-name").value.trim();
  if (!name) return;
  const building = $("#new-room-building").value;
  const level = $("#new-room-level").value;
  let room;
  try {
    room = await createRoomRecord({ name, building, level });
  } catch (error) {
    notify(`Room was not added: ${error.message}`);
    return;
  }
  activeRoomId = room.id;
  saveRooms(cloud.schemaReady ? "Room added to cloud record" : "Room added locally");
  render();
  $("#room-form").reset();
  elements.roomDialog.close();
  notify(`${name} added to the ${cloud.schemaReady ? "private cloud" : "local"} record`);
});

function findEvidenceLocation(evidenceId) {
  for (const room of rooms) {
    const index = room.evidence.findIndex((item) => item.id === evidenceId);
    if (index !== -1) return { room, index, evidence: room.evidence[index] };
  }
  return null;
}

function canDeleteEvidence() {
  return !cloud.schemaReady || ["owner", "admin"].includes(cloud.role);
}

function openEvidenceDelete(evidenceId) {
  const location = findEvidenceLocation(evidenceId);
  if (!location || !canDeleteEvidence()) return;
  deletingEvidenceId = evidenceId;
  $("#delete-evidence-name").textContent = location.evidence.name;
  elements.deleteEvidenceDialog.showModal();
}

async function removeEvidenceRecord(location) {
  const evidence = location.evidence;
  let storageCleanupFailed = false;
  /* A dual-lens capture is two files behind one tile. Deleting only the first
     of them left the second on record, the tile rebuilt itself from what
     remained, and the screen looked like the button had done nothing. */
  const targetIds = (evidence.sourceIds || []).length ? [...evidence.sourceIds] : [evidence.id];
  if (cloud.schemaReady && cloud.propertyId) {
    if (evidence.storageProvider === "aws-s3") {
      if (!window.MDAIObjectStorage) throw new Error("The secure S3 service is unavailable. Reload and retry.");
      for (const id of targetIds) {
        await window.MDAIObjectStorage.deleteEvidence(cloud.client, id);
      }
    } else {
      /* Marked deleted, not destroyed — the same rule the S3 path follows. The
         stored object stays where it is; an owner can bring the file back, and
         anything derived from it still has a parent to point at.

         Through an RPC rather than a plain update, because the read policy hides
         deleted rows: an update that sets deleted_at makes the row invisible to
         its own author, and Postgres refuses that outright. The RPC checks the
         caller is an owner or admin and writes the audit entry. */
      let removed = 0;
      for (const id of targetIds) {
        const { error: databaseError } = await cloud.client.rpc("soft_delete_evidence", {
          p_evidence_id: id,
          p_reason: null,
        });
        if (databaseError) throw new Error(databaseError.message || "Deletion is not authorized");
        removed += 1;
      }
      if (!removed) throw new Error("Deletion is not authorized or the evidence no longer exists");
    }
  } else {
    for (const ref of (evidence.fileRefs || [evidence.fileRef]).filter(Boolean)) {
      await deleteStoredEvidenceFile(ref);
    }
  }

  if (evidence.src?.startsWith("blob:")) {
    URL.revokeObjectURL(evidence.src);
    objectUrls = objectUrls.filter((url) => url !== evidence.src);
  }
  location.room.evidence.splice(location.index, 1);
  location.room.status = "needs";
  location.room.analysis = null;
  location.room.suggestionId = null;
  location.room.visible = [];
  location.room.unknown = location.room.evidence.length
    ? ["Uploaded material has not been analyzed", "No factual observations have been confirmed"]
    : ["Evidence has not been uploaded or reviewed"];
  activeEvidenceId = location.room.evidence[0]?.id || null;
  return { storageCleanupFailed };
}

$("#delete-selected-evidence").addEventListener("click", () => {
  if (activeEvidenceId) openEvidenceDelete(activeEvidenceId);
});

$("#confirm-evidence-delete").addEventListener("click", async () => {
  const location = findEvidenceLocation(deletingEvidenceId);
  if (!location) return;
  const button = $("#confirm-evidence-delete");
  const filename = location.evidence.name;
  button.disabled = true;
  button.textContent = "Deleting…";
  try {
    const result = await removeEvidenceRecord(location);
    saveRooms(cloud.schemaReady ? "Evidence deleted from cloud record" : "Evidence deleted locally");
    render();
    // The deletion can be made from the space sheet: every surface that lists
    // the file has to stop listing it, not just the admin inventory.
    renderFocusStudio();
    elements.deleteEvidenceDialog.close();
    deletingEvidenceId = null;
    /* "Deleted permanently" was accurate before this and is not any more, which
       is the point: a person who deletes the wrong file should be told it can
       come back, not told it is gone forever. */
    notify(
      result.storageCleanupFailed
        ? `${filename} removed from the record; storage cleanup requires attention`
        : cloud.schemaReady
          ? `${filename} removed from the record. The original is kept — an owner can restore it.`
          : `${filename} deleted from this device`,
    );
  } catch (error) {
    console.error(error);
    notify(`Evidence was not deleted: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = "Remove from the record";
  }
});

function openEvidenceEditor(evidenceId) {
  const location = findEvidenceLocation(evidenceId);
  if (!location) return;
  editingEvidenceId = evidenceId;
  $("#edit-evidence-name").textContent = location.evidence.name;
  elements.editEvidenceRoom.innerHTML = roomOptions(location.room.id, true);
  $("#edit-evidence-type").value = location.evidence.type || "Room capture";
  $("#edit-evidence-subject").value = location.evidence.subject || "";
  $("#edit-evidence-context").value = location.evidence.context || "";
  $("#edit-new-room-fields").hidden = true;
  $("#edit-new-room-name").value = "";
  elements.editEvidenceDialog.showModal();
}

elements.editEvidenceRoom.addEventListener("change", () => {
  const creatingRoom = elements.editEvidenceRoom.value === "__new__";
  $("#edit-new-room-fields").hidden = !creatingRoom;
  if (creatingRoom) $("#edit-new-room-name").focus();
});

$("#save-evidence-edit").addEventListener("click", async (event) => {
  event.preventDefault();
  const location = findEvidenceLocation(editingEvidenceId);
  if (!location) return;
  const button = $("#save-evidence-edit");
  button.disabled = true;
  button.textContent = "Saving…";

  let targetRoom = rooms.find(
    (room) => room.id === elements.editEvidenceRoom.value,
  );
  try {
    if (elements.editEvidenceRoom.value === "__new__") {
      const name = $("#edit-new-room-name").value.trim();
      if (!name) {
        notify("Enter the new room name");
        $("#edit-new-room-name").focus();
        return;
      }
      targetRoom = await createRoomRecord({
        name,
        building: $("#edit-new-room-building").value,
        level: $("#edit-new-room-level").value,
      });
    }
    if (!targetRoom) throw new Error("Select a destination room");

    const evidenceType = $("#edit-evidence-type").value;
    const subject = $("#edit-evidence-subject").value.trim();
    const context = $("#edit-evidence-context").value.trim();
    const sourceMetadata = {
      ...(location.evidence.sourceMetadata || {}),
      subject: subject || null,
      context: context || null,
    };
    if (cloud.schemaReady && cloud.propertyId) {
      const { error } = await cloud.client
        .from("evidence_items")
        .update({
          space_id: targetRoom.id,
          media_type: evidenceType,
          source_metadata: sourceMetadata,
        })
        .eq("id", location.evidence.id)
        .eq("property_id", cloud.propertyId);
      if (error) throw error;
    }

    const [evidence] = location.room.evidence.splice(location.index, 1);
    evidence.type = evidenceType;
    evidence.subject = subject;
    evidence.context = context;
    evidence.sourceMetadata = sourceMetadata;
    targetRoom.evidence.push(evidence);
    location.room.analysis = null;
    location.room.suggestionId = null;
    location.room.visible = [];
    location.room.status = "needs";
    targetRoom.status = "needs";
    targetRoom.analysis = null;
    targetRoom.suggestionId = null;
    targetRoom.visible = [];
    targetRoom.unknown = [
      "Uploaded material has not been analyzed",
      "No factual observations have been confirmed",
    ];
    activeRoomId = targetRoom.id;
    saveRooms(cloud.schemaReady ? "Evidence assignment updated" : "Assignment updated locally");
    render();
    elements.editEvidenceDialog.close();
    editingEvidenceId = null;
    notify(`${evidence.name} moved to ${targetRoom.name}`);
  } catch (error) {
    console.error(error);
    notify(`Assignment was not changed: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = "Save changes";
  }
});

function beginUploadFiles(files) {
  pendingFiles = [...files];
  if (!pendingFiles.length) return;
  $("#upload-summary").innerHTML =
    `<strong>${pendingFiles.length} file${pendingFiles.length === 1 ? "" : "s"} selected</strong><br>${pendingFiles
      .map((file) => `${escapeText(file.name)} · ${formatFileSize(file.size)}`)
      .join("<br>")}`;
  renderUploadRooms();
  elements.uploadDialog.showModal();
}
function beginUpload(input) {
  beginUploadFiles(input.files);
}
elements.fileUpload.addEventListener("change", () =>
  beginUpload(elements.fileUpload),
);
elements.intakeUpload.addEventListener("change", () =>
  beginUpload(elements.intakeUpload),
);
const dropZone = $("#drop-zone");
["dragenter", "dragover"].forEach((eventName) =>
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("dragging");
  }),
);
["dragleave", "drop"].forEach((eventName) =>
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
  }),
);
dropZone.addEventListener("drop", (event) =>
  beginUploadFiles(event.dataTransfer.files),
);

$("#save-upload").addEventListener("click", async (event) => {
  event.preventDefault();
  const room = rooms.find((item) => item.id === elements.uploadRoom.value);
  if (!room) return;
  const type = $("#upload-type").value;
  const metadata = {
    subject: $("#upload-subject").value.trim(),
    context: $("#upload-context").value.trim(),
  };
  if (!metadata.subject) {
    notify("Describe what the uploaded material shows");
    $("#upload-subject").focus();
    return;
  }
  const button = $("#save-upload");
  button.disabled = true;
  button.textContent = cloud.schemaReady ? "Uploading securely…" : "Saving locally…";
  try {
    for (const file of pendingFiles) {
      if (cloud.schemaReady && cloud.propertyId) {
        room.evidence.push(
          await uploadEvidenceToCloud(file, room, type, metadata, (progress) => {
            button.textContent = progress.stage === "finalizing"
              ? `Finalizing ${file.name}…`
              : `Uploading ${file.name} · ${progress.percent}% · ${progress.label}`;
          }),
        );
      } else {
        const id = `${Date.now()}-${Math.random()}`;
        await storeEvidenceFile(id, file);
        const src = URL.createObjectURL(file);
        objectUrls.push(src);
        room.evidence.push({
          id,
          fileRef: id,
          src,
          name: file.name,
          type,
          mimeType: file.type || "application/octet-stream",
          date: formatEvidenceDate(new Date().toISOString()),
          status: "Stored in browser · Awaiting analysis",
          subject: metadata.subject,
          context: metadata.context,
          sourceMetadata: metadata,
        });
      }
    }
  } catch (uploadError) {
    console.error(uploadError);
    const message = uploadError.message || "Cloud storage error";
    $("#upload-summary").innerHTML =
      `<strong>Upload failed</strong><br>${escapeText(message)}`;
    notify(`Upload failed: ${message}`, 12000);
    button.disabled = false;
    button.textContent = "Retry upload";
    return;
  }
  room.status = "needs";
  room.analysis = null;
  room.suggestionId = null;
  room.visible = [];
  room.unknown = [
    "Uploaded material has not been analyzed",
    "No factual observations have been confirmed",
  ];
  activeRoomId = room.id;
  saveRooms(cloud.schemaReady ? "Evidence secured in cloud" : "Evidence added locally");
  render();
  pendingFiles = [];
  elements.fileUpload.value = "";
  elements.intakeUpload.value = "";
  $("#upload-subject").value = "";
  $("#upload-context").value = "";
  elements.uploadDialog.close();
  button.disabled = false;
  button.textContent = "Save evidence";
  notify(
    cloud.schemaReady
      ? "Evidence uploaded to private Supabase Storage"
      : "Evidence saved locally and assigned to the room",
  );
});

elements.note.addEventListener("input", () => {
  currentRoom().note = elements.note.value;
  saveRooms("Saving…");
});
async function persistRoomReview(room, reviewState) {
  if (!cloud.schemaReady || !cloud.propertyId) return true;
  const { error } = await cloud.client
    .from("spaces")
    .update({ review_state: reviewState })
    .eq("id", room.id)
    .eq("property_id", cloud.propertyId);
  if (error) {
    notify(`Review was not saved: ${error.message}`);
    return false;
  }
  return true;
}

async function persistSuggestionReview(room, reviewState, note = elements.note.value) {
  if (
    !cloud.schemaReady ||
    !cloud.propertyId ||
    !room.suggestionId
  ) {
    return true;
  }
  const { error } = await cloud.client.from("suggestion_reviews").upsert(
    {
      organization_id: cloud.organizationId,
      suggestion_id: room.suggestionId,
      state: reviewState,
      reviewer_note: String(note || "").trim() || null,
      reviewed_by: cloud.session.user.id,
      reviewed_at: new Date().toISOString(),
    },
    { onConflict: "suggestion_id" },
  );
  if (error) {
    notify(`AI review was not saved: ${error.message}`);
    return false;
  }
  return true;
}

$("#confirm-record").addEventListener("click", async () => {
  const room = currentRoom();
  if (!(await persistSuggestionReview(room, "confirmed"))) return;
  if (!(await persistRoomReview(room, "confirmed"))) return;
  room.status = "confirmed";
  room.note = elements.note.value;
  saveRooms(cloud.schemaReady ? "Human review saved to cloud" : "Human review saved");
  render();
  notify("Visible record confirmed by human review");
});
$("#flag-record").addEventListener("click", async () => {
  const room = currentRoom();
  if (!(await persistSuggestionReview(room, "needs_review"))) return;
  if (!(await persistRoomReview(room, "needs_review"))) return;
  room.status = "needs";
  saveRooms("Verification flag saved");
  render();
  notify("Room remains in the verification queue");
});
$("#request-analysis").addEventListener("click", async () => {
  const room = currentRoom();
  const button = $("#request-analysis");
  if (!room.evidence.length) {
    notify("Add evidence before requesting interpretation");
    return;
  }
  if (!cloud.schemaReady || !cloud.propertyId) {
    notify("Secure Supabase connection is required for AI analysis");
    return;
  }
  if (analysisRoomsInFlight.has(room.id)) {
    activateView("processing");
    notify("This room is already being analyzed");
    return;
  }
  const processingJob = jobs.find(
    (job) =>
      job.roomId === room.id &&
      ["Analyzing evidence", "Preparing video frames"].includes(job.status),
  );
  if (processingJob) {
    activateView("processing");
    notify("This room is already being analyzed");
    return;
  }

  analysisRoomsInFlight.add(room.id);
  button.disabled = true;
  const queuedJob = jobs.find(
    (job) => job.roomId === room.id && job.status === "Queued for AI",
  );
  let jobId = queuedJob?.id || "";
  let localJob = queuedJob;
  try {
    if (!jobId) {
    const evidenceIds = room.evidence
      .filter((item) => item.storagePath)
      .map((item) => item.id);
    if (!evidenceIds.length) {
      notify("Re-upload this browser-only evidence to secure cloud storage first");
      throw new Error("Cloud evidence is required");
    }
    const { data, error } = await cloud.client
      .from("analysis_jobs")
      .insert({
        organization_id: cloud.organizationId,
        property_id: cloud.propertyId,
        space_id: room.id,
        state: "queued",
        profile: "property-evidence-conservative",
        profile_version: "0.1",
        evidence_ids: evidenceIds,
        requested_by: cloud.session.user.id,
      })
      .select("id")
      .single();
    if (error) {
      throw new Error(`Processing request failed: ${error.message}`);
    }
    jobId = data.id;
      localJob = {
        id: jobId,
        roomId: room.id,
        roomName: room.name,
        evidenceCount: room.evidence.length,
        profile: "Property evidence · conservative",
        status: "Queued for AI",
        createdAt: new Date().toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }),
      };
      jobs.unshift(localJob);
    }

    localJob.status = room.evidence.some(isVideo)
      ? "Preparing video frames"
      : "Analyzing evidence";
    saveJobs();
    activateView("processing");
    notify(
      room.evidence.some(isVideo)
        ? "Preparing representative video frames for analysis"
        : "Secure AI analysis started",
    );

    const prepared = await prepareVideoFrames(room);
    const { frames, warnings } = prepared;
    const blocked = nothingToAnalyse(room.evidence, room.name, prepared);
    if (blocked) throw new Error(blocked);
    localJob.status = "Analyzing evidence";
    saveJobs();
    const { data, error } = await cloud.client.functions.invoke(
      config.aiFunctionName,
      {
        body: {
          job_id: jobId,
          video_frames: frames,
        },
      },
    );
    if (error) throw await functionInvocationError(error);
    if (!data?.analysis) throw new Error(data?.error || "AI returned no result");

    localJob.status = "Completed";
    applyAnalysisResult(room, data.analysis, data.suggestion_id);
    saveRooms("AI suggestion saved · Human verification required");
    saveJobs();
    activateView("property");
    render();
    notify(
      warnings.length
        ? `AI suggestion ready; ${warnings.length} video could not be sampled — the comparison in Plan Intelligence has been updated`
        : `AI suggestion ready from ${data.analyzed_images || 0} images and ${data.analyzed_video_frames || 0} video frames — the comparison in Plan Intelligence has been updated`,
      6000,
    );
  } catch (error) {
    if (localJob) {
      localJob.status = "Failed";
      saveJobs();
    }
    console.error(error);
    notify(error.message || "AI analysis failed", 5000);
  } finally {
    analysisRoomsInFlight.delete(room.id);
    button.disabled = false;
  }
});
$("#connector-status").addEventListener("click", () =>
  $("#connector-dialog").showModal(),
);
$("#open-connector").addEventListener("click", () =>
  $("#connector-dialog").showModal(),
);
$("#expand-image").addEventListener("click", () => {
  if (!elements.image.src) return;
  elements.lightbox.querySelector("img").src = elements.image.src;
  elements.lightbox.hidden = false;
});
elements.lightbox
  .querySelector("button")
  .addEventListener("click", () => (elements.lightbox.hidden = true));
elements.lightbox.addEventListener("click", (event) => {
  if (event.target === elements.lightbox) elements.lightbox.hidden = true;
});

$("#export-record").addEventListener("click", () => {
  const exportData = {
    property: propertyRecord,
    exportedAt: new Date().toISOString(),
    rooms: rooms.map((room) => ({
      ...room,
      evidence: room.evidence.map(({ src, ...item }) => item),
    })),
  };
  const blob = new Blob([JSON.stringify(exportData, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "private-property-record.json";
  link.click();
  URL.revokeObjectURL(url);
  notify("Property record exported");
});

$("#owner-invite-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = $("#owner-invite-email").value.trim();
  if (!email || !cloud.client || !cloud.propertyId) return;
  const { error } = await cloud.client.rpc("invite_owner_viewer", {
    p_property_id: cloud.propertyId, p_email: email,
  });
  if (error) { notify(error.message || "The invitation could not be created"); return; }
  $("#owner-invite-email").value = "";
  notify(`${email} invited. They sign in at /studio/owner-view/ with a link emailed to that address.`);
  void renderOwnerViewAccess();
});

$("#build-vision-release").addEventListener("click", async () => {
  const button = $("#build-vision-release");
  button.disabled = true;
  button.textContent = "Building governed release…";
  try {
    const data = await invokeVisionRelease({ action: "build", property_id: cloud.propertyId });
    visionRelease = normalizedVisionRelease(data.release);
    renderVisionReleaseStatus();
    notify(
      visionRelease.blockers.length
        ? `Draft v${visionRelease.version} built with ${visionRelease.blockers.length} blocker${visionRelease.blockers.length === 1 ? "" : "s"}`
        : `Draft v${visionRelease.version} is ready for approval`,
      5000,
    );
  } catch (error) {
    notify(error.message || "Vision release could not be built", 5000);
  } finally {
    button.textContent = "Build governed release →";
    button.disabled = !["owner", "admin", "reviewer"].includes(cloud.role);
  }
});

$("#approve-vision-release").addEventListener("click", async () => {
  if (!visionRelease || visionRelease.blockers.length) return;
  const button = $("#approve-vision-release");
  button.disabled = true;
  button.textContent = "Approving…";
  try {
    await invokeVisionRelease({
      action: "approve",
      property_id: cloud.propertyId,
      release_id: visionRelease.id,
    });
    await refreshVisionReleaseStatus();
    notify(`Vision release v${visionRelease.version} approved`);
  } catch (error) {
    notify(error.message || "Vision release could not be approved", 5000);
  } finally {
    button.textContent = "Approve release";
    button.disabled = false;
  }
});

$("#export-vision-manifest").addEventListener("click", () => {
  const manifest = {
    schema: "com.measureddecision.spatial-record/0.1",
    packageType: "visionos-release-manifest",
    status: "local-draft-not-governed",
    property: propertyRecord,
    generatedAt: new Date().toISOString(),
    governance: {
      originalsPreserved: true,
      aiOutputsAreSuggestions: true,
      humanReviewRequired: true,
    },
    spaces: rooms.map((room) => ({
      id: room.id,
      name: room.name,
      building: room.building,
      level: room.level,
      reviewStatus: room.status,
      reviewerNote: room.note || null,
      evidence: room.evidence.map(({ src, fileRef, ...item }) => ({
        ...item,
        localFileReference: fileRef || null,
        deliveryUrl: null,
      })),
    })),
    blockers: [
      ...(cloud.schemaReady &&
      rooms.every((room) => room.evidence.every((item) => item.storagePath))
        ? []
        : ["private_storage_not_connected"]),
      "local_draft_requires_governed_release",
    ],
  };
  downloadJson(manifest, "private-property-vision-manifest-v0.1.json");
  notify("Draft Vision manifest exported");
});

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

window.addEventListener("beforeunload", () =>
  objectUrls.forEach(URL.revokeObjectURL),
);

initializeAuth();



/* Day and night are one studio: the palette swaps, the record does not.
   The choice is shared with the landing site through the same storage key,
   and the pre-paint script in <head> applies it before the first frame. */
{
  const themeToggle = document.querySelector("#theme-toggle");
  const reflectTheme = () => {
    if (themeToggle) themeToggle.textContent = document.documentElement.dataset.theme === "light" ? "\u2600 Day" : "\u263e Night";
  };
  themeToggle?.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try { window.localStorage.setItem("mdai-theme", next); } catch (_) { /* private browsing: the choice lasts the visit */ }
    reflectTheme();
  });
  reflectTheme();
}
