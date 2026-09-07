const config = window.MDAI_CONFIG || {};
const $ = (selector) => document.querySelector(selector);
const AI_INPUT_LIMIT_BYTES = 49 * 1024 * 1024;
const ANALYZABLE_DOCUMENT_STATUSES = new Set(["uploaded", "ready", "failed"]);

const client = window.supabase?.createClient && config.supabaseUrl && config.supabasePublishableKey
  ? window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

const state = {
  session: null,
  organizationId: null,
  role: null,
  properties: [],
  property: null,
  documents: [],
  baseline: null,
  phases: [],
  planSpaces: [],
  spaceLinks: [],
  approvedTakeoff: null,
  takeoffReviews: [],
  projectRooms: [],
  projectEvidence: [],
  reconciliations: [],
  rebuildOffer: null,
  requirements: [],
  tasks: [],
  assignments: [],
  qualityChecks: [],
  selectedRequirementId: null,
  requestedBaselineId: new URLSearchParams(window.location.search).get("baseline"),
  baselines: [],
  /* Which readers this project can use, and which one the next reading will
     be bought from. The catalogue says only whether each provider has a key
     — the key itself never reaches this page. */
  providers: [],
  reader: { provider: null, model: null },
  /* The comparison of several readings of one plan set. Held separately from
     the readings themselves, because a comparison is a finding about readers
     and never becomes the project's baseline. */
  comparison: null,
  comparisonBusy: false,
  activeBaseline: null,
  readingRegister: null,
  readingWeakSpots: null,
  generatedFieldLink: null,
  pendingFiles: [],
  selectedDocumentIds: new Set(),
  busy: false,
  analysisStartedAt: null,
  analysisProgressTimer: null,
  analysisProgress: 0,
  analysisStage: 0,
  activeAnalysisJob: null,
  analysisServerReported: false,
  analysisDetail: "",
  analysisPolling: false,
  analysisOutcome: null,
};

const elements = {
  boot: $("#boot-screen"),
  app: $("#app"),
  propertySelect: $("#property-select"),
  workflowBadge: $("#workflow-badge"),
  sync: $("#sync-status"),
  fileInput: $("#plan-files"),
  uploadFields: $("#upload-fields"),
  selectedFiles: $("#selected-files"),
  documentList: $("#document-list"),
  documentEmpty: $("#document-empty"),
  analyze: $("#analyze-plans"),
  freshness: $("#analysis-freshness"),
  freshnessState: $("#freshness-state"),
  viewResults: $("#view-results"),
  reanalyze: $("#reanalyze-plans"),
  rebuildBlock: $("#rebuild-offer"),
  rebuildNote: $("#rebuild-note"),
  rebuildButton: $("#rebuild-baseline"),
  aiUsageLine: $("#ai-usage-line"),
  message: $("#action-message"),
  analysisProgress: $("#analysis-progress"),
  analysisProgressStatus: $("#analysis-progress-status"),
  analysisProgressTrack: $("#analysis-progress-track"),
  analysisProgressFill: $("#analysis-progress-fill"),
  analysisProgressValue: $("#analysis-progress-value"),
  analysisStageTitle: $("#analysis-stage-title"),
  analysisStageDetail: $("#analysis-stage-detail"),
  analysisElapsed: $("#analysis-elapsed"),
  baselineSection: $("#baseline-section"),
  registerSection: $("#register-section"),
  roadmapSection: $("#roadmap-section"),
  phaseList: $("#phase-list"),
  toast: $("#toast"),
};

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function display(value, fallback = "Not stated") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function label(value = "") {
  /* "Waived" is our word, not a builder's, and on its own it does not say what
     happened. The status a person reads has to carry the meaning. */
  if (value === "waived") return "Accepted as missing";
  return String(value).replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function notify(message, kind = "success") {
  const notificationKey = `${kind}:${message}`;
  const now = Date.now();
  if (notify.lastKey === notificationKey && now - (notify.lastAt || 0) < 8000) return;
  notify.lastKey = notificationKey;
  notify.lastAt = now;
  elements.toast.textContent = message;
  elements.toast.className = `toast show ${kind === "error" ? "error" : ""}`;
  window.clearTimeout(notify.timer);
  notify.timer = window.setTimeout(() => elements.toast.classList.remove("show"), 5000);
}

async function functionInvocationError(error, fallback = "Secure server worker failed") {
  let message = error?.message || fallback;
  const response = error?.context;
  if (!response || typeof response.json !== "function") return new Error(message);
  try {
    const payload = await (typeof response.clone === "function" ? response.clone() : response).json();
    if (payload?.error) message = payload.error;
    const code = payload?.code ? ` (${payload.code})` : "";
    return new Error(`${message}${code}`);
  } catch {
    return new Error(message);
  }
}

function setMessage(message = "", kind = "") {
  elements.message.textContent = message;
  elements.message.className = `action-message ${kind}`;
}

const analysisStages = [
  { title: "Securing source documents", detail: "Validating access and preparing private plan files." },
  { title: "Reading sheets and references", detail: "Extracting drawing content, sheet names, notes, and cross-references." },
  { title: "Mapping spaces and systems", detail: "Connecting levels, rooms, disciplines, and construction systems." },
  { title: "Building the capture roadmap", detail: "Creating evidence gates and exact field capture instructions." },
  { title: "Preparing human review", detail: "Checking gaps and assembling the governed project baseline." },
];

function progressSnapshot(elapsedSeconds) {
  if (elapsedSeconds < 5) return { percent: 4 + (elapsedSeconds / 5) * 10, stage: 0 };
  if (elapsedSeconds < 30) return { percent: 14 + ((elapsedSeconds - 5) / 25) * 22, stage: 1 };
  if (elapsedSeconds < 70) return { percent: 36 + ((elapsedSeconds - 30) / 40) * 22, stage: 2 };
  if (elapsedSeconds < 120) return { percent: 58 + ((elapsedSeconds - 70) / 50) * 20, stage: 3 };
  return { percent: 78 + (1 - Math.exp(-(elapsedSeconds - 120) / 90)) * 14, stage: 4 };
}

function formatElapsed(elapsedSeconds) {
  const total = Math.max(0, Math.floor(elapsedSeconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function renderAnalysisProgress(percent, stageIndex, options = {}) {
  const bounded = Math.max(0, Math.min(100, Math.round(percent)));
  const boundedStage = Math.max(0, Math.min(analysisStages.length - 1, stageIndex));
  const stage = analysisStages[boundedStage];
  state.analysisProgress = bounded;
  state.analysisStage = boundedStage;
  elements.analysisProgress.hidden = false;
  elements.analysisProgress.classList.toggle("success", Boolean(options.success));
  elements.analysisProgress.classList.toggle("failed", Boolean(options.failed));
  elements.analysisProgressStatus.textContent = options.success
    ? "Analysis complete"
    : options.failed
      ? "Analysis stopped"
      : "Analysis in progress";
  elements.analysisProgressValue.textContent = options.success ? (options.valueLabel || "Saved") : `${bounded}%`;
  elements.analysisProgressFill.style.width = `${bounded}%`;
  elements.analysisProgressTrack.setAttribute("aria-valuenow", String(bounded));
  elements.analysisStageTitle.textContent = options.title || stage.title;
  elements.analysisStageDetail.textContent = options.detail || state.analysisDetail || stage.detail;
  if (options.detail) state.analysisDetail = options.detail;
  elements.analysisElapsed.textContent = options.elapsedLabel || (state.analysisStartedAt
    ? formatElapsed((Date.now() - state.analysisStartedAt) / 1000)
    : "Saved");
  elements.analysisProgress.querySelectorAll("[data-analysis-step]").forEach((item, index) => {
    item.classList.toggle("done", options.success || index < stageIndex);
    item.classList.toggle("active", !options.success && !options.failed && index === stageIndex);
  });
  elements.sync.textContent = options.success
    ? "Plan analysis complete"
    : options.failed
      ? "Plan analysis stopped"
      : `AI analysis · ${bounded}% estimated`;
}

/* The clock is a stand-in, used only until the job itself reports. A meter that
   keeps climbing on a timer after the server has given a real number is not
   progress, it is an animation, and this product does not show invented
   progress. Once a real report arrives the clock stops and the job drives the
   meter. */
function updateAnalysisProgress() {
  /* Once the job itself has reported, the clock keeps the elapsed time honest
     but is not allowed to move the meter. */
  if (state.analysisServerReported) {
    renderAnalysisProgress(state.analysisProgress, state.analysisStage);
    return;
  }
  const elapsedSeconds = (Date.now() - state.analysisStartedAt) / 1000;
  const snapshot = progressSnapshot(elapsedSeconds);
  renderAnalysisProgress(Math.max(state.analysisProgress, snapshot.percent), Math.max(state.analysisStage, snapshot.stage));
}

/* `from` is the job as the record already knows it. Reopening a page while a
   job is running used to restart the meter at zero and climb again on the
   clock: a job the server had at 60% showed 6%, and the number a person was
   watching went backwards. Whatever the job last reported is where the meter
   starts. */
function startAnalysisProgress(from = null) {
  window.clearInterval(state.analysisProgressTimer);
  /* A job that has been running for six minutes says so. Reopening the page
     used to reset the elapsed clock to 0:00 as well as the meter. */
  const began = Date.parse(from?.started_at || from?.created_at || "");
  state.analysisStartedAt = Number.isFinite(began) ? began : Date.now();
  const reported = Number(from?.progress_percent);
  state.analysisServerReported = Number.isFinite(reported) && reported > 0;
  state.analysisProgress = state.analysisServerReported ? Math.min(100, reported) : 0;
  state.analysisStage = from?.progress_stage ? analysisStageIndex(from.progress_stage) : 0;
  state.analysisOutcome = null;
  state.analysisDetail = "";
  elements.analysisProgress.className = "analysis-progress";
  if (state.analysisServerReported) {
    renderAnalysisProgress(state.analysisProgress, state.analysisStage, { detail: serverProgressDetail(from?.progress_stage) });
  } else {
    updateAnalysisProgress();
  }
  state.analysisProgressTimer = window.setInterval(updateAnalysisProgress, 500);
}

function finishAnalysisProgress(success, detail = "") {
  window.clearInterval(state.analysisProgressTimer);
  state.analysisProgressTimer = null;
  state.analysisOutcome = success ? "success" : "failed";
  if (success) {
    renderAnalysisProgress(100, analysisStages.length - 1, {
      success: true,
      title: "Analysis complete · Review required",
      detail: detail || "The roadmap was saved and is ready for human approval.",
    });
    return;
  }
  renderAnalysisProgress(state.analysisProgress, analysisStages.length - 1, {
    failed: true,
    title: "Analysis stopped",
    detail: detail || "The plan set was preserved. Review the error and try again.",
  });
}

function analysisStageIndex(stage = "") {
  return {
    queued: 0,
    securing_sources: 0,
    provider_queued: 1,
    reading_documents: 2,
    legacy_processing: 3,
    finalizing: 4,
    completed: 4,
  }[stage] ?? 1;
}

function serverProgressDetail(stage = "") {
  return {
    queued: "The job is saved and waiting for the secure worker.",
    securing_sources: "Validating access and preparing private plan files.",
    provider_queued: "The plan set is securely queued for AI interpretation.",
    reading_documents: "AI is reading sheets, notes, and cross-references in the background.",
    legacy_processing: "Studio is checking the prior analysis and any baseline already saved.",
    finalizing: "The roadmap is ready; Studio is saving phases, tasks, and source references.",
  }[stage] || "The analysis continues in the background. You may leave this page and return later.";
}

function applyServerAnalysisProgress(job) {
  if (Number.isFinite(Number(job?.progress_percent))) state.analysisServerReported = true;
  const stage = job?.progress_stage || "reading_documents";
  const percent = Math.max(state.analysisProgress, Number(job?.progress_percent) || 0);
  renderAnalysisProgress(percent, Math.max(state.analysisStage, analysisStageIndex(stage)), { detail: serverProgressDetail(stage) });
}

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function shortDate(value) {
  if (!value) return "Not stated";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function taskForRequirement(requirementId) {
  return state.tasks.find((task) => task.requirement_id === requirementId) || { status: "blocked" };
}

function latestAssignmentForTask(taskId) {
  return state.assignments.find((assignment) => assignment.capture_task_id === taskId) || null;
}

function planSpace(planSpaceId) {
  return state.planSpaces.find((space) => space.id === planSpaceId) || null;
}

function phaseForRequirement(requirement) {
  return state.phases.find((phase) => phase.id === requirement.phase_id) || null;
}

function canUploadPlans() {
  return ["owner", "admin", "contributor"].includes(state.role);
}

function canAnalyzePlans() {
  return ["owner", "admin", "reviewer", "contributor"].includes(state.role);
}

function canApproveBaseline() {
  return ["owner", "admin", "reviewer"].includes(state.role);
}

/* Accepting a gap is the same authority as approving the roadmap it came from,
   plus the project manager who actually knows why the work has no evidence. */
function canWaiveCapture() {
  return ["owner", "admin", "reviewer", "project_manager"].includes(state.role);
}

/* Confirming how the building is put together is the same authority as
   approving the roadmap, plus the project manager who has actually walked it. */
function canConfirmRoutes() {
  return ["owner", "admin", "reviewer", "project_manager"].includes(state.role);
}

function canDeletePlans() {
  return ["owner", "admin"].includes(state.role);
}

function blockingBaselineGaps() {
  return Array.isArray(state.baseline?.gaps)
    ? state.baseline.gaps.filter((gap) => gap?.blocks_activation === true)
    : [];
}

function baselineApprovalBlocked() {
  return blockingBaselineGaps().length > 0;
}

function updateAttestationAction() {
  const reference = $("#attestation-reference").value.trim();
  $("#confirm-governing-set").disabled = state.busy || reference.length < 3 || !$("#attestation-confirmed").checked;
}

function selectedDocuments() {
  return state.documents.filter((document) => state.selectedDocumentIds.has(document.id));
}

/* Delivery paperwork has its own reader and its own doctrine. Fed into plan
   analysis it produced a failed run that dropped a live project back to
   intake — an invoice is never a drawing. */
const PAPERWORK_TYPES = new Set(["invoice", "delivery_ticket", "receipt"]);

function isPaperworkDocument(document) {
  return PAPERWORK_TYPES.has(document?.document_type);
}

/* A part of a larger set, and the set it came from. Parts are ordinary
   documents with a memory of where they belong. */
function partOf(document) {
  const derived = document?.source_metadata?.derived_from;
  return derived && derived.document_id ? derived : null;
}
function partsOf(document) {
  return state.documents.filter((item) => partOf(item)?.document_id === document?.id);
}
/* Parts are cut in generations. A finer split supersedes the parts before
   it: they stay in the record — a baseline was read from them — but they
   are no longer what gets read. */
function partGeneration(document) {
  return Number(partOf(document)?.generation || 1);
}
function currentPartsOf(document) {
  const parts = partsOf(document);
  const newest = Math.max(1, ...parts.map(partGeneration));
  return parts.filter((part) => partGeneration(part) === newest);
}
function isStalePart(document) {
  const part = partOf(document);
  if (!part) return false;
  const original = state.documents.find((item) => item.id === part.document_id);
  return original ? !currentPartsOf(original).some((current) => current.id === document.id) : false;
}
/* Parts cut before the reading's image budget was known carry no promise
   that every page keeps its tiles; the site offers a finer split. */
function needsFinerSplit(document) {
  const current = currentPartsOf(document);
  return current.length > 0 && !current.every((part) => Number(partOf(part)?.images_budget || 0) > 0);
}
/* Over the provider's per-file limit: it cannot be sent whole, only as parts. */
function isOversizedDocument(document) {
  return Number(document?.byte_size || 0) > AI_INPUT_LIMIT_BYTES;
}

function canAnalyzeDocument(document) {
  return ANALYZABLE_DOCUMENT_STATUSES.has(document?.status)
    && !isPaperworkDocument(document)
    /* The original of a split set is read through its parts, never whole. */
    && !isOversizedDocument(document)
    /* A part a finer split has superseded is history, not input. */
    && !isStalePart(document);
}

function sameDocumentSet(left = [], right = []) {
  const leftSet = new Set(left || []);
  const rightSet = new Set(right || []);
  return leftSet.size === rightSet.size && [...leftSet].every((id) => rightSet.has(id));
}

function formatMegabytes(bytes = 0) {
  return `${(Number(bytes || 0) / 1048576).toFixed(1)} MB`;
}

function analyzeSelectionState() {
  if (!canAnalyzePlans()) return { disabled: true, label: "Analysis unavailable for this role", message: "A project contributor or reviewer can run plan analysis.", kind: "info" };
  /* A reader with no key in this project cannot be run, and the button says
     which one rather than failing after the press. */
  const blocked = readerBlock();
  if (blocked) return { disabled: true, label: blocked.label, message: blocked.message, kind: "info" };
  if (state.activeAnalysisJob) return { disabled: true, label: "Analysis is running", message: "The saved analysis is running in the background. No action is needed.", kind: "info" };
  if (state.busy) return { disabled: true, label: "Working…", message: "", kind: "info" };

  const documents = selectedDocuments();
  if (!documents.length && state.baseline) {
    const approved = state.baseline.state === "approved";
    return approved
      ? {
          disabled: false,
          label: "Open Field Operations",
          message: `Baseline v${state.baseline.version} is approved and the roadmap is active. Continue in Field Operations.`,
          kind: "success",
          action: "operations",
        }
      : {
          disabled: true,
          label: `Baseline v${state.baseline.version} is ready`,
          message: "Review the saved baseline below and activate the roadmap. Select PDFs only when you need a new baseline.",
          kind: "success",
        };
  }
  if (!documents.length) return { disabled: true, label: "Select PDFs", message: "Select one or more uploaded PDFs to build a new baseline.", kind: "info" };

  const unavailable = documents.find((document) => !canAnalyzeDocument(document));
  if (unavailable) return { disabled: true, label: "PDF is unavailable", message: `${unavailable.original_filename} cannot be analyzed while its status is ${label(unavailable.status)}.`, kind: "info" };

  if (state.baseline && sameDocumentSet(documents.map((document) => document.id), state.baseline.source_document_ids || [])) {
    const approved = state.baseline.state === "approved";
    /* The same set, already read. The door to reading it again stays open
       — a reader improves, a contract changes, a person may want a second
       reading — and it is a deliberate, confirmed act: the button says so,
       and the sentence that names the cost comes before anything is sent. */
    return {
      disabled: false,
      label: approved ? "Open Field Operations" : "Reanalyze this set",
      message: approved
        ? `Baseline v${state.baseline.version} is approved and the roadmap is active. Continue in Field Operations.`
        : `This exact plan set is already analyzed as baseline v${state.baseline.version}. Review it below, or reanalyze — that runs AI again and may use additional credits.`,
      kind: "success",
      action: approved ? "operations" : "reanalyze",
    };
  }

  const totalBytes = documents.reduce((sum, document) => sum + Number(document.byte_size || 0), 0);
  const oversized = documents.find((document) => isOversizedDocument(document));
  if (oversized) {
    const parts = partsOf(oversized);
    return {
      disabled: true,
      label: parts.length ? "Select its parts instead" : "Split for analysis first",
      message: parts.length
        ? `${oversized.original_filename} is read through its ${parts.length} parts — select those instead of the original.`
        : `${oversized.original_filename} is larger than the AI provider accepts in one file (49 MB). Press Split for analysis on its row: the original stays untouched and its parts are read as one set.`,
      kind: "warning",
    };
  }
  /* A set larger than one AI reading no longer stops at a ceiling: the
     analysis partitions it into chunks, checkpoints every finished chunk,
     and a rerun resumes where it stopped. Said out loud, never a dead end. */
  if (totalBytes > AI_INPUT_LIMIT_BYTES) {
    return {
      disabled: false,
      label: "Analyze selected PDFs",
      message: `${documents.length} PDF${documents.length === 1 ? "" : "s"} selected · ${formatMegabytes(totalBytes)}. Larger than one AI reading — the set is analyzed automatically in about ${Math.ceil(totalBytes / AI_INPUT_LIMIT_BYTES)} chunks; finished chunks are saved, and a rerun resumes where it stopped.`,
      kind: "info",
    };
  }

  return {
    disabled: false,
    label: "Analyze selected PDFs",
    message: `${documents.length} PDF${documents.length === 1 ? "" : "s"} selected · ${formatMegabytes(totalBytes)} of 49 MB.`,
    kind: "info",
  };
}

function updateAnalyzeAction({ updateMessage = false } = {}) {
  renderReaderPicker();
  const selection = analyzeSelectionState();
  elements.analyze.disabled = selection.disabled;
  elements.analyze.dataset.action = selection.action || "analyze";
  elements.analyze.innerHTML = `${escapeHtml(selection.label)} <span>↗</span>`;
  if (updateMessage && selection.message) setMessage(selection.message, selection.kind);
}

function setBusy(busy, message = "") {
  state.busy = busy;
  updateAnalyzeAction();
  $("#confirm-upload").disabled = busy || !canUploadPlans();
  $("#approve-baseline").disabled = busy || !canApproveBaseline() || state.baseline?.state === "approved";
  updateAttestationAction();
  elements.propertySelect.disabled = busy;
  if (message) elements.sync.textContent = message;
}

async function initialize() {
  if (!client) {
    elements.boot.innerHTML = "<p>Studio configuration is unavailable. Deploy this folder beside <code>studio/config.js</code>.</p>";
    return;
  }
  const { data, error } = await client.auth.getSession();
  if (error || !data.session) {
    window.location.replace("../");
    return;
  }
  state.session = data.session;
  const { data: membership, error: membershipError } = await client
    .from("organization_members")
    .select("organization_id, role")
    .eq("user_id", state.session.user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (membershipError || !membership) {
    elements.boot.innerHTML = "<p>This account does not have a Studio organization.</p>";
    return;
  }
  state.organizationId = membership.organization_id;
  state.role = membership.role;
  /* The reader picker is an administrator's control, so its catalogue is
     fetched only for the people who may use it. */
  await loadProviders();
  const { data: properties, error: propertiesError } = await client
    .from("properties")
    .select("id, name, address, workflow_state, active_baseline_id, created_at")
    .eq("organization_id", state.organizationId)
    .order("created_at", { ascending: true });
  if (propertiesError) {
    const missingMigration = /workflow_state|active_baseline_id/i.test(propertiesError.message || "");
    elements.boot.innerHTML = missingMigration
      ? "<p>Plan Intelligence database migration has not been applied yet.</p>"
      : `<p>${escapeHtml(propertiesError.message)}</p>`;
    return;
  }
  state.properties = properties || [];
  if (!state.properties.length) {
    elements.boot.innerHTML = '<p>Create a property in <a href="../">Studio</a> before uploading plans.</p>';
    return;
  }
  elements.propertySelect.innerHTML = state.properties.map((property) =>
    `<option value="${property.id}">${escapeHtml(property.name)}</option>`,
  ).join("");
  const requested = new URLSearchParams(window.location.search).get("property");
  const initial = state.properties.find((property) => property.id === requested) || state.properties[0];
  elements.propertySelect.value = initial.id;
  elements.boot.hidden = true;
  elements.app.hidden = false;
  /* Read before openProperty rewrites the URL: the comparison door in
     Studio promises the comparison, so it lands on the visual channel
     itself — not one navigation short of it. */
  const requestedView = new URLSearchParams(window.location.search).get("view");
  const requestedDocument = new URLSearchParams(window.location.search).get("document");
  await openProperty(initial.id);
  if (requestedView === "visual") exitSummaryMode("#visual-panel", "visual");
  if (requestedDocument) await openSearchDocument(requestedDocument);
  if (state.activeAnalysisJob) void monitorAnalysisJob(state.activeAnalysisJob.id, { resumed: true });
}

async function openProperty(propertyId) {
  const propertyChanged = state.property?.id !== propertyId;
  if (propertyChanged) {
    window.clearInterval(state.analysisProgressTimer);
    state.analysisProgressTimer = null;
    state.analysisStartedAt = null;
    state.analysisProgress = 0;
    state.analysisStage = 0;
    state.analysisOutcome = null;
    elements.analysisProgress.hidden = true;
  }
  state.property = state.properties.find((property) => property.id === propertyId) || null;
  if (!state.property) return;
  window.MDAIRecentProjects?.remember({ id: state.property.id, name: state.property.name });
  window.history.replaceState({}, "", `${window.location.pathname}?property=${encodeURIComponent(propertyId)}${
    state.requestedBaselineId ? `&baseline=${encodeURIComponent(state.requestedBaselineId)}` : ""
  }`);
  document.querySelectorAll('a[href="../operations/"],a[href^="../operations/?property="]').forEach((link) => {
    link.href = `../operations/?property=${encodeURIComponent(propertyId)}`;
  });
  /* "Return to evidence" without the project is a return to the project list:
     the person came from a project and has to pick it again. */
  document.querySelectorAll('a[href="../"],a[href^="../?property="]').forEach((link) => {
    link.href = `../?property=${encodeURIComponent(propertyId)}`;
  });
  elements.sync.textContent = "Loading project…";
  setMessage("");
  const [documentsResult, baselinesResult, activeJobResult] = await Promise.all([
    client.from("project_documents")
      .select("id, storage_path, storage_provider, storage_bucket, object_version_id, original_filename, mime_type, byte_size, document_type, revision_label, issued_at, status, processing_error, created_at, page_classification, source_metadata")
      .eq("organization_id", state.organizationId)
      .eq("property_id", propertyId)
      .order("created_at", { ascending: false }),
    client.from("document_baselines")
      .select("id, version, state, source_document_ids, project_summary, analysis, gaps, model, provider, analysis_run, agent_contract_version, created_at, approved_at")
      .eq("organization_id", state.organizationId)
      .eq("property_id", propertyId)
      .order("version", { ascending: false })
      .limit(12),
    client.from("plan_analysis_jobs")
      .select("id, state, baseline_id, progress_stage, progress_percent, error_code, error_message, started_at, created_at")
      .eq("organization_id", state.organizationId)
      .eq("property_id", propertyId)
      .in("state", ["queued", "processing"])
      .order("created_at", { ascending: false })
      .limit(1),
  ]);
  if (documentsResult.error || baselinesResult.error || activeJobResult.error) {
    const error = documentsResult.error || baselinesResult.error || activeJobResult.error;
    notify(error.message, "error");
    elements.sync.textContent = "Cloud query failed";
    return;
  }
  state.documents = documentsResult.data || [];
  /* Field Operations runs the approved baseline, while a newer one may still be
     under review here. A link can name the baseline it means; otherwise the
     newest is shown, because that is the one waiting for a decision. */
  const baselines = baselinesResult.data || [];
  const requestedBaselineId = state.requestedBaselineId;
  state.baselines = baselines;
  state.activeBaseline = baselines.find((item) => item.id === state.property?.active_baseline_id) || null;
  state.baseline =
    baselines.find((item) => item.id === requestedBaselineId) || baselines[0] || null;
  state.activeAnalysisJob = activeJobResult.data?.[0] || null;
  /* A comparison already made of these readings is shown as it was saved,
     without buying anything. */
  await loadComparison();
  const analyzableDocumentIds = new Set(state.documents.filter(canAnalyzeDocument).map((document) => document.id));
  const baselineDocumentIds = (state.baseline?.source_document_ids || []).filter((id) => analyzableDocumentIds.has(id));
  state.selectedDocumentIds = new Set(baselineDocumentIds.length ? baselineDocumentIds : analyzableDocumentIds);
  state.phases = [];
  state.planSpaces = [];
  state.spaceLinks = [];
  state.requirements = [];
  state.tasks = [];
  state.assignments = [];
  state.qualityChecks = [];
  if (state.baseline) {
    const [phaseResult, spaceResult, requirementResult, taskResult, assignmentResult, qualityResult] = await Promise.all([
      client.from("construction_phases").select("*").eq("baseline_id", state.baseline.id).order("sequence"),
      client.from("plan_spaces").select("*").eq("baseline_id", state.baseline.id),
      client.from("capture_requirements").select("*").eq("baseline_id", state.baseline.id).order("created_at"),
      client.from("capture_tasks").select("*").eq("baseline_id", state.baseline.id).order("created_at"),
      client.from("field_assignments").select("id, capture_task_id, worker_name, worker_email, status, due_at, email_delivery_state, email_delivery_error, email_last_attempt_at, created_at, updated_at").eq("baseline_id", state.baseline.id).order("created_at", { ascending: false }),
      client.from("field_quality_checks").select("id, assignment_id, capture_task_id, state, result, created_at, completed_at").eq("property_id", propertyId).order("created_at", { ascending: false }),
    ]);
    const loadError = phaseResult.error || spaceResult.error || requirementResult.error || taskResult.error || assignmentResult.error || qualityResult.error;
    if (loadError) notify(loadError.message, "error");
    state.phases = phaseResult.data || [];
    state.planSpaces = spaceResult.data || [];
    state.requirements = requirementResult.data || [];
    state.tasks = taskResult.data || [];
    state.assignments = assignmentResult.data || [];
    state.qualityChecks = qualityResult.data || [];
    /* Routes belong to the project's active baseline, not to whichever
       baseline this screen happens to be showing, so they are read through the
       function that knows that rather than filtered here. A failure to load
       them must not take the rest of the screen with it. */
    const routeResult = await client.rpc("project_space_links", { p_property_id: propertyId });
    if (routeResult.error) console.error("routes", routeResult.error);
    state.spaceLinks = routeResult.data || [];
    const takeoffResult = await client
      .from("material_takeoffs")
      .select("id, kind, lines, traces, gaps, answers, note, measured_walls, state, approved_at, calculator_version")
      .eq("baseline_id", state.baseline.id)
      .eq("kind", "wood_framing")
      .eq("state", "approved")
      .limit(1);
    if (takeoffResult.error) console.error("takeoff", takeoffResult.error);
    state.approvedTakeoff = takeoffResult.data?.[0] || null;
    /* The expert layer: line-level reviews are the only door to a
       human-confirmed value. Active rows only; history stays in the table. */
    const reviewResult = await client
      .from("takeoff_line_reviews")
      .select("line_key, verdict, value, note, reviewer_role, reviewed_at")
      .eq("baseline_id", state.baseline.id)
      .eq("kind", "wood_framing")
      .eq("state", "active");
    if (reviewResult.error) console.error("line reviews", reviewResult.error);
    state.takeoffReviews = reviewResult.data || [];
  }
  /* The intelligence core: what the record shows (rooms + evidence) and
     where requirement meets evidence. Read-only inputs to the summary and
     the Visual Evidence view; the owner writes none of it. */
  {
    const roomsResult = await client.from("spaces").select("id, name").eq("property_id", propertyId);
    state.projectRooms = roomsResult.data || [];
    const evidenceResult = await client.from("evidence_items")
      .select("id, space_id, media_type").eq("property_id", propertyId).is("deleted_at", null);
    state.projectEvidence = evidenceResult.data || [];
    const reconResult = await client.from("project_reconciliations")
      .select("component_key, required_quantity, delivered_quantity, evidenced_quantity, coverage, verdict, narrative")
      .eq("property_id", propertyId).eq("state", "active");
    state.reconciliations = reconResult.data || [];
    /* Which rooms the AI has actually read. A capture that nobody has read
       contributes nothing to the installed side of the comparison — and the
       screen must say so, with the door, instead of starving quietly. */
    const readResult = await client.from("project_observations")
      .select("space_id")
      .eq("property_id", propertyId).eq("state", "active").eq("kind", "installed_seen");
    state.readSpaceIds = new Set((readResult.data || []).map((row) => row.space_id).filter(Boolean));
    /* Where the reader could not read, accumulated across every reading of
       this project. Roles without the register simply see no section. */
    await loadReadingRegister(propertyId);
    await loadReadingWeakSpots();
  }
  await loadRebuildOffer(propertyId);
  render();
  elements.sync.textContent = state.activeAnalysisJob
    ? "Plan analysis continues in the background"
    : `Cloud connected · ${state.role}`;
  void ensureIntelligenceChain("open");

  /* The ledger line, refreshed whenever the project is opened. */
  void refreshAiUsageLine();
}

/* The chain runs itself.
 *
 * Analysis produced a baseline; the intelligence core compares what the
 * plans require against what the record shows — but that comparison only
 * exists once the baseline's components are distilled into requirements,
 * and until now nothing in the product ever did that. The owner uploaded,
 * analyzed, looked at Visual Evidence… and the comparison was silently
 * empty, forever.
 *
 * Now, whenever a baseline with framing intelligence is open and its
 * requirements have not been distilled yet — a fresh analysis or a project
 * analyzed before the core existed — the distillation and a reconciliation
 * run by themselves. Idempotent on the server (re-runs supersede, never
 * duplicate), gated to the roles that hold the technical channel, and
 * silent when there is nothing to do. The owner still enters nothing. */
/* The names a person uses for what the reader calls a category. */
const RESULT_SECTIONS = [
  { category: "door", title: "Doors" },
  { category: "window", title: "Windows" },
  { category: "electrical_fixture", title: "Lighting and electrical" },
  { category: "electrical_device", title: "Electrical devices" },
  { category: "plumbing_fixture", title: "Plumbing fixtures" },
  { category: "mechanical_equipment", title: "Mechanical equipment" },
  { category: "appliance", title: "Appliances" },
  { category: "other", title: "Other scheduled items" },
];

const chainRuns = new Set();
async function ensureIntelligenceChain(trigger) {
  const baseline = state.baseline;
  if (!baseline || !state.property) return;
  /* The chain runs when the analysis holds something distillable: framing
     members for a takeoff world, or printed architectural schedules. A
     baseline with neither would distil zero rows and re-run on every open
     — so it never starts. */
  const schedules = Array.isArray(baseline.analysis?.component_schedules)
    ? baseline.analysis.component_schedules : [];
  if (!takeoffDraft() && !schedules.length) return;
  const mayRun = canApproveBaseline() || state.role === "project_manager";
  if (!mayRun) return;
  const runKey = `${baseline.id}:${trigger}`;
  if (chainRuns.has(runKey)) return;

  const { data: existing, error: existingError } = await client
    .from("project_requirements")
    .select("id")
    .eq("baseline_id", baseline.id)
    .eq("state", "active")
    .limit(1);
  if (existingError) return;
  if ((existing || []).length && trigger !== "approved") return;
  chainRuns.add(runKey);

  const { error: extractError } = await client.rpc("extract_project_requirements", {
    p_baseline_id: baseline.id,
  });
  if (extractError) { console.error("requirements", extractError); return; }
  const { error: reconcileError } = await client.rpc("reconcile_project", {
    p_property_id: state.property.id,
  });
  if (reconcileError) console.error("reconcile", reconcileError);

  const reconResult = await client.from("project_reconciliations")
    .select("component_key, required_quantity, delivered_quantity, evidenced_quantity, coverage, verdict, narrative")
    .eq("property_id", state.property.id).eq("state", "active");
  if (!reconResult.error) state.reconciliations = reconResult.data || [];
  /* The distillation just told the register what this reading could not
     count. Re-read it so the screen carries the same news. */
  await loadReadingRegister(state.property.id);
  render();
  if ((existing || []).length === 0) {
    notify("The plans' requirements are distilled — Visual Evidence now compares required, delivered and installed.");
  }
}

function render() {
  renderRebuildOffer();
  renderHero();
  const workflowState = state.property?.workflow_state || "intake";
  elements.workflowBadge.textContent = label(workflowState);
  elements.workflowBadge.className = `state-pill ${workflowState}`;
  $("#metric-documents").textContent = state.documents.length;
  $("#metric-documents-copy").textContent = state.documents.length ? "Current source register" : "Upload the issued set";
  $("#metric-baseline").textContent = state.baseline ? `v${state.baseline.version}` : "—";
  $("#metric-baseline-copy").textContent = state.baseline ? label(state.baseline.state) : "Not analyzed";
  $("#metric-phases").textContent = state.phases.length;
  $("#metric-tasks").textContent = state.tasks.length;
  const verified = state.tasks.filter((task) => task.status === "verified").length;
  $("#metric-tasks-copy").textContent = state.tasks.length ? `${verified} verified · ${state.tasks.length - verified} open` : "Waiting for plans";
  $("#upload-plans-label").hidden = !canUploadPlans();
  renderRoadmapDivergence();
  renderDocuments();
  renderBaseline();
  renderRegister();
  renderRoadmap();
  renderRoutes();
  renderTakeoff();
  renderOwnerSummary();
  if (state.baseline && !state.activeAnalysisJob && state.analysisOutcome !== "failed") {
    const approved = state.baseline.state === "approved";
    renderAnalysisProgress(100, analysisStages.length - 1, {
      success: true,
      title: approved ? "Roadmap active" : "Analysis complete · Review required",
      detail: approved
        ? "The governed roadmap is active. Open Field Operations to continue."
        : "The roadmap is saved and ready for human approval.",
      elapsedLabel: "Saved",
    });
  }
  updateAnalyzeAction({ updateMessage: state.analysisOutcome !== "failed" });
  /* The activation checklist lived in the sidebar that this page no longer has.
     The baseline section and the roadmap carry the same state in place. */
}

// Search currently resolves whole documents. Do not imply a page anchor when
// retrieval has no saved page number. Sign the existing file only when opened.
async function openSearchDocument(id) {
  const source = state.documents.find(row => row.id === id);
  if (!source) { notify("That source document is unavailable in this project."); return; }
  try {
    let url;
    if (source.storage_provider === "aws-s3") {
      url = await window.MDAIObjectStorage.getSignedUrl(client, "project_document", source.id);
    } else {
      const { data, error } = await client.storage.from(source.storage_bucket || "project-documents")
        .createSignedUrl(source.storage_path, 3600);
      if (error) throw error;
      url = data?.signedUrl;
    }
    if (!url) throw new Error("Source link unavailable");
    document.getElementById("search-source-dialog")?.remove();
    const dialog = document.createElement("dialog");
    dialog.id = "search-source-dialog";
    dialog.style.cssText = "width:90vw;height:85vh;padding:16px";
    const title = document.createElement("h2");
    title.textContent = source.original_filename;
    const note = document.createElement("p");
    note.textContent = "Whole document — the search record does not contain a page anchor.";
    const close = document.createElement("button");
    close.textContent = "Close source";
    close.onclick = () => dialog.close();
    const link = document.createElement("a");
    link.textContent = "Open original document";
    link.href = url; link.target = "_blank"; link.rel = "noopener";
    const frame = document.createElement("iframe");
    frame.title = source.original_filename; frame.src = url;
    frame.style.cssText = "width:100%;height:65vh;border:0";
    dialog.append(title, note, close, link, frame);
    dialog.addEventListener("close", () => dialog.remove());
    document.body.append(dialog); dialog.showModal();
  } catch (error) {
    notify("The source could not be opened. Please try again.");
    console.warn("search source", error);
  }
}

function renderDocuments() {
  elements.documentEmpty.hidden = state.documents.length > 0;
  elements.documentList.hidden = state.documents.length === 0;
  elements.documentList.innerHTML = state.documents.map((document) => {
    const selectable = canAnalyzeDocument(document);
    const paperwork = isPaperworkDocument(document);
    const parts = partsOf(document);
    const part = partOf(document);
    const choiceTitle = paperwork
      ? "Delivery paperwork is read by the document reader — it is never part of plan analysis"
      : isOversizedDocument(document)
        ? (parts.length
          ? `Analysed through its ${parts.length} parts — select those`
          : "Larger than the AI provider accepts in one file — split it for analysis first")
      : isStalePart(document)
        ? "Superseded by a finer split — select the newer parts"
      : document.status === "failed"
        ? "Select to retry analysis"
        : selectable
          ? "Include in a new baseline"
          : `Unavailable while ${label(document.status)}`;
    const baselineVersion = state.baseline?.id === state.property?.active_baseline_id
      && (state.baseline?.source_document_ids || []).includes(document.id)
      ? state.baseline.version
      : null;
    const deleteTitle = baselineVersion
      ? `Included in baseline v${baselineVersion}; create a replacement baseline before deleting`
      : `Delete ${document.original_filename}`;
    /* A classified PDF wears its reading out loud — and wears its provenance
       with it. Page kinds are an AI reading, never a confirmed fact. */
    const PAGE_KIND_LABELS = {
      technical_drawing: "plan", specification: "spec", schedule: "schedule",
      invoice: "invoice", delivery_ticket: "delivery-ticket", receipt: "receipt",
      site_photo: "site-photo", correspondence: "correspondence", other: "other",
    };
    const classifiedPages = document.page_classification?.pages || [];
    const kindCounts = classifiedPages.reduce((counts, page) => {
      counts[page.kind] = (counts[page.kind] || 0) + 1;
      return counts;
    }, {});
    const classifiedLine = classifiedPages.length
      ? `<small class="document-classified">Pages read by AI · not confirmed: ${escapeHtml(
          Object.entries(kindCounts)
            .map(([kind, count]) => `${count} ${PAGE_KIND_LABELS[kind] || kind} page${count === 1 ? "" : "s"}`)
            .join(" · "))}</small>`
      : "";
    /* Why it failed, on the screen.
     *
     * The reason the reader gave lived in a title attribute — a tooltip, and
     * only for somebody with a mouse who thought to hover a red word. What a
     * person saw was FAILED and nothing else, and the answer was in the
     * record the whole time. That is the same failure as a black rectangle
     * where a video should be: the system knew, and did not say. */
    const whyItFailed = document.status === "failed" && document.processing_error
      ? `<small class="document-why">${escapeHtml(document.processing_error)}</small>`
      : "";
    /* A part says which pages of which file it is; an original that has
       been split says it is read through its parts. Both are derived
       copies — the original file is never altered. */
    const partLine = part
      ? `<small class="document-part">Part ${part.part} of ${part.parts} · pages ${part.page_from}–${part.page_to} of ${part.pages_total} · ${isStalePart(document) ? "superseded by a finer split · kept in the record" : "derived for analysis"}</small>`
      : parts.length
        ? `<small class="document-part">Analysed as ${currentPartsOf(document).length} parts · the original is kept whole${needsFinerSplit(document) ? " · these parts were cut before the image budget was known: some pages lose their high-resolution tiles" : ""}</small>`
        : "";
    return `
    <article class="document-row">
      <label class="document-choice" title="${escapeHtml(choiceTitle)}"><input type="checkbox" data-document-select="${document.id}" ${state.selectedDocumentIds.has(document.id) ? "checked" : ""} ${selectable ? "" : "disabled"}><span class="document-icon">PDF</span></label>
      <div class="document-name"><strong title="${escapeHtml(document.original_filename)}">${escapeHtml(document.original_filename)}</strong><small>${document.byte_size ? `${(document.byte_size / 1048576).toFixed(1)} MB` : "Private source"}</small>${classifiedLine}${partLine}${whyItFailed}</div>
      <div class="document-cell"><span>Discipline</span><strong>${escapeHtml(label(document.document_type))}</strong></div>
      <div class="document-cell"><span>Revision</span><strong>${escapeHtml(display(document.revision_label, "Not stated"))}</strong></div>
      <div class="document-actions">
        ${paperwork
          ? `<span class="document-status uploaded" title="Delivery paperwork — read for delivered quantities, never analyzed as plans">Paperwork</span>`
          : `<span class="document-status ${document.status}" title="${escapeHtml(document.processing_error || "")}">${escapeHtml(label(document.status))}</span>`}
        ${splitAction(document, parts)}
        ${rereadAction(document)}
        ${canDeletePlans() ? `<button class="document-delete" type="button" data-document-delete="${document.id}" title="${escapeHtml(deleteTitle)}" aria-label="${escapeHtml(deleteTitle)}" ${baselineVersion ? "disabled" : ""}>Delete</button>` : ""}
      </div>
    </article>
  `;
  }).join("");
  elements.documentList.querySelectorAll("[data-document-select]").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) state.selectedDocumentIds.add(input.dataset.documentSelect);
      else state.selectedDocumentIds.delete(input.dataset.documentSelect);
      updateAnalyzeAction({ updateMessage: true });
    });
  });
  elements.documentList.querySelectorAll("[data-document-delete]").forEach((button) => {
    button.addEventListener("click", () => deletePlanDocument(button.dataset.documentDelete));
  });
  elements.documentList.querySelectorAll("[data-document-reread]").forEach((button) => {
    button.addEventListener("click", () => rereadDocument(button.dataset.documentReread));
  });
  elements.documentList.querySelectorAll("[data-document-split]").forEach((button) => {
    button.addEventListener("click", () => splitDocumentForAnalysis(button.dataset.documentSplit));
  });
}

/* The way through for a file the provider will not take whole. Offered only
   where it applies: an oversized plan that has no parts yet. */
function splitAction(document, parts = partsOf(document)) {
  if (!isOversizedDocument(document) || isPaperworkDocument(document) || partOf(document)) return "";
  if (parts.length && !needsFinerSplit(document)) return "";
  const again = parts.length > 0;
  const title = again
    ? `Copy ${document.original_filename} into finer parts so every page keeps its high-resolution tiles — the earlier parts and the original stay exactly as they are`
    : `Copy ${document.original_filename} into parts the AI can read — the original stays exactly as uploaded`;
  return `<div class="document-reread-cell"><button class="document-reread" type="button" data-document-split="${document.id}" title="${escapeHtml(title)}">${again ? "Split again for full resolution" : "Split for analysis"}</button></div>`;
}

/* Copies a plan's pages into parts that fit one AI reading each and stores
   every part as a derived document beside the original. `bytes` is the file
   as uploaded; nothing here writes to it. */
async function splitAndUploadParts({ bytes, original, generation = 1, onProgress = () => {} }) {
  if (!window.MDAIPdfSplit) throw new Error("The PDF splitter did not load. Reload the page and retry.");
  const { parts, skipped, pageCount } = await window.MDAIPdfSplit.splitPdf({
    bytes, byteSize: original.byte_size || bytes.byteLength, onProgress,
  });
  if (!parts.length) throw new Error("No page range of this file fits one AI reading. An optimized copy is still needed.");
  const saved = [];
  for (const [index, part] of parts.entries()) {
    const filename = window.MDAIPdfSplit.partFilename(original.original_filename, part.from, part.to);
    onProgress(`Saving part ${index + 1} of ${parts.length} — ${filename}…`);
    const file = new File([part.bytes], filename, { type: "application/pdf", lastModified: Date.now() });
    const result = await window.MDAIObjectStorage.upload({
      client,
      entityType: "project_document",
      organizationId: state.organizationId,
      propertyId: state.property.id,
      file,
      metadata: {
        document_type: original.document_type,
        revision_label: original.revision_label || null,
        issued_at: original.issued_at || null,
        source_metadata: {
          source: "measured-decision-plan-workspace",
          derived_from: window.MDAIPdfSplit.derivedFrom({
            documentId: original.id, from: part.from, to: part.to,
            pagesTotal: pageCount, part: index + 1, parts: parts.length,
            generation, imagesBudget: window.MDAIPdfSplit.PART_MAX_IMAGES,
          }),
        },
      },
    });
    if (result?.record?.id) saved.push(result.record.id);
  }
  return { saved, skipped, pageCount, parts: parts.length };
}

/* The row action: fetch the original once, split it, store the parts. */
async function splitDocumentForAnalysis(documentId) {
  const document = state.documents.find((item) => item.id === documentId);
  if (!document || state.busy || (partsOf(document).length && !needsFinerSplit(document))) return;
  const generation = Math.max(0, ...partsOf(document).map(partGeneration)) + 1;
  await window.MDAIAiUsage.once(`split:${document.id}:${generation}`, async () => {
    setBusy(true, `Reading ${document.original_filename} for splitting…`);
    try {
      let url = "";
      if (document.storage_provider === "aws-s3") {
        url = await window.MDAIObjectStorage.getSignedUrl(client, "project_document", document.id);
      } else {
        const { data, error } = await client.storage.from(document.storage_bucket || "project-documents")
          .createSignedUrl(document.storage_path, 600);
        if (error || !data?.signedUrl) throw error || new Error("No signed URL for the plan PDF");
        url = data.signedUrl;
      }
      const response = await fetch(url);
      if (!response.ok) throw new Error(`The plan PDF could not be read (${response.status})`);
      const bytes = await response.arrayBuffer();
      const outcome = await splitAndUploadParts({
        bytes, original: document, generation,
        onProgress: (line) => setBusy(true, line),
      });
      notify(`${document.original_filename} copied into ${outcome.parts} part${outcome.parts === 1 ? "" : "s"} for analysis — the original is untouched.`
        + (outcome.skipped.length ? ` Page${outcome.skipped.length === 1 ? "" : "s"} ${outcome.skipped.join(", ")} could not fit one reading and need an optimized copy.` : ""));
      await openProperty(state.property.id);
    } catch (error) {
      notify(error?.message || "The plan could not be split. The original is untouched.", "error");
    } finally {
      setBusy(false);
    }
  });
}

/* Which reader a document belongs to, and the key its block is remembered
   under. Paperwork goes to the document reader; an undeclared PDF goes back
   through page classification, which then routes its pages itself. */
function readerFor(document) {
  if (isPaperworkDocument(document)) return { worker: "document-evidence", label: "Read again" };
  if (document.document_type === "other" || document.page_classification?.pages?.length) {
    return { worker: "document-classify", label: "Read again" };
  }
  return null;
}
function rereadKey(document) {
  const reader = readerFor(document);
  return reader ? `${reader.worker}:${document.id}` : null;
}

/* The action beside a document that has a reader. When an earlier reading's
   outcome is unknown the row says so, and the same button is the way out. */
function rereadAction(document) {
  const reader = readerFor(document);
  if (!reader) return "";
  const pending = window.MDAIAiUsage?.pendingUnknownRun(rereadKey(document));
  const note = pending
    ? `<small class="document-why document-unknown">An earlier reading may have run and been billed. Press ${reader.label} to decide.</small>`
    : "";
  const title = pending
    ? "Confirm before this document is read again"
    : `Read ${document.original_filename} again — this runs AI and may use additional credits`;
  return `<div class="document-reread-cell">${note}<button class="document-reread" type="button" data-document-reread="${document.id}" title="${escapeHtml(title)}">${reader.label}</button></div>`;
}

/* One press, one reading, whatever the state of the earlier one.
 *
 *   unknown outcome remembered  → the money-already-spent question, then one run
 *   otherwise                   → the money-about-to-be-spent question, then one
 *                                 forced run — which the ledger may still refuse
 *                                 as unknown, in which case the person is asked
 *                                 the first question right then, because they
 *                                 pressed and are waiting for an answer
 *
 * Everything is inside once(), so a double press is dropped before it can
 * ask anything. */
async function rereadDocument(documentId) {
  const document = state.documents.find((item) => item.id === documentId);
  const reader = document ? readerFor(document) : null;
  if (!document || !reader || state.busy) return;
  const key = rereadKey(document);

  const run = async ({ force }) => {
    setBusy(true, `Reading ${document.original_filename} again…`);
    try {
      const outcome = reader.worker === "document-classify"
        ? await classifyUploadedDocument(document.id, { force })
        : await readDeliveryDocument(document.id, { force });
      if (outcome?.refused === "outcome_unknown") {
        /* The ledger refused because an earlier attempt is unresolved. The
           person has just pressed and is waiting, so the decision is offered
           now rather than left for a second press. */
        const offer = await window.MDAIAiUsage.offerUnknownRetry({
          client, key, retry: () => run({ force: false }),
        });
        if (offer.handled && !offer.confirmed && offer.reason === "declined") {
          notify("Nothing was read. The earlier attempt is still unresolved.");
        }
      }
    } finally {
      setBusy(false);
      renderDocuments();
    }
  };

  await window.MDAIAiUsage.once(`reread:${document.id}`, async () => {
    /* An unresolved earlier reading comes first: that question is about
       money already spent, the other about money about to be. */
    const offer = await window.MDAIAiUsage.offerUnknownRetry({
      client, key, retry: () => run({ force: false }),
    });
    if (offer.handled) {
      if (!offer.confirmed && offer.reason === "declined") {
        notify("Nothing was read. The earlier attempt is still unresolved.");
      }
      return;
    }
    if (!window.MDAIAiUsage.confirmReanalyze()) return;
    await run({ force: true });
  });
}

/* The document reader, pressed by a person rather than by an upload. */
async function readDeliveryDocument(documentId, options = {}) {
  const { data, error } = await client.functions.invoke("document-evidence", {
    body: { document_id: documentId, force: Boolean(options.force) },
  });
  const refused = window.MDAIAiUsage?.skippedVerdict(data);
  if (refused) {
    if (refused === "outcome_unknown") window.MDAIAiUsage.rememberUnknown(`document-evidence:${documentId}`, data);
    else notify(window.MDAIAiUsage.skippedMessage(refused));
    return { read: false, refused, data };
  }
  if (error || data?.error) {
    notify(data?.error || "The delivery document could not be read — it stays preserved in the record", "error");
    return { read: false };
  }
  notify(`Delivery recorded: ${data.lines_recorded} line${data.lines_recorded === 1 ? "" : "s"} — the Delivered column of the comparison is updated. Installation stays not-yet-evidenced until capture shows it.`);
  void openProperty(state.property.id);
  return { read: true };
}

async function deletePlanDocument(documentId) {
  const document = state.documents.find((item) => item.id === documentId);
  if (!document || state.busy || !canDeletePlans()) return;
  const confirmed = window.confirm(`Delete “${document.original_filename}”?\n\nThis removes the plan from the project and active storage. It cannot be restored from Studio.`);
  if (!confirmed) return;
  setBusy(true, `Deleting ${document.original_filename}…`);
  try {
    if (!window.MDAIObjectStorage?.deleteProjectDocument) throw new Error("The secure deletion service did not load. Reload the page and retry.");
    await window.MDAIObjectStorage.deleteProjectDocument(client, document.id);
    state.selectedDocumentIds.delete(document.id);
    notify(`${document.original_filename} deleted.`);
    await openProperty(state.property.id);
  } catch (error) {
    console.error(error);
    notify(error.message || "Plan could not be deleted", "error");
  } finally {
    setBusy(false, `Cloud connected · ${state.role}`);
    render();
  }
}

/* How the rooms connect.
 *
 * The plan set is the only source: a door drawn on a sheet is a fact on the
 * sheet. What the record can stand behind is "these two rooms have an opening
 * between them", and nothing about where it is — so this is a list, not a
 * diagram. A drawn floor plan here would be a picture of a guess.
 *
 * Every row wears its state, because an unconfirmed reading shown quietly is an
 * unconfirmed reading shown as a fact.
 */
const ROUTE_KIND_LABEL = {
  door: "Door",
  opening: "Opening",
  stairs: "Stairs",
  corridor: "Corridor",
  exterior_door: "Exterior door",
  other: "Opening",
};

/* Each end names itself. Two unlabelled lines under "Hall ↔ Kitchen" — one
   saying "3 files" and one saying "nothing yet" — leave the reader guessing
   which room is which, and guessing is the thing this product is against. */
function routeEndCopy(roomName, planName, evidenceCount) {
  const name = escapeHtml(roomName || planName || "Unnamed space");
  if (!roomName) {
    /* The plans name it and the record has no room for it. Hiding the row would
       read as "there is no door there", which is a different and untrue thing. */
    return `<small class="route-missing">${name} — on the plans, not in the record</small>`;
  }
  return evidenceCount > 0
    ? `<small>${name} — ${evidenceCount} file${evidenceCount === 1 ? "" : "s"}</small>`
    : `<small class="route-empty-room">${name} — nothing captured here yet</small>`;
}

function renderRoutes() {
  const section = $("#routes-section");
  if (!section) return;
  const routes = state.spaceLinks || [];
  /* Nothing to say before there is an approved plan set with rooms in it. */
  section.hidden = !state.baseline || !state.planSpaces.length;
  if (section.hidden) return;

  const confirmed = routes.filter((route) => route.state === "confirmed").length;
  const pill = $("#routes-state");
  if (pill) {
    pill.textContent = routes.length
      ? `${confirmed} of ${routes.length} confirmed`
      : "None read";
    pill.className = `state-pill ${routes.length && confirmed === routes.length ? "approved" : "baseline_review"}`;
  }

  $("#routes-empty").hidden = routes.length > 0;
  const list = $("#route-list");
  list.hidden = routes.length === 0;
  list.innerHTML = routes.map((route) => {
    const unmapped = !route.from_room_id || !route.to_room_id;
    const isConfirmed = route.state === "confirmed";
    return `
    <article class="route-row${unmapped ? " unmapped" : ""}">
      <div class="route-pair">
        <strong>${escapeHtml(route.from_room_name || route.from_plan_name || "Unnamed space")} ↔ ${escapeHtml(route.to_room_name || route.to_plan_name || "Unnamed space")}</strong>
        ${routeEndCopy(route.from_room_name, route.from_plan_name, Number(route.from_evidence_count) || 0)}
        ${routeEndCopy(route.to_room_name, route.to_plan_name, Number(route.to_evidence_count) || 0)}
      </div>
      <span class="route-kind">${escapeHtml(ROUTE_KIND_LABEL[route.connection] || "Opening")}</span>
      <span class="route-state${isConfirmed ? " confirmed" : ""}">${isConfirmed ? "Confirmed by a person" : "Read by AI · not confirmed"}</span>
      <div class="route-actions">
        ${canConfirmRoutes() && !isConfirmed ? `<button class="button primary" type="button" data-route-confirm="${route.link_id}">This door is there</button>` : ""}
        ${canConfirmRoutes() ? `<button class="button secondary" type="button" data-route-reject="${route.link_id}">Not there</button>` : ""}
      </div>
    </article>`;
  }).join("");

  list.querySelectorAll("[data-route-confirm]").forEach((button) => {
    button.addEventListener("click", () => reviewRoute(button.dataset.routeConfirm, "confirmed"));
  });
  list.querySelectorAll("[data-route-reject]").forEach((button) => {
    button.addEventListener("click", () => reviewRoute(button.dataset.routeReject, "rejected"));
  });
}

async function reviewRoute(linkId, verdict) {
  const route = (state.spaceLinks || []).find((item) => item.link_id === linkId);
  if (!route || state.busy) return;
  const pair = `${route.from_room_name || route.from_plan_name} ↔ ${route.to_room_name || route.to_plan_name}`;
  /* Rejecting takes the route out of the walk, so it is the one that gets
     asked about. Confirming can be undone by rejecting; a wrong turn inside a
     headset cannot be undone by anything. */
  if (verdict === "rejected" && !window.confirm(`Remove the route ${pair}?\n\nNobody will be able to walk between these two rooms until it is read again from a new plan set.`)) return;
  setBusy(true, verdict === "confirmed" ? "Confirming the route…" : "Removing the route…");
  try {
    const { error } = await client.rpc("review_space_link", { p_link_id: linkId, p_state: verdict });
    if (error) throw error;
    notify(verdict === "confirmed"
      ? `${pair} is confirmed. It can be walked.`
      : `${pair} is not a route.`);
    await openProperty(state.property.id);
  } catch (error) {
    console.error(error);
    notify(error.message || "The route could not be recorded", "error");
  } finally {
    setBusy(false, `Cloud connected · ${state.role}`);
  }
}

/* The wood takeoff draft.
 *
 * Three parties, each doing the only thing it is trusted with. The AI read the
 * dimensions the sheets print — never measured by scale — each with its sheet
 * citation. The calculator (takeoff360.js, deterministic, tested by hand)
 * turns those into lumber counts and shows its arithmetic. The person signs,
 * and what they signed is stored verbatim.
 *
 * A wall without a printed length is a gap said out loud, never a guess:
 * an order that silently omits a wall reads as a smaller house. */
const TAKEOFF_CALCULATOR_VERSION = "takeoff360-1";

/* The AI Takeoff Review.
 *
 * The owner uploads plans and looks at a finished result. They are never
 * asked to count members, measure sheets, or fill a technical field: the AI
 * proposes everything it can with its provenance and confidence, the product
 * raises its own RFIs where the plans do not answer, and the workbook
 * downloads without any signature.
 *
 * Provenance is a fact of each row, not a mood:
 *   PRINTED_FACT · AI_PLAN_COUNT · DERIVED_FROM_PRINTED_DIMENSIONS ·
 *   AI_SCALED_ESTIMATE (field verify) · OPEN_RFI.
 * An owner's acceptance records OWNER_ACCEPTED_BASELINE and nothing more.
 * HUMAN_CONFIRMED exists only through line-by-line expert review. */
const TAKEOFF_METHOD_LABELS = {
  PRINTED_FACT: "Printed fact",
  AI_PLAN_COUNT: "AI plan count",
  DERIVED_FROM_PRINTED_DIMENSIONS: "Derived from printed dimensions",
  AI_SCALED_ESTIMATE: "AI scaled estimate — field verify",
};

function takeoffDraft() {
  const walls = Array.isArray(state.baseline?.analysis?.framing_walls)
    ? state.baseline.analysis.framing_walls
    : [];
  const decks = Array.isArray(state.baseline?.analysis?.framing_decks)
    ? state.baseline.analysis.framing_decks
    : [];
  const members = Array.isArray(state.baseline?.analysis?.structural_members)
    ? state.baseline.analysis.structural_members
    : [];
  if ((!walls.length && !decks.length && !members.length) || !window.MDAITakeoff360) return null;
  return { walls, decks, members, result: window.MDAITakeoff360.takeoff(walls, decks, members) };
}

function takeoffOpenGaps(draft) {
  return [
    ...draft.result.gaps,
    ...draft.result.unmeasured.map((wall) => `${wall.label || "a wall"} has no printed length (${(wall.source_refs || []).join(", ") || "no sheet cited"})`),
  ];
}

function activeReviews() {
  const map = new Map();
  for (const review of state.takeoffReviews || []) map.set(review.line_key, review);
  return map;
}

/* What a corrected line was corrected FROM.

   The record has always kept the AI's reading beside the reviewer's, but
   this screen replaced one with the other: the moment a person corrected a
   number, the fact that the machine had been wrong vanished from view. That
   is the provenance this product exists to keep — an auditor asking "what
   did the AI say before a human touched it" could read the row and never
   learn that anything had been touched at all. Now the row says both. */
function correctedFrom(review, aiValue) {
  if (review?.verdict !== "corrected") return "";
  const was = String(aiValue || "").trim();
  if (!was || was === String(review.value || "").trim()) return "";
  return `<small class="corrected-from">AI read ${escapeHtml(was)} · corrected by ${escapeHtml(review.reviewer_role)}</small>`;
}

function takeoffLineMeta(line, review) {
  const parts = [TAKEOFF_METHOD_LABELS[line.method] || "Derived from printed dimensions"];
  const refs = (line.source_refs || []).join(", ");
  if (refs) parts.push(refs);
  if (line.category === "not_lumber") parts.push("Not lumber");
  parts.push(line.status === "hold" ? "HOLD" : "ready");
  let text = parts.join(" · ");
  if (review?.verdict === "confirmed" || review?.verdict === "corrected") {
    text += ` · HUMAN_CONFIRMED by ${review.reviewer_role}, ${new Date(review.reviewed_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  }
  return text;
}

function renderTakeoff() {
  const section = $("#takeoff-section");
  if (!section) return;
  section.hidden = !state.baseline;
  if (section.hidden) return;

  const accepted = state.approvedTakeoff;
  const draft = takeoffDraft();
  const reviews = activeReviews();
  const confirmedCount = [...reviews.values()].filter((review) => review.verdict !== "kept_open").length;
  const pill = $("#takeoff-state");
  const approve = $("#approve-takeoff");
  const grid = $("#takeoff-grid");
  const empty = $("#takeoff-empty");
  const intro = $("#takeoff-intro");

  if (!draft) {
    pill.textContent = accepted ? "Accepted earlier · re-analyse to review" : "No dimensions read";
    pill.className = "state-pill intake";
    approve.hidden = true;
    $("#download-ai-takeoff").hidden = true;
    $("#download-ai-takeoff-xlsx").hidden = true;
    $("#export-record").hidden = true;
    $("#download-takeoff").hidden = true;
    $("#takeoff-expert").hidden = true;
    $("#takeoff-expert-offer").hidden = true;
    grid.hidden = true;
    empty.hidden = false;
    intro.textContent = "";
    return;
  }

  const openGaps = takeoffOpenGaps(draft);
  const proposals = draft.result.proposals || [];
  empty.hidden = true;
  grid.hidden = false;
  pill.textContent = confirmedCount
    ? `${confirmedCount} line${confirmedCount === 1 ? "" : "s"} human-confirmed`
    : accepted
      ? `Accepted as working baseline ${new Date(accepted.approved_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
      : "Read by AI · not confirmed";
  pill.className = `state-pill ${confirmedCount ? "approved" : accepted ? "approved" : "baseline_review"}`;

  const mayReview = canApproveBaseline() || state.role === "project_manager";
  approve.hidden = Boolean(accepted) || !mayReview;
  $("#download-ai-takeoff").hidden = false;
  $("#download-ai-takeoff-xlsx").hidden = false;
  $("#export-record").hidden = false;
  $("#download-takeoff").hidden = confirmedCount === 0;
  $("#takeoff-expert").hidden = !mayReview;
  $("#takeoff-expert-offer").hidden = false;
  intro.textContent = "Measured Decision analyzed the submitted plans and prepared the quantities below. Review the result, assumptions, and open RFIs. No manual plan measurement is required.";

  /* The quantities, each wearing its provenance. Proposals sit in the same
     table, marked as proposals — the AI's best reading where certainty was
     out of reach, never silently blank. */
  const body = $("#takeoff-table tbody");
  body.innerHTML = [
    ...(draft.result.lines || []).map((line) => {
      const review = reviews.get(line.item);
      const aiValue = `${line.quantity} ${line.unit || ""}`.trim();
      const shownValue = review?.verdict === "corrected" ? review.value : aiValue;
      return `<tr${line.status === "hold" ? ` class="review"` : ""}><td>${escapeHtml(line.item)}
        <small class="line-meta">${escapeHtml(takeoffLineMeta(line, review))}${line.hold_reason ? ` — ${escapeHtml(line.hold_reason)}` : ""}</small></td>
        <td>${escapeHtml(String(shownValue))}${correctedFrom(review, aiValue)}</td></tr>`;
    }),
    ...proposals.map((proposal) => {
      const review = reviews.get(proposal.question);
      const shownValue = review && review.verdict !== "kept_open" ? review.value : proposal.proposed;
      return `<tr><td>${escapeHtml(proposal.question)}
        <small class="line-meta">AI plan count · ${escapeHtml(proposal.confidence)} confidence · ${escapeHtml(proposal.basis)}${review && review.verdict !== "kept_open" ? ` · HUMAN_CONFIRMED by ${escapeHtml(review.reviewer_role)}` : " · proposed, not confirmed"}</small></td>
        <td>${escapeHtml(String(shownValue))}${correctedFrom(review, String(proposal.proposed))}</td></tr>`;
    }),
  ].join("");

  /* RFIs the product raised itself. Nothing here asks the owner to measure
     anything; the analysis continued without these answers. */
  const proposalQuestions = new Set(proposals.map((proposal) => proposal.question));
  const pureRfis = openGaps.filter((gap) => !proposalQuestions.has(gap));
  $("#takeoff-gaps").innerHTML = pureRfis.length
    ? `<p><strong>RFIs &amp; Holds — raised automatically (${pureRfis.length}):</strong></p>` +
      pureRfis.map((gap) => `<p>· ${escapeHtml(gap)} <em>OPEN_RFI</em></p>`).join("") +
      `<p class="clear">The analysis continues without these answers. Nothing above needs your measurement.</p>`
    : `<p class="clear">The plans answered everything the takeoff asked of them.</p>`;

  /* The expert layer. Only a qualified reviewer sees it, and only a
     line-by-line action here creates a human-confirmed value. */
  const expertRows = [
    ...(draft.result.lines || []).map((line) => ({ key: line.item, current: `${line.quantity} ${line.unit || ""}` })),
    ...proposals.map((proposal) => ({ key: proposal.question, current: proposal.proposed })),
  ];
  $("#takeoff-expert-lines").innerHTML = expertRows.map((row, index) => {
    const review = reviews.get(row.key);
    return `<div class="expert-line" data-line-key="${escapeHtml(row.key)}">
      <p>${escapeHtml(row.key)} — <strong>${escapeHtml(row.current)}</strong>${review ? ` <em>(${escapeHtml(review.verdict)} by ${escapeHtml(review.reviewer_role)})</em>` : ""}</p>
      <div class="expert-actions">
        <button class="button" type="button" data-verdict="confirmed">Confirm</button>
        <button class="button" type="button" data-verdict="corrected">Correct</button>
        <button class="button" type="button" data-verdict="kept_open">Keep open</button>
        <input class="expert-value" placeholder="Value you verified yourself" hidden />
      </div>
    </div>`;
  }).join("");
}

/* One expert action on one line. Confirm sends the shown value; Correct opens
   the input for the reviewer's own value; Keep open records the question. */
async function reviewTakeoffLine(lineKey, verdict, value) {
  if (state.busy) return;
  setBusy(true, "Recording the line review…");
  try {
    const { error } = await client.rpc("review_takeoff_line", {
      p_baseline_id: state.baseline.id,
      p_line_key: lineKey,
      p_verdict: verdict,
      p_value: value || null,
      p_note: null,
    });
    if (error) throw error;
    notify(verdict === "kept_open" ? "The line stays open, on the record." : "The line is human-confirmed, under your name and role.");
    await openProperty(state.property.id);
  } catch (error) {
    console.error(error);
    notify(error.message || "The review could not be recorded", "error");
  } finally {
    setBusy(false, `Cloud connected · ${state.role}`);
  }
}

$("#compare-readings")?.addEventListener("click", () => runComparison());
$("#attach-truth")?.addEventListener("click", () => $("#truth-file")?.click());
$("#truth-file")?.addEventListener("change", async (event) => {
  const [file] = event.target.files || [];
  event.target.value = "";
  await attachControlMarkup(file);
});
$("#takeoff-expert-lines")?.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-verdict]");
  if (!button) return;
  const row = button.closest(".expert-line");
  const key = row?.dataset.lineKey;
  if (!key) return;
  const verdict = button.dataset.verdict;
  const input = row.querySelector(".expert-value");
  if (verdict === "corrected") {
    if (input.hidden) { input.hidden = false; input.focus(); return; }
    const value = input.value.trim();
    if (!value) { notify("Enter the value you verified before correcting", "error"); return; }
    void reviewTakeoffLine(key, "corrected", value);
    return;
  }
  if (verdict === "confirmed") {
    const shown = row.querySelector("strong")?.textContent?.trim() || "";
    void reviewTakeoffLine(key, "confirmed", input && !input.hidden && input.value.trim() ? input.value.trim() : shown);
    return;
  }
  void reviewTakeoffLine(key, "kept_open", null);
});

$("#request-expert-review")?.addEventListener("click", (event) => {
  event.preventDefault();
  const url = `${window.location.origin}${window.location.pathname}?property=${state.property?.id || ""}`;
  const subject = encodeURIComponent(`Expert review requested · ${state.property?.name || "project"} wood takeoff`);
  const bodyText = encodeURIComponent(`Please review the AI takeoff line by line and confirm what you can verify:\n\n${url}\n\nOnly your line-level confirmation creates a human-confirmed value.`);
  window.location.href = `mailto:?subject=${subject}&body=${bodyText}`;
});

/* Accepting is the owner saying "work from this". It is OWNER_ACCEPTED_BASELINE
   on the record — never a technical confirmation of any line. */
async function approveTakeoff() {
  const draft = takeoffDraft();
  if (!draft || state.busy) return;
  const gaps = takeoffOpenGaps(draft);
  if (!window.confirm(`Accept this AI takeoff as the project's working baseline?\n\nThis records YOUR acceptance (OWNER_ACCEPTED_BASELINE) — it does not confirm any technical value, and you are not expected to check the plans yourself. ${gaps.length} open RFI${gaps.length === 1 ? "" : "s"} stay on the record; expert review can confirm lines later.`)) return;
  setBusy(true, "Recording the acceptance…");
  try {
    const { error } = await client.rpc("approve_material_takeoff", {
      p_baseline_id: state.baseline.id,
      p_kind: "wood_framing",
      p_lines: draft.result.lines,
      p_traces: draft.result.traces,
      p_gaps: gaps,
      p_measured_walls: draft.result.measuredWalls,
      p_calculator_version: TAKEOFF_CALCULATOR_VERSION,
      p_note: null,
      p_answers: [],
    });
    if (error) throw error;
    notify("Accepted as the working baseline. No line was marked human-confirmed.");
    await openProperty(state.property.id);
  } catch (error) {
    console.error(error);
    notify(error.message || "The acceptance could not be recorded", "error");
  } finally {
    setBusy(false, `Cloud connected · ${state.role}`);
  }
}

$("#approve-takeoff")?.addEventListener("click", approveTakeoff);

/* Two workbooks, two meanings.
   Download AI Takeoff: available the moment analysis finishes, no signature —
   the AI's complete result with provenance, confidence and status on every
   row. Download Human-Verified Order: exists only once a qualified reviewer
   has confirmed at least one line, and its first sheet carries only those. */
function takeoffStamp() {
  return String(state.baseline?.created_at || "").slice(0, 10) || "draft";
}

/* ── the material list, as a document ──────────────────────────────────────

   A spreadsheet is a working tool: any recipient can change a number and
   forward it, and no two machines render it the same way. The list a person
   signs, hands to a supplier, or files against a build is a document — fixed
   presentation, same on every screen, and awkward to alter quietly. The
   workbook stays for anyone who needs the rows as data; the record leaves as
   a PDF. */
/* Two columns, not four. The first draft squeezed method and unit into
   narrow columns and the writer trimmed them — "DERIVED_FROM_PRIN..." — which
   loses exactly the provenance the document exists to carry. The name and the
   quantity get the width they need; how the number was arrived at, and from
   which sheets, goes on its own line underneath where nothing is cut. */
function takeoffRow(item, quantity) {
  return {
    size: 9,
    cells: [
      { text: item, x: 0 },
      { text: quantity, x: 340, align: "right" },
    ],
  };
}

function takeoffColumnHeader() {
  return {
    size: 9,
    bold: true,
    cells: [
      { text: "Item", x: 0 },
      { text: "Quantity", x: 340, align: "right" },
    ],
  };
}

function aiTakeoffPdfLines(draft, propertyName) {
  const lines = draft.result.lines || [];
  const proposals = draft.result.proposals || [];
  const holds = lines.filter((line) => line.status === "hold");
  const openGaps = draft.result.gaps || [];
  const reviews = activeReviews();
  const confirmedCount = [...reviews.values()].filter((review) => review.verdict !== "kept_open").length;
  const out = [
    { text: "Measured Decision - AI Takeoff", size: 16, bold: true },
    { text: "Read by AI - not confirmed", size: 11, bold: true },
    { text: `Project: ${propertyName}`, size: 10 },
    { text: `Baseline analyzed ${takeoffStamp()} - calculator ${TAKEOFF_CALCULATOR_VERSION}`, size: 9 },
    { text: "Not a contractor's estimate: no waste, no cut optimisation, no scale measuring. Every row below carries its provenance - printed fact, plan count, or derived arithmetic.", size: 9, gap: 4 },
    { rule: true },
    { text: `${lines.length} quantities computed - ${holds.length} on HOLD - ${proposals.length} AI proposals awaiting review - ${openGaps.length} open RFIs - ${confirmedCount} human-confirmed`, size: 9 },
    { rule: true },
    takeoffColumnHeader(),
    { rule: true },
  ];
  for (const line of lines) {
    const review = reviews.get(line.item);
    const corrected = review?.verdict === "corrected";
    out.push(takeoffRow(
      line.item,
      corrected ? String(review.value) : `${line.quantity} ${line.unit || ""}`.trim(),
    ));
    const notes = [TAKEOFF_METHOD_LABELS[line.method] || "Derived from printed dimensions"];
    if ((line.source_refs || []).length) notes.push(`sheets ${(line.source_refs || []).join(", ")}`);
    if (line.category === "not_lumber") notes.push("not lumber - verification count");
    if (line.status === "hold") notes.push(`HOLD - do not procure${line.hold_reason ? `: ${line.hold_reason}` : ""}`);
    /* A corrected row keeps the reading it replaced, exactly as the screen
       does: the document must not be the one place the machine's error is
       hidden. */
    if (corrected) notes.push(`AI read ${line.quantity} ${line.unit || ""} - corrected by ${review.reviewer_role}`);
    else if (review) notes.push(`HUMAN_CONFIRMED by ${review.reviewer_role}`);
    if (notes.length) out.push({ text: notes.join(" - "), size: 8, indent: 10 });
  }
  if (proposals.length) {
    out.push({ rule: true }, { text: "AI proposals - not confirmed", size: 11, bold: true, gap: 6 });
    for (const proposal of proposals) {
      out.push(takeoffRow(proposal.question, String(proposal.proposed)));
      out.push({ text: `AI plan count - ${proposal.confidence} confidence - ${proposal.basis}`, size: 8, indent: 10 });
    }
  }
  if (openGaps.length) {
    out.push({ rule: true }, { text: "RFIs and holds - raised automatically", size: 11, bold: true, gap: 6 });
    for (const gap of openGaps) out.push({ text: `${gap} - OPEN_RFI, do not order`, size: 9, indent: 10 });
  }
  out.push({ rule: true }, { text: "Generated by Measured Decision. Accepting this takeoff records a working baseline; only line-by-line expert review creates a human-confirmed value.", size: 8 });
  return out;
}

function verifiedOrderPdfLines(draft, propertyName) {
  const reviews = activeReviews();
  const confirmed = [...reviews.entries()].filter(([, review]) => review.verdict !== "kept_open");
  const out = [
    { text: "Measured Decision - Human-Verified Order", size: 16, bold: true },
    { text: `Project: ${propertyName}`, size: 10 },
    { text: "Every row below was confirmed line-by-line by a qualified reviewer. Nothing else qualifies.", size: 9, gap: 4 },
    { rule: true },
    {
      size: 9,
      bold: true,
      cells: [
        { text: "Line", x: 0 },
        { text: "Confirmed value", x: 340, align: "right" },
      ],
    },
    { rule: true },
  ];
  for (const [key, review] of confirmed) {
    out.push(takeoffRow(key, review.value || ""));
    out.push({
      text: `HUMAN_CONFIRMED by ${review.reviewer_role} on ${String(review.reviewed_at || "").slice(0, 10)}`,
      size: 8,
      indent: 10,
    });
  }
  out.push({ rule: true }, { text: `${confirmed.length} line${confirmed.length === 1 ? "" : "s"} human-confirmed. Everything the AI proposed that no person has confirmed is in the AI Takeoff document, marked as proposed.`, size: 8 });
  return out;
}

function downloadPdf(lines, title, suffix) {
  const name = state.property?.name || "project";
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  const bytes = window.MDAIPdf360.buildPdf(lines, { title });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  link.download = `${suffix}-${slug}-${takeoffStamp()}.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 4000);
}

function aiTakeoffSheets(draft, propertyName) {
  const lines = draft.result.lines || [];
  const proposals = draft.result.proposals || [];
  const openGaps = takeoffOpenGaps(draft);
  const holds = lines.filter((line) => line.status === "hold");
  return [
    {
      name: "AI Takeoff Summary",
      widths: [64, 18],
      bold: [0, 5],
      rows: [
        ["Measured Decision · AI Takeoff — Read by AI · not confirmed"],
        [`Project: ${propertyName}`],
        [`Baseline analyzed ${takeoffStamp()} · calculator ${TAKEOFF_CALCULATOR_VERSION}`],
        ["Not a contractor's estimate: no waste, no cut optimisation, no scale measuring. Every row carries its provenance."],
        [],
        ["What the analysis holds", "Count"],
        ["Quantities computed", lines.length],
        ["— of them on HOLD", holds.length],
        ["AI proposals awaiting review", proposals.length],
        ["Open RFIs raised automatically", openGaps.length],
        ["Human-confirmed lines", [...activeReviews().values()].filter((review) => review.verdict !== "kept_open").length],
      ],
    },
    {
      name: "Detailed Quantities & Basis",
      widths: [58, 12, 12, 34, 12, 12, 12, 24, 48],
      bold: [0],
      rows: [
        ["Item", "Qty", "Unit", "Method", "Confidence", "Category", "Status", "Sources", "Unresolved issue"],
        ...lines.map((line) => [
          line.item, line.quantity, line.unit || "",
          line.method || "DERIVED_FROM_PRINTED_DIMENSIONS", "",
          line.category === "not_lumber" ? "Not lumber" : "Lumber",
          line.status === "hold" ? "HOLD — do not procure" : "Ready",
          (line.source_refs || []).join(", "), line.hold_reason || "",
        ]),
        ...proposals.map((proposal) => [
          proposal.question, proposal.proposed, "",
          "AI_PLAN_COUNT — proposed, not confirmed", proposal.confidence, "", "Awaiting review",
          "", proposal.basis,
        ]),
      ],
    },
    {
      name: "Sources & Arithmetic",
      widths: [28, 24, 90],
      bold: [0],
      rows: [
        ["Element", "Sheets cited", "Step"],
        ...(draft.result.traces || []).flatMap((trace) => (trace.steps || []).map((step, index) => [
          index === 0 ? trace.wall : "", index === 0 ? (trace.source_refs || []).join(", ") : "", step,
        ])),
      ],
    },
    {
      name: "RFIs & Holds",
      widths: [100, 26],
      bold: [0],
      rows: [
        ["Question / hold", "Status"],
        ...openGaps.map((gap) => [gap, "OPEN_RFI — do not order"]),
      ],
    },
  ];
}

function verifiedOrderSheets(draft, propertyName) {
  const reviews = activeReviews();
  const confirmed = [...reviews.entries()].filter(([, review]) => review.verdict !== "kept_open");
  const accepted = state.approvedTakeoff;
  const openGaps = takeoffOpenGaps(draft);
  return [
    {
      name: "Human-Verified Order",
      widths: [64, 20, 18, 22, 14],
      bold: [0, 4],
      rows: [
        ["Measured Decision · Human-Verified Order"],
        [`Project: ${propertyName}`],
        ["Every row below was confirmed line-by-line by a qualified reviewer. Nothing else qualifies."],
        [],
        ["Line", "Confirmed value", "Status", "Reviewer role", "Date"],
        ...confirmed.map(([key, review]) => [
          key, review.value || "", "HUMAN_CONFIRMED", review.reviewer_role,
          String(review.reviewed_at || "").slice(0, 10),
        ]),
      ],
    },
    {
      name: "AI Proposed · Not Confirmed",
      widths: [64, 16, 34, 26],
      bold: [0],
      rows: [
        ["Item", "Qty", "Method", "Standing"],
        ...(draft.result.lines || []).filter((line) => !reviews.has(line.item) || reviews.get(line.item).verdict === "kept_open").map((line) => [
          line.item, `${line.quantity} ${line.unit || ""}`,
          line.method || "DERIVED_FROM_PRINTED_DIMENSIONS",
          accepted ? "OWNER_ACCEPTED_BASELINE — not a technical confirmation" : "Read by AI · not confirmed",
        ]),
        ...(draft.result.proposals || []).filter((proposal) => !reviews.has(proposal.question) || reviews.get(proposal.question).verdict === "kept_open").map((proposal) => [
          proposal.question, proposal.proposed, `AI_PLAN_COUNT · ${proposal.confidence} confidence`, "Proposed, not confirmed",
        ]),
      ],
    },
    aiTakeoffSheets(draft, propertyName)[2],
    {
      name: "RFIs & Holds",
      widths: [100, 26],
      bold: [0],
      rows: [
        ["Question / hold", "Status"],
        ...openGaps.map((gap) => [gap, "OPEN_RFI — do not order"]),
      ],
    },
  ];
}

function downloadWorkbook(sheets, suffix) {
  const name = state.property?.name || "project";
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  const bytes = window.MDAIXlsx360.buildXlsx(sheets);
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  link.download = `${suffix}-${slug}-${takeoffStamp()}.xlsx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 4000);
}

$("#download-ai-takeoff")?.addEventListener("click", () => {
  const draft = takeoffDraft();
  if (!draft) return;
  const name = state.property?.name || "project";
  downloadPdf(aiTakeoffPdfLines(draft, name), `AI Takeoff - ${name}`, "ai-takeoff");
  notify("The AI takeoff is downloading as a document — no signature needed; every row carries its provenance.");
});

/* The same rows as data. Offered plainly rather than as the default: a
   supplier pasting quantities into their own system has a real need, and a
   spreadsheet serves it — but the artifact a person signs or forwards is the
   document, which nobody can quietly edit on the way. */
$("#download-ai-takeoff-xlsx")?.addEventListener("click", () => {
  const draft = takeoffDraft();
  if (!draft) return;
  downloadWorkbook(aiTakeoffSheets(draft, state.property?.name || "project"), "ai-takeoff-working-copy");
  notify("The working copy is downloading — a spreadsheet is data to work with, not the record.");
});

$("#download-takeoff")?.addEventListener("click", () => {
  const draft = takeoffDraft();
  if (!draft) return;
  const confirmed = [...activeReviews().values()].filter((review) => review.verdict !== "kept_open");
  if (!confirmed.length) { notify("Nothing is human-confirmed yet — that takes line-by-line expert review", "error"); return; }
  const name = state.property?.name || "project";
  downloadPdf(verifiedOrderPdfLines(draft, name), `Human-Verified Order - ${name}`, "verified-order");
  notify("The human-verified order is downloading as a document.");
});

/* The record leaves with its owner.
 *
 * One archive holds what this project knows and exactly how it knows it:
 * a provenance manifest (every document, room, reading and verdict, each
 * wearing its method and its confirmation state), the owner report as a
 * PDF anyone can open, and both takeoff workbooks. Everything is derived
 * from the record's own timestamps, so the same record exports the same
 * bytes — and nothing in the archive upgrades an AI reading into a fact. */
const RECORD_DOCTRINE =
  "Every AI reading in this record is Read by AI - not confirmed until a named person signs it. "
  + "Acceptance as a working baseline is an owner decision, never a technical confirmation. "
  + "A delivery document is never proof of installation. Absence of evidence is not evidence of absence.";

function recordStamp() {
  const stamps = [
    state.baseline?.created_at || "",
    ...state.documents.map((document) => document.created_at || ""),
    ...(state.takeoffReviews || []).map((review) => review.reviewed_at || ""),
    ...(state.reconciliations || []).map((row) => row.created_at || ""),
    state.approvedTakeoff?.approved_at || "",
  ].filter(Boolean).sort();
  return stamps[stamps.length - 1] || state.baseline?.created_at || "";
}

function recordManifest(draft, decisions) {
  const reviews = [...activeReviews().entries()];
  const evidenceByRoom = new Map();
  for (const item of state.projectEvidence || []) {
    const key = item.space_id || "";
    evidenceByRoom.set(key, (evidenceByRoom.get(key) || 0) + 1);
  }
  return {
    format: "measured-decision-project-record/1",
    doctrine: RECORD_DOCTRINE,
    project: { id: state.property?.id || "", name: state.property?.name || "" },
    record_as_of: recordStamp(),
    baseline: state.baseline ? {
      id: state.baseline.id,
      version: state.baseline.version,
      state: state.baseline.state,
      created_at: state.baseline.created_at,
      source_document_ids: state.baseline.source_document_ids || [],
    } : null,
    documents: state.documents.map((document) => ({
      id: document.id,
      filename: document.original_filename,
      discipline: document.document_type,
      revision: document.revision_label,
      bytes: document.byte_size,
      status: document.status,
      pages_read_by_ai: document.page_classification?.pages
        ? { provenance: "Read by AI - not confirmed", pages: document.page_classification.pages }
        : null,
    })),
    rooms: (state.projectRooms || []).map((room) => ({
      id: room.id,
      name: room.name,
      evidence_files: evidenceByRoom.get(room.id) || 0,
    })),
    takeoff: draft ? {
      calculator: TAKEOFF_CALCULATOR_VERSION,
      lines: (draft.result.lines || []).map((line) => ({
        item: line.item,
        quantity: line.quantity,
        unit: line.unit || "",
        method: line.method || "DERIVED_FROM_PRINTED_DIMENSIONS",
        category: line.category === "not_lumber" ? "not_lumber" : "lumber",
        status: line.status === "hold" ? "HOLD" : "ready",
        hold_reason: line.hold_reason || "",
        source_refs: line.source_refs || [],
      })),
      proposals: (draft.result.proposals || []).map((proposal) => ({
        question: proposal.question,
        proposed: proposal.proposed,
        confidence: proposal.confidence,
        basis: proposal.basis,
        provenance: "AI_PLAN_COUNT - proposed, not confirmed",
      })),
      open_rfis: takeoffOpenGaps(draft),
      human_reviews: reviews.map(([line, review]) => ({
        line,
        verdict: review.verdict,
        value: review.value || "",
        reviewer_role: review.reviewer_role,
        reviewed_at: review.reviewed_at,
        provenance: review.verdict === "kept_open" ? "kept open" : "HUMAN_CONFIRMED",
      })),
      owner_acceptance: state.approvedTakeoff ? {
        approved_at: state.approvedTakeoff.approved_at,
        provenance: "OWNER_ACCEPTED_BASELINE - not a technical confirmation",
      } : null,
    } : null,
    reconciliations: (state.reconciliations || []).map((row) => ({
      component: row.component_key,
      verdict: row.verdict,
      coverage: row.coverage,
      required: row.required_quantity,
      delivered_documented: row.delivered_quantity,
      visually_evidenced: row.evidenced_quantity,
      narrative: row.narrative,
    })),
    decisions: decisions || null,
  };
}

function ownerReportLines(manifest) {
  const lines = [
    { text: "Measured Decision - Project Record", size: 16, bold: true },
    { text: `Project: ${manifest.project.name}`, size: 11 },
    { text: `Record as of ${String(manifest.record_as_of).slice(0, 10)}`, size: 10 },
    { rule: true },
    { text: manifest.doctrine, size: 9 },
  ];
  if (manifest.decisions?.decisions?.length) {
    lines.push({ text: "Decision log", size: 12, bold: true, gap: 10 });
    for (const decision of manifest.decisions.decisions) {
      lines.push({ text: `${String(decision.at || "").slice(0, 10)} - ${decision.action} - ${decision.actor || ""}`, indent: 10 });
    }
  }
  if (manifest.takeoff) {
    const confirmed = manifest.takeoff.human_reviews.filter((review) => review.provenance === "HUMAN_CONFIRMED");
    lines.push({ text: "Takeoff", size: 12, bold: true, gap: 10 });
    lines.push({ text: `${manifest.takeoff.lines.length} quantities computed - ${manifest.takeoff.lines.filter((line) => line.status === "HOLD").length} on HOLD - ${manifest.takeoff.proposals.length} AI proposals awaiting review - ${manifest.takeoff.open_rfis.length} open RFIs - ${confirmed.length} human-confirmed lines`, indent: 10 });
    for (const line of manifest.takeoff.lines) {
      lines.push({ text: `${line.item}: ${line.quantity} ${line.unit} [${line.method}${line.status === "HOLD" ? " - HOLD" : ""}]`, indent: 10, size: 9 });
    }
    for (const rfi of manifest.takeoff.open_rfis) {
      lines.push({ text: `OPEN RFI: ${rfi}`, indent: 10, size: 9 });
    }
  }
  if (manifest.reconciliations.length) {
    lines.push({ text: "Reality vs documents", size: 12, bold: true, gap: 10 });
    for (const row of manifest.reconciliations) {
      lines.push({ text: `${row.component}: ${row.verdict} - ${row.narrative}`, indent: 10, size: 9 });
    }
  }
  lines.push({ text: "Rooms and evidence", size: 12, bold: true, gap: 10 });
  for (const room of manifest.rooms) {
    lines.push({ text: `${room.name}: ${room.evidence_files} evidence file${room.evidence_files === 1 ? "" : "s"}`, indent: 10, size: 9 });
  }
  lines.push({ rule: true });
  lines.push({ text: "Generated by Measured Decision. The manifest.json beside this report carries the same record in full, machine-readable, with provenance on every value.", size: 8 });
  return lines;
}

async function buildRecordParts() {
  const draft = takeoffDraft();
  /* The decision log requires a role that holds it; export never fails on
     that — it says so in the manifest instead. */
  let decisions = null;
  try {
    const { data, error } = await client.rpc("owner_report_data", { p_property_id: state.property.id });
    if (!error && data) decisions = data;
  } catch { /* stays null, named below */ }
  const manifest = recordManifest(draft, decisions);
  if (!decisions) {
    manifest.decisions = { note: "The decision log is available to owner, admin, reviewer and project manager roles; this export was made without it." };
  }
  const parts = [
    { path: "README.txt", content: [
      "Measured Decision - Project Record",
      `Project: ${manifest.project.name}`,
      `Record as of: ${manifest.record_as_of}`,
      "",
      RECORD_DOCTRINE,
      "",
      "owner-report.pdf - the record, readable",
      "manifest.json - the record, machine-readable, provenance on every value",
      draft ? "ai-takeoff.pdf - the AI takeoff as a document (Read by AI - not confirmed)" : "",
      draft && manifest.takeoff.human_reviews.some((review) => review.provenance === "HUMAN_CONFIRMED")
        ? "human-verified-order.pdf - only line-by-line confirmed rows, as a document" : "",
      draft ? "working-copies/ - the same rows as spreadsheets, for working with, not for signing" : "",
    ].filter(Boolean).join("\n") },
    { path: "manifest.json", content: JSON.stringify(manifest, null, 2) },
    { path: "owner-report.pdf", content: window.MDAIPdf360.buildPdf(ownerReportLines(manifest), { title: `Project Record - ${manifest.project.name}` }) },
  ];
  if (draft) {
    const projectName = state.property?.name || "project";
    parts.push({ path: "ai-takeoff.pdf", content: window.MDAIPdf360.buildPdf(aiTakeoffPdfLines(draft, projectName), { title: `AI Takeoff - ${projectName}` }) });
    parts.push({ path: "working-copies/ai-takeoff.xlsx", content: window.MDAIXlsx360.buildXlsx(aiTakeoffSheets(draft, projectName)) });
    if (manifest.takeoff.human_reviews.some((review) => review.provenance === "HUMAN_CONFIRMED")) {
      parts.push({ path: "human-verified-order.pdf", content: window.MDAIPdf360.buildPdf(verifiedOrderPdfLines(draft, projectName), { title: `Human-Verified Order - ${projectName}` }) });
      parts.push({ path: "working-copies/human-verified-order.xlsx", content: window.MDAIXlsx360.buildXlsx(verifiedOrderSheets(draft, projectName)) });
    }
  }
  return parts;
}

async function exportProjectRecord() {
  if (!state.property) return;
  const parts = await buildRecordParts();
  const bytes = window.MDAIXlsx360.buildZip(parts);
  const slug = (state.property?.name || "project").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
  link.download = `project-record-${slug}-${String(recordStamp()).slice(0, 10) || "draft"}.zip`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 4000);
  notify("The project record is downloading — the manifest carries provenance on every value.");
}
window.__recordParts = buildRecordParts;

$("#export-record")?.addEventListener("click", () => { void exportProjectRecord(); });

/* Level 1: the owner summary.
 *
 * A nine-sheet deck produced screens of dense cards; the owner could not
 * find the answer. This view answers the six questions in thirty seconds —
 * what was analyzed, the principal result, whether to proceed, the top
 * risks, the next action, where the download is — and everything deeper
 * lives one click away behind "View full analysis". Project size grows the
 * drill-down, never this screen: eight preview rows and three issues,
 * whether the set is nine sheets or nine hundred. */
const SUMMARY_STATUS = { ready: "Ready", hold: "Hold" };

function summaryDecision(draft, blockers, rfiCount, holdCount) {
  if (blockers > 0) return {
    label: "Blocked — clarification required",
    tone: "blocked",
    why: `${blockers} question${blockers === 1 ? "" : "s"} block${blockers === 1 ? "s" : ""} the baseline; the rest of the analysis is ready behind it.`,
  };
  if (rfiCount > 0 || holdCount > 0) return {
    label: "Proceed with conditions",
    tone: "conditions",
    why: `The plans support a preliminary takeoff; ${rfiCount} question${rfiCount === 1 ? "" : "s"} stay${rfiCount === 1 ? "s" : ""} open as RFIs${holdCount ? ` and ${holdCount} line${holdCount === 1 ? " is" : "s are"} on hold` : ""}. No action is needed from you to continue.`,
  };
  return {
    label: "Ready for next phase",
    tone: "ready",
    why: "The analyzed sheets answered everything the takeoff asked of them.",
  };
}

function renderOwnerSummary() {
  const section = $("#owner-summary");
  if (!section) return;
  const draft = takeoffDraft();
  const counts = state.baseline ? readingCounts() : { rows: 0, byKind: [], framing: 0, foundation: 0 };
  /* A reading with anything to show — framing lines or scheduled rows —
     has a summary. A reading with neither has nothing to summarize. */
  const hasAnalysis = Boolean(state.baseline) && (Boolean(draft) || counts.rows > 0);
  section.hidden = !hasAnalysis;
  /* A door to a summary that cannot exist is a dead control: the back
     button only stands when there is a summary to go back to. */
  const navSummary = $("#nav-summary");
  if (navSummary) navSummary.hidden = !hasAnalysis;
  if (!hasAnalysis) {
    document.body.classList.remove("summary-mode");
    /* A plan set that yields no takeoff still has a reality side — rooms,
       capture coverage, what the AI has read, the comparison once
       requirements exist. An architectural set used to hide the whole
       channel because the takeoff-shaped summary could not render; only
       the summary stays away now. */
    if (!state.baseline) {
      document.body.classList.remove("view-visual");
      $("#channel-nav").hidden = true;
      $("#visual-panel").hidden = true;
      return;
    }
    applyChannelView();
    if (state.channelView === "visual") renderVisualPanel();
    return;
  }
  applyChannelView();
  if (state.channelView === "visual") renderVisualPanel();

  const gaps = draft ? takeoffOpenGaps(draft) : [];
  const proposals = draft?.result?.proposals || [];
  const lines = draft?.result?.lines || [];
  const holds = lines.filter((line) => line.status === "hold");
  const download = $("#summary-download");
  if (download) download.hidden = !draft;
  const viewAll = $("#summary-view-takeoff");
  if (viewAll) viewAll.textContent = draft ? "View full takeoff →" : "View everything the plans state →";
  const rfis = $("#summary-rfis");
  if (rfis) rfis.textContent = draft ? "View RFIs" : "View all questions";
  let blockers = 0;
  try {
    if (state.baseline.state !== "approved") blockers = blockingBaselineGaps().length;
  } catch { blockers = 0; }

  $("#summary-title").textContent = `${state.property?.name || "Project"} — analysis complete`;
  const decision = summaryDecision(draft, blockers, gaps.length, holds.length);
  const decisionEl = $("#summary-decision");
  decisionEl.textContent = decision.label;
  decisionEl.className = `summary-decision ${decision.tone}`;
  $("#summary-why").textContent = decision.why;
  $("#summary-eyebrow").textContent = `Analysis complete · plan set v${state.baseline.version || 1} · ${String(state.baseline.created_at || "").slice(0, 10)}`;

  /* What the plans state, in one line, each kind a door to its section. */
  const read = $("#summary-read");
  if (read) {
    const kinds = counts.byKind.map((entry) => `<button type="button" data-summary-open="${escapeHtml(entry.category)}">${escapeHtml(entry.title)} ${entry.count}</button>`);
    const structural = counts.framing || counts.foundation
      ? `<button type="button" data-summary-open="framing">Structural framing ${counts.framing}</button><button type="button" data-summary-open="foundation">Foundation ${counts.foundation}</button>`
      : `<span class="not-read">Structural framing and foundation: not yet read as a schedule</span>`;
    read.hidden = !kinds.length && !lines.length;
    read.innerHTML = `${kinds.join("")}${structural}`;
    read.querySelectorAll("[data-summary-open]").forEach((button) => {
      button.addEventListener("click", () => {
        exitSummaryMode("#baseline-section", "technical");
        const target = document.querySelector(`[data-result-section="${button.dataset.summaryOpen}"]`);
        if (target) { target.open = true; target.scrollIntoView({ behavior: "smooth", block: "start" }); }
      });
    });
  }

  /* The one next action the comparison is actually waiting for: captured
     rooms nobody has read contribute nothing to the installed side, and
     the summary says so with the door instead of starving quietly. */
  const readSpaceIds = state.readSpaceIds || new Set();
  const unreadCount = (state.projectRooms || []).filter((room) =>
    (state.projectEvidence || []).some((item) => item.space_id === room.id)
    && !readSpaceIds.has(room.id)).length;
  const summaryUnread = $("#summary-unread");
  if (summaryUnread) {
    summaryUnread.hidden = unreadCount === 0;
    summaryUnread.innerHTML = unreadCount
      ? `Next: ${unreadCount} room${unreadCount === 1 ? " holds" : "s hold"} captures the AI has not read yet — <a href="../?property=${encodeURIComponent(state.property?.id || "")}&stage=read">read them in Studio →</a> and the installed side of the comparison fills itself.`
      : "";
  }

  /* Five numbers, no more. Counted from the record, like everything here. */
  const sheetCount = Array.isArray(state.baseline.source_document_ids) ? state.baseline.source_document_ids.length : 0;
  const deckArea = (state.baseline.analysis?.framing_decks || [])
    .map((deck) => window.MDAITakeoff360.parsePrintedNumber?.(deck.area_sqft))
    .find((value) => value > 0);
  const principal = [...lines].sort((a, b) => (b.quantity || 0) - (a.quantity || 0))[0];
  const numbers = [
    { value: sheetCount, label: `plan sheet${sheetCount === 1 ? "" : "s"} analyzed` },
    counts.rows ? { value: counts.rows, label: "scheduled items read" } : null,
    deckArea ? { value: deckArea.toLocaleString("en-US"), label: "sf printed area" } : null,
    principal ? { value: `${principal.quantity.toLocaleString("en-US")} ${principal.unit || ""}`.trim(), label: principal.item.split(" — ")[0].slice(0, 34) } : null,
    { value: gaps.length, label: "open RFIs" },
    { value: holds.length + blockers, label: "critical issues" },
  ].filter(Boolean).slice(0, 5);
  $("#summary-numbers").innerHTML = numbers.map((entry) =>
    `<article><strong>${escapeHtml(String(entry.value))}</strong><small>${escapeHtml(entry.label)}</small></article>`).join("");

  /* Eight rows of preview: computed lines first, proposals as Verify. */
  const reviews = activeReviews();
  const previewRows = [
    ...lines.map((line) => ({
      item: line.item.split(" — ")[0],
      qty: `${line.quantity} ${line.unit || ""}`.trim(),
      basis: (TAKEOFF_METHOD_LABELS[line.method] || "Derived").replace(" — field verify", ""),
      status: reviews.get(line.item)?.verdict === "confirmed" || reviews.get(line.item)?.verdict === "corrected"
        ? "Confirmed" : SUMMARY_STATUS[line.status] || "Ready",
    })),
    ...proposals.map((proposal) => ({
      item: proposal.proposed,
      qty: "",
      basis: `AI plan count · ${proposal.confidence}`,
      status: "Verify",
    })),
    /* With no framing lines, the preview is the schedule: the first rows
       the set prints, with the same four words for how. */
    ...(lines.length || proposals.length ? [] : (state.baseline.analysis?.component_schedules || []).map((row) => {
      const prov = scheduleProvenance(row);
      const kind = (RESULT_SECTIONS.find((entry) => entry.category === (row.category || "other"))?.title || "Item").replace(/s$/, "").replace(/ and electrical$/, "");
      return {
        item: `${kind} ${row.mark || ""} — ${String(row.description || "").split(";")[0]}`.trim().slice(0, 56),
        qty: prov.quantity === null ? "" : `${prov.quantity} ${row.unit || "each"}`,
        basis: prov.label.replace(/ · .*$/, ""),
        status: prov.kind === "unknown" ? "Verify" : "Ready",
      };
    })),
  ].slice(0, 8);
  $("#summary-table tbody").innerHTML = previewRows.map((row) =>
    `<tr><td>${escapeHtml(row.item)}</td><td>${escapeHtml(row.qty)}</td><td>${escapeHtml(row.basis)}</td><td><span class="summary-chip ${escapeHtml(row.status.toLowerCase())}">${escapeHtml(row.status)}</span></td></tr>`).join("");

  /* Three issues: reconciliation discrepancies first (reality disagreeing
     with the documents outranks paperwork), then holds, then RFIs. */
  const RECON_SEVERITY = { CONFLICTING: 0, PARTIALLY_SUPPORTED: 1 };
  const discrepancies = (state.reconciliations || [])
    .filter((entry) => entry.verdict in RECON_SEVERITY)
    .sort((a, b) => RECON_SEVERITY[a.verdict] - RECON_SEVERITY[b.verdict])
    .map((entry) => ({ title: entry.component_key, impact: entry.narrative, status: entry.verdict === "CONFLICTING" ? "Conflict" : entry.verdict === "NOT_EVIDENCED" ? "RFI" : "Verify" }));
  /* A reading's question, as an issue: its first sentence as the title,
     the rest and its sheets as the impact — never the same words twice. */
  const readingQuestions = settleFirst(Array.isArray(state.baseline.gaps) ? state.baseline.gaps : [])
    .map((gap) => {
      const [first, ...rest] = String(gap.question || "").split(/(?<=[.?!])\s+/);
      const refs = (gap.source_refs || []).slice(0, 2).join(" · ");
      return { title: first.slice(0, 90), impact: [rest.join(" "), refs].filter(Boolean).join(" — ") || "Blocks activation until a person answers.", status: "RFI" };
    });
  const issues = [
    ...discrepancies,
    ...holds.map((line) => ({ title: line.item.split(" — ")[0], impact: line.hold_reason || "On hold before procurement.", status: "Hold" })),
    ...(state.baseline.state === "approved" ? [] : readingQuestions),
    ...gaps.filter((gap) => !/^.*HOLD — /.test(gap)).map((gap) => {
      const [head, ...rest] = gap.split(": ");
      return { title: rest.length ? rest.join(": ").split(" is scheduled")[0].split(" — ")[0].slice(0, 60) : head.slice(0, 60), impact: gap, status: "RFI" };
    }),
  ].slice(0, 3);
  $("#summary-issues").innerHTML = issues.length
    ? issues.map((issue) => `<div class="summary-issue"><p><strong>${escapeHtml(issue.title)}</strong> <span class="summary-chip ${issue.status.toLowerCase()}">${escapeHtml(issue.status)}</span></p><small>${escapeHtml(issue.impact)}</small></div>`).join("")
    : `<p class="summary-clear">No open issues — the sheets answered everything asked of them.</p>`;
}

/* Level 2 is one project database seen through two channels. The switcher
   changes the view, never the data: Technical Intelligence is the plan-side
   workspace, Visual Evidence is the reality side. */
function applyChannelView() {
  const summary = state.summaryMode !== false && Boolean($("#owner-summary")) && !$("#owner-summary").hidden;
  document.body.classList.toggle("summary-mode", summary);
  document.body.classList.toggle("view-visual", !summary && state.channelView === "visual");
  $("#channel-nav").hidden = summary;
  $("#visual-panel").hidden = summary || state.channelView !== "visual";
}

function exitSummaryMode(scrollTo, view = "technical") {
  state.summaryMode = false;
  state.channelView = view;
  applyChannelView();
  if (view === "visual") renderVisualPanel();
  if (scrollTo) document.querySelector(scrollTo)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderVisualPanel() {
  const rooms = state.projectRooms || [];
  const byRoom = new Map();
  for (const item of state.projectEvidence || []) {
    if (!item.space_id) continue;
    const bucket = byRoom.get(item.space_id) || { count: 0, spatial: false };
    bucket.count += 1;
    if (/360|insv|spatial/i.test(item.media_type || "")) bucket.spatial = true;
    byRoom.set(item.space_id, bucket);
  }
  const readSpaceIds = state.readSpaceIds || new Set();
  $("#visual-rooms tbody").innerHTML = rooms.length
    ? rooms.map((room) => {
        const bucket = byRoom.get(room.id) || { count: 0, spatial: false };
        const readCell = bucket.count === 0
          ? "—"
          : readSpaceIds.has(room.id) ? "✓" : "<span class='summary-chip verify'>not read</span>";
        return `<tr><td>${escapeHtml(room.name)}</td><td>${bucket.count} file${bucket.count === 1 ? "" : "s"}</td><td>${bucket.spatial ? "✓" : "<span class='summary-chip rfi'>none</span>"}</td><td>${readCell}</td></tr>`;
      }).join("")
    : `<tr><td colspan="4">No rooms in the record yet — evidence uploads create them.</td></tr>`;
  /* The unread captures point at their door. Reading a room is a person's
     click (a copilot run, never silent spending) — but the click has to be
     findable from the screen that is starving without it. */
  const unreadRooms = rooms.filter((room) => (byRoom.get(room.id)?.count || 0) > 0 && !readSpaceIds.has(room.id));
  const unread = $("#visual-unread");
  if (unread) {
    unread.hidden = unreadRooms.length === 0;
    unread.innerHTML = unreadRooms.length
      ? `${unreadRooms.length} room${unreadRooms.length === 1 ? " holds" : "s hold"} captures nobody has read yet — reading them lets the AI count installed components into this comparison. <a class="button" href="../?property=${encodeURIComponent(state.property?.id || "")}&stage=read">Read rooms in Studio →</a>`
      : "";
  }
  /* The comparison is numbers, not a caption: required is what the plans
     state, delivered is what paperwork documents, installed is what capture
     shows. A dash is an honest empty — no record — never a zero. */
  const quantity = (value) => (value === null || value === undefined ? "—" : Number(value).toLocaleString("en-US"));
  const recon = state.reconciliations || [];
  $("#visual-recon tbody").innerHTML = recon.length
    ? recon.map((entry) => `<tr><td>${escapeHtml(entry.component_key)}<small class="line-meta">${escapeHtml(entry.narrative)}</small></td><td class="qty">${quantity(entry.required_quantity)}</td><td class="qty">${quantity(entry.delivered_quantity)}</td><td class="qty">${quantity(entry.evidenced_quantity)}</td><td><span class="summary-chip ${entry.verdict === "SUPPORTED" ? "ready" : entry.verdict === "CONFLICTING" ? "hold" : "verify"}">${escapeHtml(entry.verdict)}</span></td></tr>`).join("")
    : `<tr><td colspan="5">No comparison yet — the required side comes from the plans, and nothing countable has been distilled from this plan set so far.</td></tr>`;
}

$("#summary-download")?.addEventListener("click", () => $("#download-ai-takeoff")?.click());
$("#summary-visual")?.addEventListener("click", () => exitSummaryMode("#visual-panel", "visual"));
$("#summary-full")?.addEventListener("click", () => exitSummaryMode("#takeoff-section", "technical"));
$("#reader-provider")?.addEventListener("change", (event) => {
  state.reader.provider = event.target.value;
  state.reader.model = null;
  renderReaderPicker();
  updateAnalyzeAction({ updateMessage: true });
});
$("#reader-model")?.addEventListener("change", (event) => {
  state.reader.model = event.target.value;
  renderReaderPicker();
  updateAnalyzeAction({ updateMessage: true });
});
$("#summary-rfis")?.addEventListener("click", () => {
  if (takeoffDraft()) { exitSummaryMode("#takeoff-gaps", "technical"); return; }
  exitSummaryMode("#baseline-section", "technical");
  const audit = document.getElementById("result-audit");
  if (audit) { audit.open = true; audit.scrollIntoView({ behavior: "smooth", block: "start" }); }
});
$("#summary-view-takeoff")?.addEventListener("click", (event) => {
  event.preventDefault();
  exitSummaryMode(takeoffDraft() ? "#takeoff-section" : "#baseline-section", "technical");
});
$("#summary-all-rfis")?.addEventListener("click", (event) => { event.preventDefault(); exitSummaryMode("#takeoff-gaps", "technical"); });
$("#nav-summary")?.addEventListener("click", () => { state.summaryMode = true; applyChannelView(); window.scrollTo({ top: 0, behavior: "smooth" }); });
$("#visual-refresh")?.addEventListener("click", async () => {
  if (state.busy) return;
  setBusy(true, "Reconciling requirement against evidence…");
  try {
    const { error } = await client.rpc("reconcile_project", { p_property_id: state.property.id });
    if (error) throw error;
    notify("Reconciliation refreshed from the record.");
    await openProperty(state.property.id);
    exitSummaryMode("#visual-panel", "visual");
  } catch (error) {
    console.error(error);
    notify(error.message || "Reconciliation could not run", "error");
  } finally {
    setBusy(false, `Cloud connected · ${state.role}`);
  }
});
$("#nav-visual")?.addEventListener("click", () => exitSummaryMode("#visual-panel", "visual"));
$("#nav-technical")?.addEventListener("click", () => exitSummaryMode("#takeoff-section", "technical"));

if (typeof window !== "undefined") {
  window.__aiTakeoffSheets = () => { const draft = takeoffDraft(); return draft ? aiTakeoffSheets(draft, state.property?.name || "project") : null; };
  window.__verifiedSheets = () => { const draft = takeoffDraft(); return draft ? verifiedOrderSheets(draft, state.property?.name || "project") : null; };
}

/* The roadmap shown here and the roadmap the field is running can be different
   versions. Saying so is the difference between "nothing works" and "approve
   this one first". */
function renderRoadmapDivergence() {
  const banner = $("#roadmap-divergence");
  if (!banner) return;
  const active = state.activeBaseline;
  const shown = state.baseline;
  const newest = state.baselines?.[0] || null;
  const approveButton = $("#divergence-approve");
  const openButton = $("#divergence-open-active");
  if (!shown || !active) {
    banner.hidden = true;
    return;
  }

  const approvedOn = active.approved_at
    ? new Date(active.approved_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "an earlier date";
  const notApprovedCopy = {
    draft: "is still a draft",
    review: "is still under review",
    superseded: "was superseded",
  };

  if (shown.id !== active.id) {
    banner.hidden = false;
    openButton.hidden = false;
    openButton.textContent = `Open v${active.version}, the live roadmap`;
    openButton.dataset.baseline = active.id;

    /* A superseded roadmap is history. It cannot be approved again, and its
       tasks must not be dispatched — the plan they describe was replaced. */
    if (shown.state === "superseded") {
      $("#divergence-eyebrow").textContent = "Replaced roadmap";
      $("#divergence-title").textContent = `v${shown.version} was replaced by v${active.version}.`;
      $("#divergence-copy").textContent =
        `You are reading a roadmap that is no longer governing. v${active.version} was approved on ${approvedOn} and is what the field runs, ` +
        `so tasks here cannot be sent — a worker would capture against a plan that has been superseded.`;
      approveButton.hidden = true;
      return;
    }

    $("#divergence-eyebrow").textContent = "Two roadmaps";
    $("#divergence-title").textContent = `You are reading v${shown.version}. Field Operations is running v${active.version}.`;
    $("#divergence-copy").textContent =
      `v${shown.version} ${notApprovedCopy[shown.state] || "has not been approved"}, so its capture tasks stay blocked and cannot be sent. ` +
      `v${active.version} was approved on ${approvedOn}, and its tasks are the ones a worker can receive today. ` +
      `Approving v${shown.version} replaces v${active.version} and unblocks the tasks you see here.`;
    approveButton.hidden = !canApproveBaseline() || shown.state === "approved";
    approveButton.textContent = `Approve v${shown.version} & replace v${active.version}`;
    return;
  }

  /* The live roadmap is on screen, but a newer analysis may be sitting
     unapproved. Nothing is broken here — it just needs a decision. */
  if (newest && newest.id !== active.id && newest.state !== "superseded") {
    banner.hidden = false;
    $("#divergence-eyebrow").textContent = "Live roadmap";
    $("#divergence-title").textContent = `You are reading v${active.version}, the roadmap the field is running.`;
    $("#divergence-copy").textContent =
      `Its tasks can be sent. A newer baseline, v${newest.version}, ${notApprovedCopy[newest.state] || "has not been approved"} and its tasks stay blocked until someone approves it.`;
    approveButton.hidden = true;
    openButton.hidden = false;
    openButton.textContent = `Review v${newest.version}`;
    openButton.dataset.baseline = newest.id;
    return;
  }

  banner.hidden = true;
}

/* A disabled button that never says why is the reason a person gives up on a
   screen. Every refusal to send has to name itself. */
function sendBlockedReason(task) {
  if (!canApproveBaseline()) return "Your role cannot send field tasks. An owner, admin, or reviewer can send this one.";
  if (!task?.id) return "This capture task does not exist in the current baseline.";
  /* Only the governing roadmap may be dispatched. A ready task on a replaced
     baseline still looks sendable, and sending it puts a worker in front of a
     requirement the project has already moved past. */
  const active = state.activeBaseline;
  if (active && state.baseline && state.baseline.id !== active.id) {
    return `This roadmap is not the one the field is running. v${active.version} is governing — open it to send its tasks.`;
  }
  if (task.status === "blocked") {
    return state.baseline?.state === "approved"
      ? "This task is blocked in the approved baseline."
      : `Baseline v${state.baseline?.version || "?"} has not been approved, so every task in it is blocked. Approve the baseline to activate these tasks.`;
  }
  if (task.status === "waived") return "This capture was waived, so no worker is sent to it.";
  if (task.status === "submitted") return "A worker already submitted this capture. It is waiting for review.";
  if (task.status === "verified") return "This capture is verified. Nothing more is needed.";
  return "";
}

/* The result first.
 *
 * A reading of a plan set produces two things: what the sheets state, and
 * what the reader could not settle. The screen used to lead with the
 * second — a column of the reader's own questions, in the reader's own
 * words — and the doors, windows and fixtures it had copied from the
 * schedules were nowhere on it. Now the sections come first, one per kind
 * of thing the plans schedule, each row with its mark, its printed
 * description, its quantity, its unit, where it came from, and a word for
 * how the quantity was arrived at. Every question the reading raised is
 * still here, all of it, under one disclosure. */

/* How a scheduled row's quantity was arrived at. Four words, in the order
   a buyer trusts them: printed on a schedule, counted on the plan, proposed
   by the reader with a stated confidence, or not determinable. Nothing
   here is measured by scale. */
function scheduleProvenance(row) {
  const scheduled = Number(row.count_scheduled || 0);
  const drawn = Number(row.count_drawn || 0);
  const proposed = Number(row.count_proposed || 0);
  if (scheduled > 0) return { kind: "printed", label: "Printed quantity", quantity: scheduled };
  if (drawn > 0) return { kind: "counted", label: "Counted on plan", quantity: drawn };
  if (proposed > 0) return { kind: "proposed", label: `Proposed · ${row.count_confidence || "low"} confidence`, quantity: proposed };
  return { kind: "unknown", label: "Not determinable", quantity: null };
}

/* How a takeoff line's quantity was arrived at — the calculator's own
   method words, in the same four classes plus the two a person adds. */
function methodProvenance(method) {
  switch (method) {
    case "PRINTED_FACT": return { kind: "printed", label: "Printed" };
    case "AI_PLAN_COUNT": return { kind: "counted", label: "Counted on plan" };
    case "DERIVED_FROM_PRINTED_DIMENSIONS": return { kind: "calculated", label: "Calculated from printed dimensions" };
    case "ESTIMATOR_ALLOWANCE": return { kind: "assumption", label: "Purchasing allowance" };
    case "AI_SCALED_ESTIMATE": return { kind: "assumption", label: "Scaled estimate · field verify" };
    case "HUMAN_CONFIRMED": return { kind: "printed", label: "Confirmed by a person" };
    default: return { kind: "unknown", label: "Not determinable" };
  }
}

/* A source reference the reader wrote — "A-710 (original p20), Door
   Schedule" — read for the sheet and the page it names. */
function parseSourceRef(ref) {
  const text = String(ref || "");
  const page = Number((text.match(/original\s+p(?:age\s*)?(\d+)/i) || [])[1] || 0);
  const sheet = (text.match(/^([A-Z]{1,3}-?\d[\w./-]*)/i) || [])[1] || "";
  return { text, page, sheet };
}

/* Which document holds an original page — a part of a split file, by its
   page range, or the whole file when it was never split. */
function documentForPage(page) {
  if (!page) return null;
  const part = state.documents.find((doc) => {
    const range = partOf(doc);
    return range && Number(range.page_from) <= page && page <= Number(range.page_to);
  });
  if (part) return { document: part, pageInFile: page - Number(partOf(part).page_from) + 1 };
  const whole = state.documents.find((doc) => !partOf(doc) && !isPaperworkDocument(doc) && !partsOf(doc).length);
  return whole ? { document: whole, pageInFile: page } : null;
}

/* Three questions, first, by a rule that is written on the screen: the
   first critical questions that block activation, then the first
   important ones, never one the reading itself marked as answered by
   another chunk. */
function settleFirst(gaps, limit = 3) {
  const open = gaps.filter((gap) => gap && gap.blocks_activation === true && !gap.read_in_chunk);
  const critical = open.filter((gap) => gap.severity === "critical");
  const important = open.filter((gap) => gap.severity === "important");
  return [...critical, ...important].slice(0, limit);
}

/* The rows of one result section, from the schedule rows of the analysis. */
function resultSectionRows(analysis, category) {
  const rows = Array.isArray(analysis?.component_schedules) ? analysis.component_schedules : [];
  return rows.filter((row) => (row.category || "other") === category);
}

function sourceRefCell(refs) {
  const list = Array.isArray(refs) ? refs : [];
  if (!list.length) return '<span class="result-no-source">Not cited</span>';
  return list.map((ref) => {
    const parsed = parseSourceRef(ref);
    const where = documentForPage(parsed.page);
    const text = parsed.sheet ? `${parsed.sheet}${parsed.page ? ` · p${parsed.page}` : ""}` : (parsed.page ? `p${parsed.page}` : parsed.text.slice(0, 40));
    return where
      ? `<button class="source-link" type="button" data-open-sheet="${escapeHtml(where.document.id)}" data-open-page="${where.pageInFile}" title="${escapeHtml(parsed.text)}">${escapeHtml(text)}</button>`
      : `<span title="${escapeHtml(parsed.text)}">${escapeHtml(text)}</span>`;
  }).join(", ");
}

function renderScheduleTable(rows) {
  return `<div class="result-table-wrap"><table class="result-table">
    <thead><tr><th>Mark</th><th>Description</th><th>Qty</th><th>Unit</th><th>How</th><th>Source</th></tr></thead>
    <tbody>${rows.map((row) => {
      const prov = scheduleProvenance(row);
      return `<tr data-mark="${escapeHtml(row.mark || "")}">
        <td class="mark">${escapeHtml(row.mark || "—")}</td>
        <td>${escapeHtml(row.description || "")}${row.count_note ? `<small class="line-meta">${escapeHtml(row.count_note)}</small>` : ""}</td>
        <td class="qty">${prov.quantity === null ? "—" : prov.quantity}</td>
        <td>${escapeHtml(row.unit || "each")}</td>
        <td><span class="prov ${prov.kind}">${escapeHtml(prov.label)}</span></td>
        <td>${sourceRefCell(row.source_refs)}</td>
      </tr>`;
    }).join("")}</tbody></table></div>`;
}

/* Framing and foundation, from the deterministic takeoff the calculator
   already draws — scheduled members and printed dimensions — or an honest
   sentence when this reading had no field for them. */
const MEMBER_WORDS = {
  beam: "beam", header: "header", joist: "joist", rafter: "rafter", ridge: "ridge beam", post: "post", column: "column",
  stud: "stud", blocking: "blocking", ledger: "ledger", strap: "strap", holdown: "hold-down", anchor: "anchor",
  shear_wall: "shear wall", footing: "footing", grade_beam: "grade beam", pier: "pier", slab: "slab", other: "member",
};
/* Every scheduled member the reader recorded, as a row — a printed
   quantity, a count made on the plan, a proposal with its confidence, or
   nothing determinable — with its sheets and the detail it points to. A
   member whose count could not be read is still a member the plans
   schedule; hiding it would say the plans do not. */
function renderMemberTable(members) {
  return `<div class="result-table-wrap"><table class="result-table">
    <thead><tr><th>Mark</th><th>Member</th><th>Qty</th><th>Unit</th><th>How</th><th>Source</th></tr></thead>
    <tbody>${members.map((member) => {
      const prov = scheduleProvenance(member);
      const word = MEMBER_WORDS[member.member_type] || "member";
      const where = [member.level, member.location].filter(Boolean).join(" · ");
      return `<tr data-mark="${escapeHtml(member.mark || "")}">
        <td class="mark">${escapeHtml(member.mark || "—")}</td>
        <td>${escapeHtml(word)} · ${escapeHtml(member.description || "")}${where ? `<small class="line-meta">${escapeHtml(where)}</small>` : ""}${member.count_note ? `<small class="line-meta">${escapeHtml(member.count_note)}</small>` : ""}</td>
        <td class="qty">${prov.quantity === null ? "—" : prov.quantity}</td>
        <td>${escapeHtml(member.unit || "each")}</td>
        <td><span class="prov ${prov.kind}">${escapeHtml(prov.label)}</span></td>
        <td>${sourceRefCell([...new Set([...(member.source_refs || []), ...(member.detail_refs || [])])])}</td>
      </tr>`;
    }).join("")}</tbody></table></div>`;
}
/* Lines the calculator derives from printed wall and deck dimensions —
   the lumber a plan implies, beside the members it schedules. */
function renderLinesTable(lines) {
  return `<div class="result-table-wrap"><table class="result-table">
    <thead><tr><th>Item</th><th>Qty</th><th>Unit</th><th>How</th><th>Source</th></tr></thead>
    <tbody>${lines.map((line) => {
      const prov = methodProvenance(line.method);
      return `<tr><td>${escapeHtml(line.item || "")}</td><td class="qty">${line.quantity ?? "—"}</td><td>${escapeHtml(line.unit || "")}</td><td><span class="prov ${prov.kind}">${escapeHtml(prov.label)}</span></td><td>${sourceRefCell(line.source_refs)}</td></tr>`;
    }).join("")}</tbody></table></div>`;
}
/* A printed rule is a project requirement with its exception clause —
   never an assumption of ours, and never a quantity. */
function renderFramingRules(rules) {
  if (!rules.length) return "";
  return `<ul class="result-rules">${rules.map((rule) => `<li><span class="prov printed">Printed rule</span> <strong>${escapeHtml(rule.rule || "")}</strong>${rule.applies_to ? ` — ${escapeHtml(rule.applies_to)}` : ""}${rule.exception ? ` <em>(${escapeHtml(rule.exception)})</em>` : ""} <span class="result-rule-source">${sourceRefCell(rule.source_refs)}</span></li>`).join("")}</ul>`;
}
function renderFramingSection(members, derived, rules) {
  if (!members.length && !derived.length && !rules.length) {
    return `<p class="result-empty">Not yet read as a schedule. Beams, headers, joists, rafters, studs and their connectors printed on the structural sheets appear only as questions in the audit below until the structural reading is added; nothing here is measured by scale.</p>`;
  }
  return `${renderFramingRules(rules)}${members.length ? renderMemberTable(members) : ""}${derived.length ? renderLinesTable(derived) : ""}${!members.length && !derived.length ? `<p class="result-empty">No scheduled framing member was read in this set.</p>` : ""}`;
}
function renderFoundationSection(members) {
  if (!members.length) {
    return `<p class="result-empty">Footings, hold-downs and anchorage are printed in the structural schedules but this reading had no field for them. They appear only as questions in the audit below until the structural reading is added.</p>`;
  }
  return renderMemberTable(members);
}
/* The members a reading recorded, told apart by where they sit. */
function structuralMembers(analysis) {
  const members = Array.isArray(analysis?.structural_members) ? analysis.structural_members : [];
  const foundation = members.filter((member) => window.MDAITakeoff360?.isFoundationMember?.(member.member_type));
  return { framing: members.filter((member) => !foundation.includes(member)), foundation };
}
const memberCount = (list, rules = 0) => {
  const settled = list.filter((member) => scheduleProvenance(member).kind !== "unknown").length;
  const words = [`${list.length} member${list.length === 1 ? "" : "s"}`];
  if (list.length) words.push(`${settled} with a quantity`);
  if (rules) words.push(`${rules} printed rule${rules === 1 ? "" : "s"}`);
  return words.join(" · ");
};

function renderResultSections() {
  const host = $("#result-sections");
  if (!host) return;
  const analysis = state.baseline?.analysis || {};
  const draft = takeoffDraft();
  const sections = RESULT_SECTIONS.map(({ category, title }) => ({ title, rows: resultSectionRows(analysis, category), category }))
    .filter((section) => section.rows.length || ["door", "window", "electrical_fixture"].includes(section.category));
  const scheduled = sections.map((section) => `
    <details class="result-section" ${section.rows.length ? "open" : ""} data-result-section="${escapeHtml(section.category)}">
      <summary>${escapeHtml(section.title)} <small>${section.rows.length ? `${section.rows.length} scheduled item${section.rows.length === 1 ? "" : "s"}` : "none printed in this set"}</small></summary>
      ${section.rows.length ? renderScheduleTable(section.rows) : `<p class="result-empty">No ${section.title.toLowerCase()} schedule was read in this set.</p>`}
    </details>`).join("");
  const members = structuralMembers(analysis);
  /* The calculator's own lines — from printed wall and deck dimensions —
     without the ones it made from members, which are shown as members. */
  const derived = (draft?.result?.lines || []).filter((line) => !line.member_type);
  const rules = Array.isArray(analysis.framing_defaults) ? analysis.framing_defaults : [];
  const framingCount = members.framing.length || derived.length
    ? [members.framing.length ? memberCount(members.framing) : "", derived.length ? `${derived.length} calculated line${derived.length === 1 ? "" : "s"}` : "", rules.length ? `${rules.length} printed rule${rules.length === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ")
    : (rules.length ? `${rules.length} printed rule${rules.length === 1 ? "" : "s"}` : "not yet read as a schedule");
  const framing = `
    <details class="result-section" ${members.framing.length || derived.length || rules.length ? "open" : ""} data-result-section="framing">
      <summary>Structural framing <small>${framingCount}</small></summary>
      ${renderFramingSection(members.framing, derived, rules)}
    </details>
    <details class="result-section" ${members.foundation.length ? "open" : ""} data-result-section="foundation">
      <summary>Foundation <small>${members.foundation.length ? memberCount(members.foundation) : "not yet read as a schedule"}</small></summary>
      ${renderFoundationSection(members.foundation)}
    </details>`;
  host.innerHTML = scheduled + framing;
  host.querySelectorAll("[data-open-sheet]").forEach((button) => {
    button.addEventListener("click", () => openSheet(button.dataset.openSheet, Number(button.dataset.openPage || 0)));
  });
}

/* A sheet, at its page, in the file that holds it. */
async function openSheet(documentId, page) {
  const source = state.documents.find((row) => row.id === documentId);
  if (!source) { notify("That source document is unavailable in this project."); return; }
  try {
    let url;
    if (source.storage_provider === "aws-s3") {
      url = await window.MDAIObjectStorage.getSignedUrl(client, "project_document", source.id);
    } else {
      const { data, error } = await client.storage.from(source.storage_bucket || "project-documents")
        .createSignedUrl(source.storage_path, 3600);
      if (error) throw error;
      url = data?.signedUrl;
    }
    if (!url) throw new Error("Source link unavailable");
    const anchored = page ? `${url}#page=${page}` : url;
    document.getElementById("search-source-dialog")?.remove();
    const dialog = document.createElement("dialog");
    dialog.id = "search-source-dialog";
    dialog.style.cssText = "width:90vw;height:85vh;padding:16px";
    const title = document.createElement("h2");
    title.textContent = source.original_filename;
    const note = document.createElement("p");
    const range = partOf(source);
    note.textContent = page
      ? `Page ${page} of this file${range ? ` — original page ${page + Number(range.page_from) - 1} of the set` : ""}.`
      : "Whole document.";
    const close = document.createElement("button");
    close.textContent = "Close source";
    close.onclick = () => dialog.close();
    const link = document.createElement("a");
    link.textContent = "Open in a new tab";
    link.href = anchored; link.target = "_blank"; link.rel = "noopener";
    const frame = document.createElement("iframe");
    frame.title = source.original_filename; frame.src = anchored;
    frame.style.cssText = "width:100%;height:65vh;border:0";
    dialog.append(title, note, close, link, frame);
    dialog.addEventListener("close", () => dialog.remove());
    document.body.append(dialog); dialog.showModal();
  } catch (error) {
    notify("The source could not be opened. Please try again.");
    console.warn("sheet source", error);
  }
}

/* What the reading holds, counted by kind — the numbers the hero, the
   summary and the result share. */
function readingCounts() {
  const analysis = state.baseline?.analysis || {};
  const rows = Array.isArray(analysis.component_schedules) ? analysis.component_schedules : [];
  const byKind = RESULT_SECTIONS.map(({ category, title }) => ({ category, title, count: rows.filter((row) => (row.category || "other") === category).length }))
    .filter((entry) => entry.count > 0);
  const members = structuralMembers(analysis);
  const derived = (takeoffDraft()?.result?.lines || []).filter((line) => !line.member_type);
  return { rows: rows.length, byKind, framing: members.framing.length + derived.length, foundation: members.foundation.length };
}

function renderHero() {
  const eyebrow = $("#hero-eyebrow");
  const title = $("#hero-title");
  const copy = $("#hero-copy");
  if (!eyebrow || !title || !copy) return;
  document.body.classList.toggle("has-baseline", Boolean(state.baseline));
  if (!state.baseline) {
    eyebrow.textContent = "Project intelligence · Start here";
    title.textContent = "Plans first. Evidence with a purpose.";
    copy.textContent = "Upload the current drawing set. AI will map the project, identify evidence gates, and produce exact room-by-room capture instructions for human approval.";
    return;
  }
  const approved = state.baseline.state === "approved";
  const counts = readingCounts();
  const blockers = approved ? 0 : blockingBaselineGaps().length;
  eyebrow.textContent = `Project · plan set v${state.baseline.version || 1}`;
  title.textContent = state.property?.name || "Project";
  copy.textContent = [
    approved ? "Roadmap active" : "Analysis complete · Review required",
    counts.rows ? `${counts.rows} scheduled item${counts.rows === 1 ? "" : "s"} read` : "",
    counts.framing || counts.foundation ? `${counts.framing + counts.foundation} structural member${counts.framing + counts.foundation === 1 ? "" : "s"}` : "",
    blockers ? `${blockers} question${blockers === 1 ? "" : "s"} block${blockers === 1 ? "s" : ""} activation` : "",
  ].filter(Boolean).join(" · ");
}

/* WHICH READER, AND WHICH SAVED READING.
 *
 * Choosing the reader is an owner's or an administrator's decision, so the
 * picker is theirs alone; everybody else runs the project's default. The
 * catalogue comes from the server, which is the only place that knows
 * whether a provider has a key — the answer is a yes or a no, never a key.
 *
 * A reading is never replaced. Each one is its own baseline version, and the
 * switcher moves the whole screen — schedules, questions, sources — from one
 * to another. */
function mayChooseReader() {
  return ["owner", "admin"].includes(state.role);
}

function providerEntry(key) {
  return state.providers.find((entry) => entry.provider === key) || null;
}

function chosenReader() {
  const provider = state.reader.provider || state.providers[0]?.provider || "openai";
  const entry = providerEntry(provider);
  const model = state.reader.model || entry?.models?.[0]?.id || null;
  return { provider, model, entry, modelEntry: entry?.models?.find((item) => item.id === model) || null };
}

async function loadProviders() {
  if (!mayChooseReader() || !state.organizationId) { state.providers = []; return; }
  try {
    const { data, error } = await client.functions.invoke("plan-analyze", {
      body: { action: "providers", organization_id: state.organizationId },
    });
    if (error || !data?.providers) return;
    state.providers = data.providers;
    if (!state.reader.provider) state.reader.provider = data.default_provider || data.providers[0]?.provider || null;
  } catch (error) {
    /* A picker that could not load is not a reason to block the door: the
       project's default reader still runs. */
    console.warn("provider catalogue", error);
  }
}

function priceLine(modelEntry) {
  if (!modelEntry) return "";
  if (modelEntry.input_per_mtok === null || modelEntry.output_per_mtok === null) {
    return "Tariff not confirmed — cost will be reported as unknown, not as zero.";
  }
  return `$${modelEntry.input_per_mtok}/M in · $${modelEntry.output_per_mtok}/M out${modelEntry.price_status === "promotional" ? " (promotional)" : ""}`;
}

function renderReaderPicker() {
  const picker = $("#reader-picker");
  if (!picker) return;
  picker.hidden = !mayChooseReader() || !state.providers.length;
  if (picker.hidden) return;
  const { provider, model, entry, modelEntry } = chosenReader();
  const providerSelect = $("#reader-provider");
  providerSelect.innerHTML = state.providers.map((item) => `
    <option value="${escapeHtml(item.provider)}" ${item.provider === provider ? "selected" : ""}>
      ${escapeHtml(item.label)}${item.configured ? "" : " — not configured"}
    </option>`).join("");
  const modelSelect = $("#reader-model");
  modelSelect.innerHTML = (entry?.models || []).map((item) => `
    <option value="${escapeHtml(item.id)}" ${item.id === model ? "selected" : ""}>${escapeHtml(item.label)}</option>`).join("");
  const note = $("#reader-note");
  if (entry && !entry.configured) {
    note.textContent = `Provider not configured — ${entry.label} has no key in this project's secrets. Add it in Supabase and reload.`;
    note.classList.add("warn");
  } else {
    note.classList.remove("warn");
    note.textContent = [
      modelEntry ? `Model ${modelEntry.id}` : "",
      priceLine(modelEntry),
      entry?.mode === "sync" ? "Read in one call per part; a part that does not finish is shown as unfinished." : "Read in the background; long sets keep their finished parts.",
    ].filter(Boolean).join(" · ");
  }
}

/* The reader a press of Analyze would use, and whether it can run at all. */
function readerBlock() {
  if (!mayChooseReader() || !state.providers.length) return null;
  const { entry } = chosenReader();
  if (entry && !entry.configured) {
    return { label: "Provider not configured", message: `${entry.label} has no key in this project's secrets, so it cannot be run.` };
  }
  return null;
}

function runLine(baseline) {
  const run = baseline?.analysis_run || {};
  const usage = run.usage || {};
  const parts = [];
  if (run.provider_label || run.provider) parts.push(`${run.provider_label || run.provider}${run.model ? ` · ${run.model}` : ""}`);
  else if (baseline?.model) parts.push(baseline.model);
  if (baseline?.agent_contract_version) parts.push(`task ${baseline.agent_contract_version}`);
  /* A reader asked to think less than it would by default is a different
     reader, and the line that says what a reading cost should say so too. */
  if (run.reasoning_effort && run.reasoning_effort !== "provider default") parts.push(`${run.reasoning_effort} effort`);
  if (run.duration_ms) parts.push(`${Math.max(1, Math.round(run.duration_ms / 1000))} s`);
  const input = Number(usage.input_tokens);
  const output = Number(usage.output_tokens);
  if (Number.isFinite(input) || Number.isFinite(output)) {
    parts.push(`${Number.isFinite(input) ? input.toLocaleString() : "—"} in / ${Number.isFinite(output) ? output.toLocaleString() : "—"} out tokens`);
  }
  /* An unknown price is said in words. A zero here would be a lie about
     money, which is the one thing this screen must never tell. */
  if (run.cost_usd === 0) parts.push("no provider call — $0.00");
  else if (typeof run.cost_usd === "number") parts.push(`$${run.cost_usd.toFixed(2)}${run.price_status === "promotional" ? " (promotional rate)" : ""}`);
  else if (Object.keys(run).length) parts.push("cost unknown — tariff not confirmed");
  return parts.join(" · ");
}

/* WHICH READINGS CAN BE COMPARED AT ALL.
 *
 * Readings of the same plan documents, under the same task version, at the
 * same enlargement budget. Others are still offered — a person may want to
 * see them side by side — but the screen says what differed and never calls
 * the result a comparison of readers. */
function readingsForComparison() {
  const readings = (state.baselines || []).filter((item) => item.analysis_run || item.provider || item.model);
  if (readings.length < 2) return [];
  /* Newest first, one per reader: comparing two readings by the same reader
     compares two runs, not two readers. */
  const seen = new Set();
  const picked = [];
  for (const reading of readings) {
    const who = reading.provider || reading.analysis_run?.provider || reading.model || reading.id;
    if (seen.has(who)) continue;
    seen.add(who);
    picked.push(reading);
  }
  return picked.length >= 2 ? picked : [];
}

function comparisonIds() {
  return readingsForComparison().map((item) => item.id);
}

function renderCompareBar() {
  const bar = $("#compare-bar");
  if (!bar) return;
  const candidates = readingsForComparison();
  bar.hidden = candidates.length < 2 || !mayChooseReader();
  if (bar.hidden) return;
  const button = $("#compare-readings");
  const note = $("#compare-note");
  const attach = $("#attach-truth");
  if (attach) attach.disabled = state.busy || state.comparisonBusy;
  const saved = state.comparison && sameIdList(state.comparison.baseline_ids, comparisonIds());
  button.disabled = state.busy || state.comparisonBusy;
  button.textContent = state.comparisonBusy
    ? "Comparing…"
    : saved ? "Show the comparison again" : "Compare AI results";
  const readers = candidates.map((item) => item.analysis_run?.provider_label || item.provider || item.model || "a reader");
  note.textContent = saved
    ? "Already compared — reopening costs nothing."
    : `${readers.join(", ")} · one checker call, on the same sheets these readings were made from.`;
}

function sameIdList(a, b) {
  const left = [...(a || [])].sort().join(",");
  const right = [...(b || [])].sort().join(",");
  return Boolean(left) && left === right;
}

/* The saved comparison of the current readings, if there is one. Never buys
   anything: this is the free half. */
async function loadComparison() {
  state.comparison = null;
  const ids = comparisonIds();
  if (ids.length < 2 || !mayChooseReader() || !state.property?.id) return;
  try {
    const { data, error } = await client.functions.invoke("compare-readings", {
      body: { action: "status", property_id: state.property.id, baseline_ids: ids },
    });
    if (error) return;
    state.comparison = data?.comparison || null;
  } catch (error) {
    console.warn("comparison", error);
  }
}

async function runComparison() {
  const ids = comparisonIds();
  if (ids.length < 2 || state.comparisonBusy) return;
  if (state.comparison && sameIdList(state.comparison.baseline_ids, ids)) {
    renderComparison();
    $("#comparison")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  state.comparisonBusy = true;
  renderCompareBar();
  const { provider, model } = chosenReader();
  try {
    const { data, error } = await client.functions.invoke("compare-readings", {
      body: { action: "run", property_id: state.property.id, baseline_ids: ids, provider, model },
    });
    if (error) throw error;
    if (data?.comparison) {
      state.comparison = data.comparison;
      state.comparisonBusy = false;
      renderComparison();
      renderCompareBar();
      return;
    }
    /* The mechanical half is already on the screen while the checker reads
       the sheets. Nothing is bought again by waiting. */
    state.comparison = { pending: true, ...(data?.preview || {}) };
    renderComparison();
    await waitForComparison(ids, Number(data?.preview?.deadline_ms) || 480000);
  } catch (error) {
    notify(error?.message || "The comparison could not be started", "error");
  } finally {
    state.comparisonBusy = false;
    renderCompareBar();
  }
}

async function waitForComparison(ids, deadlineMs) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 6000));
    const { data } = await client.functions.invoke("compare-readings", {
      body: { action: "status", property_id: state.property.id, baseline_ids: ids },
    });
    if (data?.comparison) {
      state.comparison = data.comparison;
      renderComparison();
      return;
    }
  }
  /* A check that never came back is not a check that failed silently. */
  state.comparison = { ...(state.comparison || {}), pending: false, timed_out: true };
  renderComparison();
}

/* A control markup, attached to this project.
 *
 * A JSON file of positions read off the real sheets by a person, each with
 * the page it was found on. The server records which documents it was read
 * from — with their size and page count — so it can never be quietly applied
 * to a different revision of the drawings. */
async function attachControlMarkup(file) {
  if (!file) return;
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (error) {
    notify("That file is not readable JSON, so nothing was attached.", "error");
    return;
  }
  const entries = Array.isArray(parsed) ? parsed : parsed?.entries;
  if (!Array.isArray(entries) || !entries.length) {
    notify("That file carries no marked positions, so nothing was attached.", "error");
    return;
  }
  const documentIds = Array.isArray(parsed?.source_document_ids) && parsed.source_document_ids.length
    ? parsed.source_document_ids
    : [...new Set(readingsForComparison().flatMap((reading) => reading.source_document_ids || []))];
  if (!documentIds.length) {
    notify("Name the plan documents this markup was read from — the readings on screen do not say.", "error");
    return;
  }
  try {
    const { data, error } = await client.functions.invoke("compare-readings", {
      body: {
        action: "attach_truth",
        property_id: state.property.id,
        label: parsed?.label || file.name,
        source_document_ids: documentIds,
        entries,
      },
    });
    if (error) throw error;
    const disputed = entries.filter((entry) => entry?.disputed).length;
    notify(`Control markup attached — ${data?.entries || entries.length} marked positions`
      + `${disputed ? `, ${disputed} of them disputed and never used to decide between readers` : ""}.`);
  } catch (error) {
    notify(error?.message || "The control markup could not be attached", "error");
  }
}

const READER_LETTERS = ["A", "B", "C", "D", "E", "F"];

/* THE SHEET A FINDING POINTS AT.
 *
 * A finding names a sheet and a page of the original set. A plan document may
 * be a part cut from that set, so the page inside the file is not the page on
 * the sheet — which is why the page numbers are translated here rather than
 * handed to the viewer raw. A finding whose page belongs to no document in
 * this comparison gets no button rather than a wrong one. */
function findingSheet(comparison, finding) {
  const page = Number(finding?.evidence?.page) || 0;
  if (!page) return null;
  for (const id of comparison?.plan_document_ids || []) {
    const source = state.documents.find((row) => row.id === id);
    if (!source) continue;
    const range = partOf(source);
    if (!range) return { id, page };
    const from = Number(range.page_from) || 1;
    const to = Number(range.page_to) || 0;
    if (page >= from && (!to || page <= to)) return { id, page: page - from + 1 };
  }
  return null;
}

/* Who A, B and C actually were. The checker never knew; the person reading
   the result must. */
function readerName(comparison, blind) {
  const baselineId = comparison?.blind_map?.[blind];
  const reading = (state.baselines || []).find((item) => item.id === baselineId);
  if (!reading) return blind;
  const who = reading.analysis_run?.provider_label || reading.provider || reading.model || "a reader";
  return `${who} (v${reading.version})`;
}

function renderComparison() {
  const panel = $("#comparison");
  if (!panel) return;
  const comparison = state.comparison;
  panel.hidden = !comparison;
  if (!comparison) return;

  const verdict = comparison.verdict || {};
  const mechanical = comparison.mechanical || {};
  const heading = $("#comparison-verdict");
  const reason = $("#comparison-reason");

  if (comparison.pending) {
    heading.textContent = "Checking the answers against the sheets";
    reason.textContent = "The differences below were found without looking at the drawings. The checker is reading the sheets now; nothing else is being bought.";
  } else if (comparison.timed_out) {
    heading.textContent = "Comparison incomplete";
    reason.textContent = "The checker did not answer in time. It was not started again — that is a decision for a person.";
  } else if (comparison.state === "incomplete") {
    heading.textContent = "Comparison incomplete";
    reason.textContent = comparison.incomplete_reason || "One of the readings could not be compared.";
  } else {
    /* The leader this application counted from findings that carried
       evidence — never the number of rows anybody wrote. */
    const leader = verdict.tally?.leader || null;
    const recommended = leader ? readerName(comparison, leader) : null;
    heading.textContent = recommended ? `Recommended for this set: ${recommended}` : "No clear winner";
    if (leader) {
      reason.textContent = [verdict.recommendation_reason || "", `Counted ${verdict.tally?.reason || ""}.`].filter(Boolean).join(" ");
    } else {
      /* The checker may still have had a preference. Saying so, and saying
         it was not enough, is more useful than hiding it — and it is not the
         same as naming a winner. */
      const leaned = ["A", "B", "C"].includes(verdict.recommended_reader)
        ? `The checker leaned towards ${readerName(comparison, verdict.recommended_reader)}${verdict.recommendation_reason ? ` — ${verdict.recommendation_reason}` : ""} `
          + "— but that is not enough checked evidence to recommend a reader for this set."
        : "";
      reason.textContent = ["The checked findings do not separate these readers.", leaned].filter(Boolean).join(" ");
    }
  }

  const conditions = $("#comparison-conditions");
  const differences = comparison.conditions?.differences || [];
  conditions.hidden = !differences.length;
  if (differences.length) {
    conditions.textContent = `These readings were not made under the same conditions — ${differences.join("; ")}. `
      + "What follows compares circumstances as much as readers, so it is not a fair comparison of the readers themselves.";
  }

  const run = $("#comparison-run");
  const runDetail = verdict.run || {};
  const truth = comparison.truth || {};
  run.textContent = [
    comparison.judge_model ? `Checked by ${runDetail.provider_label || comparison.judge_provider || ""} ${comparison.judge_model}`.trim() : "",
    comparison.agent_contract_version ? `task ${comparison.agent_contract_version}` : "",
    runDetail.duration_ms ? `${Math.max(1, Math.round(runDetail.duration_ms / 1000))} s` : "",
    Number.isFinite(Number(runDetail.usage?.input_tokens))
      ? `${Number(runDetail.usage.input_tokens).toLocaleString()} in / ${Number(runDetail.usage.output_tokens || 0).toLocaleString()} out tokens` : "",
    typeof runDetail.cost_usd === "number" ? `$${runDetail.cost_usd.toFixed(2)}` : (comparison.judge_model ? "cost unknown — tariff not confirmed" : ""),
    truth.absent ? "no control markup for this plan set — this is a reader's recommendation, not measured accuracy" : "",
    (verdict.tally?.set_aside_as_disputed || []).length
      ? `${verdict.tally.set_aside_as_disputed.length} finding${verdict.tally.set_aside_as_disputed.length === 1 ? "" : "s"} left out of the count — the reference count for those marks is itself disputed`
      : "",
    "the checker was not told which system wrote which answer, which reduces bias and does not make the check independent",
  ].filter(Boolean).join(" · ");

  const sectionRows = (mechanical.sections || []).map((section) => {
    const judged = (verdict.sections || []).find((item) => item.section === section.section);
    const best = judged?.best && !["none", "tie"].includes(judged.best) ? readerName(comparison, judged.best) : (judged?.best === "tie" ? "no difference found" : "not separated");
    return `<tr>
      <th scope="row">${escapeHtml(label(section.section))}</th>
      <td class="numeric">${section.positions}</td>
      <td class="numeric">${section.all_three}</td>
      <td class="numeric">${section.count_differences} counts · ${section.unit_differences} units · ${section.scope_flags} scope</td>
      <td>${escapeHtml(best)}</td>
      <td>${escapeHtml(judged?.why || "")}</td>
    </tr>`;
  }).join("");
  const table = $("#comparison-sections");
  if (table) table.querySelector("tbody").innerHTML = sectionRows
    || `<tr><td colspan="6">Nothing lined up between these readings yet.</td></tr>`;

  /* The three that matter most: a wrong verdict outranks an unverified one,
     and a disagreement nobody could settle is still worth seeing. */
  const findings = (verdict.findings || []);
  const rank = { wrong: 0, could_not_verify: 1, verified: 2 };
  const top = [...findings].sort((a, b) => (rank[a.verdict] ?? 3) - (rank[b.verdict] ?? 3)).slice(0, 3);
  $("#comparison-top").innerHTML = top.length
    ? top.map((finding) => `<article class="comparison-finding">
        <strong>${escapeHtml(finding.mark || finding.section || "")} — ${escapeHtml(label(finding.verdict || ""))}</strong>
        <span>${escapeHtml(finding.claim || "")}</span>
        <span>${escapeHtml(finding.why || "")}</span>
        <small>${escapeHtml([
          finding.reader && finding.reader !== "all" ? readerName(comparison, finding.reader) : "all readers",
          finding.evidence?.sheet || "",
          finding.evidence?.page ? `page ${finding.evidence.page}` : "",
          finding.evidence?.tile || "",
          (finding.evidence?.marks || []).length ? `${finding.evidence.marks.length} marks identified` : "no individual marks identified",
        ].filter(Boolean).join(" · "))}</small>
        ${findingSheet(comparison, finding)
          ? `<button class="ghost" type="button" data-open-sheet="${escapeHtml(findingSheet(comparison, finding).id)}" data-open-page="${findingSheet(comparison, finding).page}">Open ${escapeHtml(finding.evidence?.sheet || "the sheet")} at page ${finding.evidence.page}</button>`
          : ""}
      </article>`).join("")
    : (comparison.pending ? "" : `<p class="comparison-coverage">The checker reported no finding it could place on a sheet.</p>`);

  const coverage = verdict.check_coverage || {};
  const truthCoverage = truth.coverage || {};
  $("#comparison-coverage").textContent = [
    Number.isFinite(Number(coverage.positions_checked)) ? `${coverage.positions_checked} positions checked against the sheets, ${coverage.positions_not_checked || 0} not checked` : "",
    coverage.what_stayed_unresolved || "",
    truthCoverage.entries_total
      ? `Control markup: ${truthCoverage.entries_scored} of ${truthCoverage.entries_total} entries used, ${truthCoverage.entries_disputed} left out as disputed, ${truthCoverage.missed_by_all} missed by every reader.`
      : "",
    (verdict.missed_by_all || []).length
      ? `${verdict.missed_by_all.length} position${verdict.missed_by_all.length === 1 ? "" : "s"} the checker found that no reading reported.` : "",
    mechanical.caveat || "",
  ].filter(Boolean).join(" ");

  /* The same viewer the rest of this screen uses: the sheet, at its page, in
     the file that holds it. */
  $("#comparison-top").querySelectorAll("[data-open-sheet]").forEach((button) => {
    button.addEventListener("click", () => openSheet(button.dataset.openSheet, Number(button.dataset.openPage || 0)));
  });

  const downgrades = verdict.evidence_downgrades || [];
  $("#comparison-evidence").innerHTML = [
    `<p>Readers: ${READER_LETTERS.slice(0, (comparison.baseline_ids || []).length)
      .map((letter) => `${letter} = ${escapeHtml(readerName(comparison, letter))}`).join(" · ")}</p>`,
    findings.length ? `<ul>${findings.map((finding) => `<li>${escapeHtml([
      finding.reader && finding.reader !== "all" ? readerName(comparison, finding.reader) : "all readers",
      finding.mark || "",
      label(finding.verdict || ""),
      finding.evidence?.sheet || "",
      finding.evidence?.page ? `page ${finding.evidence.page}` : "",
      finding.why || "",
    ].filter(Boolean).join(" — "))}</li>`).join("")}</ul>` : "",
    downgrades.length
      ? `<p>${downgrades.length} of the checker's findings were not accepted as checked, because a place on a sheet — or, for a count, the individual marks — was not named: ${escapeHtml(downgrades.join("; "))}</p>`
      : "",
    `<p>The winner does not become this project's baseline, and no rows of one reading were merged into another.</p>`,
  ].filter(Boolean).join("");
}

function renderReadingSwitch() {
  const wrap = $("#reading-switch");
  if (!wrap) return;
  const readings = state.baselines || [];
  wrap.hidden = readings.length < 2;
  const list = $("#reading-list");
  if (list) {
    list.innerHTML = readings.map((item) => {
      const run = item.analysis_run || {};
      const who = run.provider_label || run.provider || item.provider || "reading";
      const selected = item.id === state.baseline?.id;
      return `<button class="reading-tab" type="button" role="tab" aria-selected="${selected}" data-reading="${escapeHtml(item.id)}">
        <strong>v${item.version} · ${escapeHtml(String(who))}</strong>
        <small>${escapeHtml(run.model || item.model || "")} · ${escapeHtml(label(item.state))}</small>
      </button>`;
    }).join("");
    list.querySelectorAll("[data-reading]").forEach((button) => {
      button.addEventListener("click", () => switchReading(button.dataset.reading));
    });
  }
  const runNote = $("#reading-run");
  if (runNote) runNote.textContent = runLine(state.baseline);
  renderCompareBar();
  renderComparison();
}

/* Switching readings reloads everything that belongs to a baseline — its
   schedules, its questions, its sources — so nothing of the other reading
   can survive on the screen. */
async function switchReading(baselineId) {
  if (!baselineId || baselineId === state.baseline?.id || state.busy) return;
  state.requestedBaselineId = baselineId;
  await openProperty(state.property.id);
}

function renderBaseline() {
  elements.baselineSection.hidden = !state.baseline;
  if (!state.baseline) return;
  $("#baseline-state").textContent = `${label(state.baseline.state)} · v${state.baseline.version}`;
  $("#baseline-state").className = `state-pill ${state.baseline.state}`;
  $("#approve-baseline").hidden = state.baseline.state === "approved" || !canApproveBaseline();
  const blockingGaps = blockingBaselineGaps();
  const approvalButton = $("#approve-baseline");
  const approvalGuidance = $("#approval-guidance");
  approvalButton.disabled = state.busy || !canApproveBaseline();
  approvalButton.classList.toggle("manager-confirmation", blockingGaps.length > 0);
  approvalButton.textContent = blockingGaps.length
    ? "Confirm approved set & activate roadmap"
    : "Approve baseline & activate roadmap";
  approvalButton.title = blockingGaps.length
    ? "Record the manager's governing-set confirmation before activating field tasks."
    : "Approve this reviewed baseline and activate field capture tasks.";
  approvalGuidance.hidden = !blockingGaps.length || state.baseline.state === "approved";
  approvalGuidance.textContent = blockingGaps.length
    ? "If this is the official approved set, an authorized manager can acknowledge the blocking questions, record the approval reference, and activate the roadmap."
    : "";
  const approved = state.baseline.state === "approved";
  const status = $("#result-status");
  if (status) {
    status.innerHTML = approved
      ? `Analysis complete · Roadmap active · v${state.baseline.version}`
      : `Analysis complete · Review required${blockingGaps.length ? ` · <span class="blocking">${blockingGaps.length} question${blockingGaps.length === 1 ? "" : "s"} block${blockingGaps.length === 1 ? "s" : ""} activation</span>` : ""}`;
  }
  renderReadingSwitch();
  $("#project-summary").textContent = state.baseline.project_summary;
  const analysis = state.baseline.analysis || {};
  const chips = [
    `${state.planSpaces.length} spaces`,
    `${(analysis.levels || []).length} levels`,
    `${(analysis.systems || []).length} systems`,
    `${state.phases.length} capture gates`,
  ];
  $("#structure-summary").innerHTML = `<div class="structure-chips">${chips.map((chip) => `<span>${escapeHtml(chip)}</span>`).join("")}</div>`;
  const gaps = Array.isArray(state.baseline.gaps) ? state.baseline.gaps : [];
  const first = settleFirst(gaps);
  const conflicts = $("#result-conflicts");
  if (conflicts) {
    conflicts.innerHTML = first.length
      ? first.map((gap) => `<li class="${escapeHtml(gap.severity)}">${escapeHtml(gap.question)}</li>`).join("")
      : '<li class="none">Nothing blocks activation. Human review is still required.</li>';
    const rule = $("#result-rule");
    if (rule) rule.textContent = first.length ? "Chosen by rule: the first critical questions that block activation, then the first important ones." : "";
  }
  renderResultSections();
  const auditSummary = $("#result-audit-summary");
  if (auditSummary) auditSummary.textContent = `Audit · every question this reading raised (${gaps.length})`;
  $("#gap-list").innerHTML = gaps.length
    ? gaps.map((gap) => `<div class="gap-item ${escapeHtml(gap.severity)}"><i></i><span>${gap.origin === "reader" ? "<b>Our reading, not the drawings</b> · " : ""}${escapeHtml(gap.question)}${gap.blocks_activation ? " · Blocks activation" : ""}</span></div>`).join("")
    : '<div class="gap-item"><i></i><span>No unresolved gaps were reported. Human review is still required.</span></div>';
}

/* The reading register.
 *
 * Every reading of a plan set already admits what it could not do: the
 * questions it raises, the counts it could not make, the numbers it would
 * not stand behind. Until now all of that lived inside one run — open a
 * baseline, see that run's gaps — so nobody could answer the question that
 * matters about our own machine: where does the reader KEEP failing.
 *
 * This is that register, accumulated across every reading of the project.
 * One rule governs the screen exactly as it governs the table: a gap a
 * later reading stopped raising is shown as no longer raised, never as
 * answered. Only a person answers, and their answer carries their name. */
const REGISTER_KIND_LABELS = {
  unanswered_question: "Open question",
  no_count: "No count",
  weak_count: "Weak count",
};
const REGISTER_STATUS_LABELS = {
  answered: "Answered by a person",
  withdrawn: "Withdrawn by a person",
  not_raised_again: "The newest reading did not raise it",
};
let openGapId = null;

/* The same failure on two projects is the reader's weakness, not the
   project's — so the map that says so is read at the organisation level and
   printed under the project's own list. */
async function loadReadingWeakSpots() {
  if (!state.organizationId) { state.readingWeakSpots = null; return; }
  const { data, error } = await client.rpc("plan_reading_weak_spots", {
    p_organization_id: state.organizationId,
  });
  if (error) { console.error("weak spots", error); state.readingWeakSpots = null; return; }
  state.readingWeakSpots = data || null;
}

function weakSpotSentence() {
  const spots = state.readingWeakSpots;
  if (!spots) return "";
  const kinds = Array.isArray(spots.by_kind) ? spots.by_kind : [];
  const sheets = Array.isArray(spots.by_sheet) ? spots.by_sheet : [];
  const worst = kinds.slice().sort((left, right) => Number(right.gaps || 0) - Number(left.gaps || 0))[0];
  if (!worst) return "";
  const projects = Number(worst.projects || 0);
  const parts = [`Across this account: ${Number(worst.gaps || 0)} × ${REGISTER_KIND_LABELS[worst.kind] || worst.kind}`
    + ` on ${projects} project${projects === 1 ? "" : "s"}`];
  const sheet = sheets[0];
  if (sheet?.sheet) parts.push(`the reference the reader stumbles on most is ${sheet.sheet} (${Number(sheet.gaps || 0)})`);
  return `${parts.join(" · ")}.`;
}

async function loadReadingRegister(propertyId) {
  if (!propertyId) { state.readingRegister = null; return; }
  const { data, error } = await client.rpc("plan_reading_register", { p_property_id: propertyId });
  if (error) {
    /* The register is for the people who run the project. A role without it
       simply does not see the section — it is never an error on screen. */
    console.error("reading register", error);
    state.readingRegister = null;
    return;
  }
  state.readingRegister = data || null;
}

function registerPool(name) {
  const pool = state.readingRegister?.[name];
  return Array.isArray(pool) ? pool : [];
}

function registerGapById(gapId) {
  return ["open", "answered", "not_raised_again", "withdrawn"]
    .flatMap((name) => registerPool(name))
    .find((row) => row.id === gapId) || null;
}

function registerSheets(row) {
  const refs = Array.isArray(row?.source_refs) ? row.source_refs : [];
  return refs.filter((ref) => typeof ref === "string" && ref.trim()).join(" · ");
}

function registerRowMarkup(row) {
  const seen = Number(row.readings_seen || 1);
  const chips = [`<span>${escapeHtml(REGISTER_KIND_LABELS[row.kind] || "Gap")}</span>`];
  if (row.blocks_activation) chips.push('<span class="blocking">Blocks activation</span>');
  chips.push(seen > 1
    ? `<span class="recurring">Raised by ${seen} readings</span>`
    : "<span>Raised once</span>");
  const sheets = registerSheets(row);
  if (sheets) chips.push(`<span>${escapeHtml(sheets)}</span>`);
  chips.push(`<span>First seen ${escapeHtml(shortDate(row.first_seen_at))}</span>`);
  /* An answer the drawings never absorbed is not a closed question, and the
     row says both halves out loud. */
  const priorAnswer = row.answer
    ? `<p class="register-answer">A person answered on ${escapeHtml(shortDate(row.answered_at))}: ${escapeHtml(row.answer)} — and a later reading raised it again.</p>`
    : "";
  return `
    <div class="register-row ${escapeHtml(row.severity || "informational")}">
      <i></i>
      <div>
        <p class="register-question">${escapeHtml(row.question)}</p>
        <div class="register-meta">${chips.join("")}</div>
        ${priorAnswer}
      </div>
      <button class="button secondary" type="button" data-gap="${escapeHtml(row.id)}">Answer this</button>
    </div>`;
}

function registerHistoryMarkup(row, status) {
  const seen = Number(row.readings_seen || 1);
  const when = row.answered_at ? ` · ${escapeHtml(shortDate(row.answered_at))}` : "";
  const answer = row.answer ? ` — ${escapeHtml(row.answer)}` : "";
  return `
    <div class="register-history-row">
      <div>
        <b>${escapeHtml(row.question)}</b><br>
        ${escapeHtml(REGISTER_STATUS_LABELS[status] || status)}${when}${answer}
        · raised by ${seen} reading${seen === 1 ? "" : "s"}
      </div>
      <button class="button secondary" type="button" data-gap="${escapeHtml(row.id)}">Answer this</button>
    </div>`;
}

/* Ranked on the screen as well as in the query: what blocks activation, then
   severity, then what keeps coming back. A screen that trusts the caller's
   order shows the wrong thing first the day the caller changes. */
function registerRank(row) {
  const severity = { critical: 1, important: 2, informational: 3 }[row.severity] || 3;
  return [row.blocks_activation ? 0 : 1, severity, -Number(row.readings_seen || 1),
    new Date(row.first_seen_at || 0).valueOf()];
}

function byRegisterRank(left, right) {
  const a = registerRank(left);
  const b = registerRank(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function renderRegister() {
  const register = state.readingRegister;
  const open = registerPool("open").slice().sort(byRegisterRank);
  const answered = registerPool("answered");
  const quiet = registerPool("not_raised_again");
  const withdrawn = registerPool("withdrawn");
  const total = open.length + answered.length + quiet.length + withdrawn.length;
  elements.registerSection.hidden = !register || total === 0;
  if (elements.registerSection.hidden) return;

  const summary = register.summary || {};
  $("#register-state").textContent = open.length
    ? `${open.length} open · ${Number(summary.readings || 0)} readings`
    : `Nothing open · ${Number(summary.readings || 0)} readings`;
  $("#register-metrics").innerHTML = [
    ["Open", open.length, Number(summary.blocking || 0) ? `${summary.blocking} blocks activation` : "None block activation"],
    ["Recurring", Number(summary.recurring || 0), "Raised by more than one reading"],
    ["Answered by a person", answered.length, "With a name and a date on it"],
    ["No longer raised", quiet.length, "Silence, not an answer"],
  ].map(([title, value, note]) =>
    `<article><span>${escapeHtml(title)}</span><strong>${escapeHtml(String(value))}</strong><small>${escapeHtml(note)}</small></article>`,
  ).join("");

  $("#register-list").innerHTML = open.length
    ? open.map(registerRowMarkup).join("")
    : '<div class="register-empty">Nothing is open. Everything the readings raised was answered, withdrawn, or dropped by a later reading — all of it is kept below.</div>';

  const history = [
    ...answered.map((row) => registerHistoryMarkup(row, "answered")),
    ...withdrawn.map((row) => registerHistoryMarkup(row, "withdrawn")),
    ...quiet.map((row) => registerHistoryMarkup(row, "not_raised_again")),
  ];
  $("#register-history-summary").textContent =
    `Answered, withdrawn, and no longer raised (${history.length})`;
  $("#register-history").innerHTML = history.join("")
    || '<div class="register-empty">Nothing has left the open list yet.</div>';
  const weakSpots = weakSpotSentence();
  $("#register-weak-spots").hidden = !weakSpots;
  $("#register-weak-spots").textContent = weakSpots;
  $("#register-doctrine").textContent = register.doctrine || "";

  elements.registerSection.querySelectorAll("[data-gap]").forEach((button) => {
    button.addEventListener("click", () => openGapDialog(button.dataset.gap));
  });
}

function updateGapDialogAction() {
  const written = $("#gap-answer").value.trim().length >= 3;
  $("#answer-gap").disabled = !written || state.busy;
  $("#withdraw-gap").disabled = !written || state.busy;
}

function openGapDialog(gapId) {
  const row = registerGapById(gapId);
  if (!row) return;
  openGapId = gapId;
  const seen = Number(row.readings_seen || 1);
  const sheets = registerSheets(row);
  $("#gap-dialog-question").textContent = row.question;
  $("#gap-dialog-history").textContent = [
    `${REGISTER_KIND_LABELS[row.kind] || "Gap"} · raised by ${seen} reading${seen === 1 ? "" : "s"}`,
    `first seen ${shortDate(row.first_seen_at)}`,
    sheets ? `sheets ${sheets}` : "",
    row.answer ? `previously answered: ${row.answer}` : "",
  ].filter(Boolean).join(" · ");
  $("#gap-answer").value = "";
  updateGapDialogAction();
  $("#gap-dialog").showModal();
}

async function submitGapAnswer(verdict) {
  const gapId = openGapId;
  const answer = $("#gap-answer").value.trim();
  if (!gapId || answer.length < 3 || state.busy) return;
  setBusy(true, verdict === "answered" ? "Recording your answer…" : "Recording the withdrawal…");
  try {
    const { error } = await client.rpc("answer_plan_reading_gap", {
      p_gap_id: gapId,
      p_verdict: verdict,
      p_answer: answer,
    });
    if (error) throw error;
    $("#gap-dialog").close();
    await loadReadingRegister(state.property?.id);
    notify(verdict === "answered"
      ? "Answered, with your name and today's date on it. The question stays in the register with its whole history."
      : "Withdrawn. The register keeps it, and records that a person withdrew it.");
  } catch (error) {
    console.error(error);
    notify(error.message || "That could not be recorded", "error");
  } finally {
    openGapId = null;
    setBusy(false, `Cloud connected · ${state.role}`);
    render();
  }
}

function renderRoadmap() {
  elements.roadmapSection.hidden = !state.baseline;
  if (!state.baseline) return;
  const currentPhaseFilter = $("#phase-filter").value || "all";
  $("#phase-filter").innerHTML = '<option value="all">All phases</option>' + state.phases.map((phase) =>
    `<option value="${phase.id}">${phase.sequence}. ${escapeHtml(phase.name)}</option>`,
  ).join("");
  $("#phase-filter").value = state.phases.some((phase) => phase.id === currentPhaseFilter) ? currentPhaseFilter : "all";
  const phaseFilter = $("#phase-filter").value;
  const statusFilter = $("#status-filter").value;
  const visiblePhases = state.phases.filter((phase) => phaseFilter === "all" || phase.id === phaseFilter);
  elements.phaseList.innerHTML = visiblePhases.map((phase) => {
    const requirements = state.requirements.filter((requirement) => {
      if (requirement.phase_id !== phase.id) return false;
      const task = taskForRequirement(requirement.id);
      return statusFilter === "all" || task.status === statusFilter;
    });
    if (!requirements.length && statusFilter !== "all") return "";
    return `
      <article class="phase-block">
        <header class="phase-header">
          <span class="phase-sequence">${String(phase.sequence).padStart(2, "0")}</span>
          <div class="phase-title"><strong>${escapeHtml(phase.name)}</strong><small>${escapeHtml(phase.objective)}</small></div>
          <div class="phase-gate"><span>Evidence gate</span><strong>${escapeHtml(phase.ends_when)}</strong></div>
          <span class="phase-task-count">${requirements.length} capture${requirements.length === 1 ? "" : "s"}</span>
        </header>
        <div class="task-grid">${requirements.map((requirement) => taskCard(requirement, phase)).join("")}</div>
      </article>`;
  }).join("") || '<div class="empty-state"><h3>No tasks match this filter.</h3><p>Change the phase or task status filter.</p></div>';
  elements.phaseList.querySelectorAll("[data-requirement]").forEach((button) => {
    button.addEventListener("click", () => openTask(button.dataset.requirement));
  });
}

function taskCard(requirement, phase) {
  const task = taskForRequirement(requirement.id);
  const assignment = latestAssignmentForTask(task.id);
  const space = planSpace(requirement.plan_space_id);
  const location = space ? `${space.building} · ${space.level} · ${space.name}` : "Project-wide / location to confirm";
  const refs = Array.isArray(requirement.plan_refs) ? requirement.plan_refs : [];
  return `
    <button class="task-card" type="button" data-requirement="${requirement.id}">
      <div class="task-topline"><span class="task-priority ${requirement.priority}">${escapeHtml(requirement.priority)}</span><span class="task-status ${task.status}">${escapeHtml(label(task.status))}</span></div>
      <h3>${escapeHtml(requirement.title)}</h3>
      <p class="task-location">${escapeHtml(location)}</p>
      <p class="task-why">${escapeHtml(requirement.rationale)}</p>
      ${task.status === "waived" ? `<span class="task-waiver-note">Accepted as missing — ${escapeHtml(task.waiver_reason || "no reason recorded")}</span>` : ""}
      ${assignment ? `<span class="task-assignment ${escapeHtml(assignment.status)}">${escapeHtml(assignment.worker_name)} · ${escapeHtml(label(assignment.status))}</span>` : ""}
      <div class="task-bottom"><strong>${escapeHtml(requirement.capture_type)}</strong><span>${refs.length} plan reference${refs.length === 1 ? "" : "s"} · ${escapeHtml(phase.code)}</span></div>
    </button>`;
}

function openTask(requirementId) {
  const requirement = state.requirements.find((item) => item.id === requirementId);
  if (!requirement) return;
  state.selectedRequirementId = requirementId;
  state.generatedFieldLink = null;
  const phase = phaseForRequirement(requirement);
  const space = planSpace(requirement.plan_space_id);
  $("#task-dialog-phase").textContent = `${phase?.code || "Capture"} · ${label(requirement.priority)} priority`;
  $("#task-dialog-title").textContent = requirement.title;
  $("#task-dialog-location").textContent = space ? `${space.building} → ${space.level} → ${space.name}` : "Project-wide / confirm in field";
  $("#task-dialog-method").textContent = label(requirement.capture_type);
  $("#task-dialog-why").textContent = requirement.rationale;
  const list = (selector, values, ordered = false) => {
    const element = $(selector);
    element.innerHTML = (Array.isArray(values) ? values : []).map((value) => `<li>${escapeHtml(value)}</li>`).join("");
    if (!element.children.length) element.innerHTML = "<li>Not specified in the current baseline.</li>";
  };
  list("#task-dialog-instructions", requirement.instructions, true);
  list("#task-dialog-must-show", requirement.must_show);
  list("#task-dialog-criteria", requirement.acceptance_criteria);
  $("#task-dialog-before").textContent = requirement.before_concealment;
  $("#task-dialog-refs").textContent = (requirement.plan_refs || []).join(" · ") || "No exact sheet reference was legible; see baseline gaps.";
  $("#task-open-intake").href = `../?capture_task=${encodeURIComponent(taskForRequirement(requirement.id).id || "")}`;
  const task = taskForRequirement(requirement.id);
  const assignment = latestAssignmentForTask(task.id);
  $("#task-assignment-state").textContent = assignment ? label(assignment.status) : "Not sent";
  $("#assignment-worker-name").value = assignment?.worker_name || "";
  $("#assignment-worker-email").value = assignment?.worker_email || "";
  $("#assignment-due").value = assignment?.due_at ? new Date(new Date(assignment.due_at).valueOf() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "";
  $("#assignment-result").hidden = true;
  const blockedReason = sendBlockedReason(task);
  $("#send-field-task").disabled = Boolean(blockedReason);
  $("#send-field-task").textContent = assignment ? "Send again" : "Send field task";
  const blocker = $("#assignment-blocker");
  blocker.hidden = !blockedReason;
  blocker.textContent = blockedReason;
  renderWaiverPanel(task);
  $("#task-dialog").showModal();
}

/* What the panel says depends on three things: whether this capture has already
   been accepted as missing, whether anything was actually captured, and whether
   the person looking at it is allowed to decide. */
function renderWaiverPanel(task) {
  const panel = $("#waiver-panel");
  const current = $("#waiver-current");
  const form = $("#waiver-form");
  const lift = $("#lift-waiver");
  const blocker = $("#waiver-blocker");
  const stateLabel = $("#task-waiver-state");
  if (!panel) return;
  const waived = task?.status === "waived";
  const settled = ["verified", "submitted"].includes(task?.status);

  panel.hidden = !task?.id;
  stateLabel.textContent = waived ? "Accepted as missing" : settled ? label(task.status) : "Expected";

  if (waived) {
    /* The browser cannot read another member's email — that lives in auth —
       so the name is either "you" or nothing. Inventing one would be worse than
       saying less; the audit record holds the actual actor either way. */
    const mine = task.waived_by && task.waived_by === state.session?.user?.id;
    const kind = task.waiver_kind === "not_applicable"
      ? "Not part of this project"
      : "Happened, and no evidence of it exists";
    current.hidden = false;
    current.innerHTML = `<strong>${escapeHtml(kind)}</strong>${escapeHtml(task.waiver_reason || "")}<br><em>Accepted by ${mine ? "you" : "a project manager"} on ${escapeHtml(shortDate(task.waived_at))}. No evidence exists for this capture.</em>`;
  } else {
    current.hidden = true;
    current.innerHTML = "";
  }

  form.hidden = waived || settled || !canWaiveCapture();
  lift.hidden = !waived || !canWaiveCapture();
  blocker.hidden = true;
  blocker.textContent = "";
  if (settled) {
    blocker.hidden = false;
    blocker.textContent = task.status === "verified"
      ? "This capture is recorded and verified. There is nothing missing to accept."
      : "A worker has submitted this capture. Review what came in before deciding anything about it.";
  } else if (!waived && !canWaiveCapture()) {
    blocker.hidden = false;
    blocker.textContent = "Your role cannot accept a missing capture. An owner, administrator, reviewer or project manager can.";
  }
}

function waiverInput() {
  const kind = $("#waiver-kind").value;
  const reason = $("#waiver-reason").value.trim();
  if (reason.length < 10) {
    notify("Say why in a sentence — a reader of this record needs the reason, not just the fact.", "error");
    $("#waiver-reason").focus();
    return null;
  }
  return { kind, reason };
}

async function waiveSelectedCapture() {
  const requirement = state.requirements.find((item) => item.id === state.selectedRequirementId);
  const task = requirement ? taskForRequirement(requirement.id) : null;
  if (!task?.id) return notify("This capture task does not exist in the current baseline.", "error");
  const input = waiverInput();
  if (!input) return;
  await runWaiverCall(
    () => client.rpc("waive_capture_task", { p_task_id: task.id, p_kind: input.kind, p_reason: input.reason }),
    "This capture is accepted as missing. The record still says no evidence exists for it.",
  );
}

/* "We were not here for the demolition" is one decision about one phase, not
   eleven decisions about eleven captures. */
async function waiveSelectedPhase() {
  const requirement = state.requirements.find((item) => item.id === state.selectedRequirementId);
  const phase = requirement ? phaseForRequirement(requirement) : null;
  if (!phase?.id || !state.baseline?.id) return notify("This phase does not exist in the current baseline.", "error");
  const input = waiverInput();
  if (!input) return;
  const outstanding = state.requirements.filter((item) => {
    if (item.phase_id !== phase.id) return false;
    const task = taskForRequirement(item.id);
    return !["verified", "waived"].includes(task.status);
  }).length;
  if (!window.confirm(`Accept ${outstanding} outstanding capture${outstanding === 1 ? "" : "s"} in "${phase.name}" as missing? Captures that already hold evidence are left alone.`)) return;
  await runWaiverCall(
    () => client.rpc("waive_capture_phase", {
      p_baseline_id: state.baseline.id, p_phase_id: phase.id, p_kind: input.kind, p_reason: input.reason,
    }),
    `Every outstanding capture in ${phase.name} is accepted as missing.`,
  );
}

async function liftSelectedWaiver() {
  const requirement = state.requirements.find((item) => item.id === state.selectedRequirementId);
  const task = requirement ? taskForRequirement(requirement.id) : null;
  if (!task?.id) return;
  await runWaiverCall(
    () => client.rpc("lift_capture_waiver", { p_task_id: task.id, p_reason: $("#waiver-reason").value.trim() || null }),
    "This capture is back on the roadmap. The earlier acceptance stays in the audit record.",
  );
}

/* The database owns every rule here, so the screen's job is to say plainly what
   it refused and to reload rather than guess at the new state. */
async function runWaiverCall(call, success) {
  setBusy(true, "Recording the decision…");
  try {
    const { error } = await call();
    if (error) throw error;
    $("#waiver-reason").value = "";
    $("#task-dialog").close();
    notify(success);
    await openProperty(state.property.id);
  } catch (error) {
    console.error(error);
    const message = error.message || "The decision could not be recorded";
    const blocker = $("#waiver-blocker");
    blocker.hidden = false;
    blocker.textContent = message;
    notify(message, "error");
  } finally {
    setBusy(false, `Cloud connected · ${state.role}`);
  }
}

async function createFieldAssignment() {
  const requirement = state.requirements.find((item) => item.id === state.selectedRequirementId);
  const task = requirement ? taskForRequirement(requirement.id) : null;
  const workerName = $("#assignment-worker-name").value.trim();
  const workerEmail = $("#assignment-worker-email").value.trim();
  const dueInput = $("#assignment-due").value;
  if (!task?.id) return notify("This capture task is not ready to send.", "error");
  if (!workerName || !/^\S+@\S+\.\S+$/.test(workerEmail)) return notify("Enter the worker name and a valid email.", "error");
  const button = $("#send-field-task");
  button.disabled = true;
  button.textContent = "Creating private link…";
  try {
    const { data, error } = await client.functions.invoke("field-workflow", { body: {
      action: "create_assignment",
      capture_task_id: task.id,
      worker_name: workerName,
      worker_email: workerEmail,
      due_at: dueInput ? new Date(dueInput).toISOString() : null,
    } });
    if (error) throw await functionInvocationError(error, "Field assignment could not be created");
    if (data?.error) throw new Error(data.error);
    state.generatedFieldLink = data.link;
    const emailState = data.email_state || (data.email_sent ? "sent" : "failed");
    const result = $("#assignment-result");
    result.classList.toggle("success", emailState === "sent");
    result.classList.toggle("error", emailState === "failed");
    result.classList.toggle("warning", emailState === "not_configured");
    $("#task-assignment-state").textContent = emailState === "sent" ? "Provider accepted email" : "Email not sent";
    $("#assignment-result-copy").textContent = emailState === "sent"
      ? `The delivery service accepted the email for ${workerEmail}. Check Inbox and Spam; the private link is also available below.`
      : emailState === "not_configured"
        ? `No email was sent: ${data.email_error || "email delivery is not configured"}. Copy the private link below for now.`
        : `No email was sent: ${data.email_error || "the delivery service rejected the request"}. Copy the private link below or correct the email setup and send again.`;
    $("#open-field-link").href = data.link;
    result.hidden = false;
    notify(emailState === "sent" ? "Email accepted by delivery service." : "Assignment saved, but email was not sent.", emailState === "sent" ? "success" : "error");
    await openProperty(state.property.id);
  } catch (error) {
    console.error(error);
    notify(error.message || "Field assignment failed", "error");
  } finally {
    button.disabled = false;
    button.textContent = "Send again";
  }
}

async function copyFieldLink() {
  if (!state.generatedFieldLink) return;
  await navigator.clipboard.writeText(state.generatedFieldLink);
  notify("Private field link copied.");
}

async function savePendingFiles() {
  if (!state.pendingFiles.length || state.busy) return;
  /* A site photo at the plans door is the right file at the wrong door —
     the answer is the other door, never "convert it to a PDF". */
  const media = state.pendingFiles.find((file) =>
    /^(image|video)\//.test(file.type || "") || /\.(jpe?g|png|heic|heif|gif|webp|mp4|mov|insv|insp|lrv)$/i.test(file.name || ""));
  if (media) {
    notify(`${media.name} is a site capture, not a plan document.`, "error");
    elements.message.innerHTML = `${escapeHtml(media.name)} is a photo or video — site captures are evidence and belong to a room. <a href="../?property=${encodeURIComponent(state.property?.id || "")}">Add it in Studio →</a>`;
    elements.message.className = "action-message error";
    return;
  }
  const invalid = state.pendingFiles.find((file) => file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf"));
  if (invalid) return notify(`${invalid.name} is not a PDF. Convert drawings to PDF before upload.`, "error");
  setBusy(true, "Preparing document upload…");
  const documentType = $("#document-type").value;
  const revision = $("#document-revision").value.trim() || null;
  const issuedAt = $("#document-issued").value || null;
  const uploadedDocumentIds = [];
  const uploadedDocuments = [];
  try {
    if (!window.MDAIObjectStorage) throw new Error("The secure S3 uploader did not load. Reload the page and retry.");
    for (const file of state.pendingFiles) {
      const uploadResult = await window.MDAIObjectStorage.upload({
        client,
        entityType: "project_document",
        organizationId: state.organizationId,
        propertyId: state.property.id,
        file,
        metadata: {
          document_type: documentType,
          revision_label: revision,
          issued_at: issuedAt,
          source_metadata: {
            source: "measured-decision-plan-workspace",
            last_modified: file.lastModified || null,
          },
        },
        onProgress(progress) {
          const resumeLabel = progress.resumed && progress.stage === "resuming" ? "Resuming · " : "";
          elements.sync.textContent = progress.stage === "finalizing"
            ? `Finalizing ${file.name}…`
            : `${resumeLabel}Uploading ${file.name} · ${progress.percent}% · ${progress.label}`;
        },
      });
      if (uploadResult?.record?.id) {
        uploadedDocumentIds.push(uploadResult.record.id);
        uploadedDocuments.push({ id: uploadResult.record.id, filename: file.name, mime: file.type });
        /* Larger than the provider takes in one file, and not paperwork: copy
           its pages into parts now, while the bytes are already here, so the
           owner never meets the wall at Analyze. A failure here is said and
           leaves the original exactly as uploaded — Split for analysis stays
           available on the row. */
        if (file.size > AI_INPUT_LIMIT_BYTES && !PAPERWORK_TYPES.has(documentType)) {
          try {
            const outcome = await splitAndUploadParts({
              bytes: await file.arrayBuffer(),
              original: { id: uploadResult.record.id, original_filename: file.name, byte_size: file.size,
                document_type: documentType, revision_label: revision, issued_at: issuedAt },
              onProgress: (line) => { elements.sync.textContent = line; },
            });
            uploadedDocumentIds.push(...outcome.saved);
            notify(`${file.name} is larger than one AI reading — copied into ${outcome.parts} parts for analysis; the original is kept whole.`);
          } catch (splitError) {
            notify(`${file.name} was saved, but could not be split here: ${splitError?.message || "unknown error"}. Use Split for analysis on its row from a desktop.`, "error");
          }
        }
      }
    }
    notify(`${state.pendingFiles.length} plan document${state.pendingFiles.length === 1 ? "" : "s"} saved`);
    state.pendingFiles = [];
    elements.fileInput.value = "";
    elements.uploadFields.hidden = true;
    await openProperty(state.property.id);
    /* Sources route themselves: delivery paperwork goes straight to the
       document-evidence worker, which records what the paper says was
       delivered — never installation — and refreshes reconciliation.
       The declared type was read once at the top of this function — a
       second const here shadowed it across the whole try block and made
       every upload throw before it began. */
    if (["invoice", "delivery_ticket", "receipt"].includes(documentType) && uploadedDocumentIds.length) {
      setMessage("Reading the delivery paperwork — recording what it documents as delivered…");
      for (const savedId of uploadedDocumentIds) {
        client.functions.invoke("document-evidence", { body: { document_id: savedId } })
          .then(({ data, error }) => {
            const refused = window.MDAIAiUsage?.skippedVerdict(data);
            if (refused) {
              /* Both doors into this worker — a declared invoice and a
                 classified page range — can reach the same document. The
                 second one is told the reading exists rather than buying it
                 again, and that is not an error to shout about. An unknown
                 outcome is remembered against the document, so the row can
                 offer the way out. */
              if (refused === "outcome_unknown") {
                window.MDAIAiUsage.rememberUnknown(`document-evidence:${savedId}`, data);
                renderDocuments();
              }
              notify(window.MDAIAiUsage.skippedMessage(refused));
            } else if (error || data?.error) {
              notify(data?.error || "The delivery document could not be read — it stays preserved in the record", "error");
            } else {
              notify(`Delivery recorded: ${data.lines_recorded} line${data.lines_recorded === 1 ? "" : "s"} — the Delivered column of the comparison is updated. Installation stays not-yet-evidenced until capture shows it.`);
              void openProperty(state.property.id);
            }
          });
      }
    }
    /* An undeclared PDF does not make the owner declare it. The router sends
       it to page-by-page classification; each page then routes itself to the
       door that owns it — paperwork pages to the document reader, plan pages
       stay selected for plan analysis. The owner uploaded; that was the job. */
    if (documentType === "other" && window.MDAIIntelligenceRouting) {
      for (const saved of uploadedDocuments) {
        const route = window.MDAIIntelligenceRouting.routeSource({
          filename: saved.filename, mime: saved.mime, document_type: documentType,
        });
        if (route.worker === "per-page-classification") {
          setMessage("An undeclared PDF is being read page by page — each page routes itself. Nothing to declare.");
          void classifyUploadedDocument(saved.id);
        }
      }
    }
    /* Only technical documents are offered to plan analysis. Auto-selecting
       everything — invoices included — invited exactly the wrong click. */
    const technicalIds = uploadedDocumentIds.filter((id) => {
      const uploaded = state.documents.find((document) => document.id === id);
      return uploaded ? canAnalyzeDocument(uploaded) : !PAPERWORK_TYPES.has(documentType);
    });
    if (technicalIds.length) {
      state.selectedDocumentIds = new Set(technicalIds);
      render();
      setMessage(`${technicalIds.length} new PDF${technicalIds.length === 1 ? " is" : "s are"} selected and ready for analysis.`, "success");
    }
  } catch (error) {
    console.error(error);
    notify(error.message || "Upload failed", "error");
  } finally {
    setBusy(false, `Cloud connected · ${state.role}`);
    render();
  }
}

/* One undeclared PDF, classified page by page, then chained onward. The
   classifier's answer is a reading — "Read by AI · not confirmed" — and the
   only thing it moves is routing: which worker reads which pages next. */
async function classifyUploadedDocument(documentId, options = {}) {
  const { data, error } = await client.functions.invoke("document-classify", {
    body: { document_id: documentId, force: Boolean(options.force) },
  });
  if (error || data?.error) {
    notify(data?.error || "The PDF could not be classified — it stays preserved in the record, selected for plan analysis", "error");
    return { read: false };
  }
  /* A refusal is not a reading. Before this check the code fell through to
     an empty route list and announced "Pages read by AI · not confirmed:
     nothing routable" — a sentence that says pages were read when nothing
     was. The worker said no; the screen says the same. */
  const classifierRefused = window.MDAIAiUsage?.skippedVerdict(data);
  if (classifierRefused) {
    if (classifierRefused === "outcome_unknown") {
      window.MDAIAiUsage.rememberUnknown(`document-classify:${documentId}`, data);
      renderDocuments();
    }
    notify(window.MDAIAiUsage.skippedMessage(classifierRefused));
    return { read: false, refused: classifierRefused, data };
  }
  const routes = Array.isArray(data?.routes) ? data.routes : [];
  const totalPages = Array.isArray(data?.pages) ? data.pages.length : 0;
  const CHANNEL_LABELS = { technical: "plan", documents: "paperwork", visual: "site-photo" };
  const summary = routes
    .map((route) => `${route.pages.length} ${CHANNEL_LABELS[route.channel] || route.channel} page${route.pages.length === 1 ? "" : "s"}`)
    .join(" · ");
  notify(`Pages read by AI · not confirmed: ${summary || "nothing routable"}.`);

  const documentsRoute = routes.find((route) => route.channel === "documents");
  if (documentsRoute) {
    const body = { document_id: documentId };
    /* A mixed file hands the reader only its paperwork pages; a file that is
       paperwork end to end reads whole, exactly as a declared invoice does. */
    if (documentsRoute.pages.length < totalPages) body.pages = documentsRoute.pages;
    client.functions.invoke("document-evidence", { body })
      .then(({ data: readerData, error: readerError }) => {
        const refused = window.MDAIAiUsage?.skippedVerdict(readerData);
        if (refused) {
          notify(window.MDAIAiUsage.skippedMessage(refused));
        } else if (readerError || readerData?.error) {
          notify(readerData?.error || "The delivery pages could not be read — the file stays preserved in the record", "error");
        } else {
          notify(`Delivery recorded from the classified pages: ${readerData.lines_recorded} line${readerData.lines_recorded === 1 ? "" : "s"} — the Delivered column of the comparison is updated. Installation stays not-yet-evidenced until capture shows it.`);
          void openProperty(state.property.id);
        }
      });
  }
  const technicalRoute = routes.find((route) => route.channel === "technical");
  if (technicalRoute) {
    setMessage(`${technicalRoute.pages.length} page${technicalRoute.pages.length === 1 ? "" : "s"} read as plans — the document is selected and ready for plan analysis.`, "success");
  }
  return { read: true };
  void openProperty(state.property.id);
}
window.__classifyUploadedDocument = classifyUploadedDocument;

async function monitorAnalysisJob(jobId, options = {}) {
  if (!jobId || state.analysisPolling) return;
  state.analysisPolling = true;
  if (!state.analysisStartedAt || options.resumed) startAnalysisProgress(options.resumed ? state.activeAnalysisJob : null);
  setBusy(true, options.resumed ? "Resuming saved plan analysis…" : "AI is reading the plan set…");
  setMessage(options.resumed
    ? "A saved analysis is still active. Studio is reconnecting to it now."
    : "The analysis is running in the background. You may leave this page and return later.");
  let transientFailures = 0;
  try {
    while (true) {
      let payload = null;
      try {
        const { data, error } = await client.functions.invoke("plan-analyze", {
          body: { action: "status", job_id: jobId },
        });
        if (error) throw await functionInvocationError(error, "Could not read analysis status");
        if (data?.error) throw new Error(data.error);
        payload = data;
        transientFailures = 0;
      } catch (error) {
        transientFailures += 1;
        console.warn("Analysis status check interrupted", error);
        if (transientFailures >= 6) {
          throw new Error("The analysis is still saved, but Studio cannot reach the status service. Reload this page to continue checking.");
        }
        setMessage("Connection interrupted. The job is safe; Studio is checking again…");
        await wait(Math.min(12000, 2500 * transientFailures));
        continue;
      }

      if (payload?.state === "completed") {
        const recoveredCopy = payload.recovered
          ? "The roadmap was already saved. Studio restored the completed job after the earlier connection timeout."
          : "The roadmap was saved and is ready for human approval.";
        finishAnalysisProgress(true, recoveredCopy);
        setMessage(payload.version
          ? `Baseline v${payload.version} is ready for human review.`
          : "The saved baseline is ready for human review.");
        notify(payload.recovered ? "Saved plan roadmap recovered." : "Plan roadmap generated. Review it before activation.");
        await wait(450);
        await openProperty(state.property.id);
        elements.baselineSection.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      if (["failed", "cancelled"].includes(payload?.state)) {
        throw new Error(payload.error || "Plan analysis failed");
      }
      applyServerAnalysisProgress(payload || {});
      state.activeAnalysisJob = { ...(state.activeAnalysisJob || {}), ...(payload || {}), id: jobId };
      await wait(4000);
    }
  } catch (error) {
    console.error(error);
    const serviceUnavailable = /still saved|cannot reach the status service/i.test(error.message || "");
    if (serviceUnavailable) {
      window.clearInterval(state.analysisProgressTimer);
      state.analysisProgressTimer = null;
      renderAnalysisProgress(state.analysisProgress, analysisStageIndex(state.activeAnalysisJob?.progress_stage), {
        title: "Analysis continues in the background",
        detail: error.message,
      });
      setMessage(error.message, "error");
      notify("Analysis is safe. Reload later to resume status checks.", "error");
    } else {
      finishAnalysisProgress(false, error.message || "Plan analysis failed");
      setMessage(error.message || "Plan analysis failed", "error");
      notify(error.message || "Plan analysis failed", "error");
    }
    await openProperty(state.property.id);
  } finally {
    state.analysisPolling = false;
    setBusy(false, state.activeAnalysisJob ? "Plan analysis continues in the background" : `Cloud connected · ${state.role}`);
    render();
  }
}

/* The three states of a reading that already exists.
 *
 * Primary is that it is current — a person opening this page is not here to
 * spend money, they are here to see what the plans said. Running it again is
 * possible, secondary, and asked for in words that name the cost. */
function renderAnalysisFreshness(verdict) {
  if (!elements.freshness) return;
  const known = verdict === "reused" || verdict === "running";
  elements.freshness.hidden = !known;
  if (!known) return;
  elements.freshnessState.textContent = verdict === "running"
    ? "Analysis already running"
    : "Analysis up to date";
  if (elements.reanalyze) elements.reanalyze.disabled = verdict === "running";
  if (elements.analyze) elements.analyze.hidden = true;
}

async function refreshAiUsageLine() {
  if (!window.MDAIAiUsage || !elements.aiUsageLine || !state.property?.id) return;
  const line = await window.MDAIAiUsage.usageLine(client, state.property.id);
  window.MDAIAiUsage.renderUsage(elements.aiUsageLine, line);
}

/* One key per project, so a block raised on one project never offers itself
   on another. */
function unknownKey() {
  return `plan-analyze:${state.propertyId || "unknown"}`;
}

async function analyzePlans(options = {}) {
  /* Which reader this press buys a reading from. Owners and administrators
     choose; everybody else runs the project's default. */
  const chosenProvider = chosenReader();
  const eligibility = analyzeSelectionState();
  if (eligibility.disabled) {
    if (eligibility.message) setMessage(eligibility.message, eligibility.kind);
    return;
  }
  /* One press, one job, however fast the finger. The database refuses a
     second identical reading regardless; this only spares the round trip. */
  if (window.MDAIAiUsage?.isBusy("plan-analyze")) return;
  /* An earlier reading of this set may already have run and been billed. The
     person is asked in those words before anything is sent, and a No leaves
     the block exactly where it was. */
  {
    /* The block is cleared before the retry runs, so this recursion asks once
       and then takes the ordinary path. */
    const offer = await window.MDAIAiUsage.offerUnknownRetry({
      client,
      key: unknownKey(),
      retry: () => analyzePlans(options),
    });
    if (offer.handled) {
      if (!offer.confirmed && offer.reason === "declined") {
        setMessage("Nothing was run. The earlier attempt is still unresolved.");
      }
      return;
    }
  }
  const activeDocuments = selectedDocuments();
  if (elements.freshness) elements.freshness.hidden = true;
  startAnalysisProgress();
  setBusy(true, "AI is reading the plan set…");

  /* Drawing-desk resolution first. The provider's own rasteriser draws an
     E-size sheet too small to read a finish legend, so the browser renders
     every page into high-resolution tiles the model can actually read.
     If this phone or this network cannot afford it, analysis still runs on
     the PDFs alone — said out loud, never a dead end. */
  if (window.MDAIPageRenders) {
    for (const planDocument of activeDocuments) {
      const rendered = await window.MDAIPageRenders.ensure({
        client,
        document: planDocument,
        pageOffset: (partOf(planDocument)?.page_from || 1) - 1,
        organizationId: state.organizationId,
        propertyId: state.property.id,
        onProgress: (progressMessage) => setMessage(progressMessage),
      });
      if (!rendered.ok) {
        setMessage(`High-resolution pages are unavailable here (${rendered.reason}). The AI will read the PDF at reduced sharpness — fine print may land in gaps.`, "info");
        break;
      }
    }
  }

  setMessage("Creating a governed analysis job. Large drawing sets may take several minutes.");
  try {
    const { data: job, error: jobError } = await client.from("plan_analysis_jobs").insert({
      organization_id: state.organizationId,
      property_id: state.property.id,
      document_ids: activeDocuments.map((document) => document.id),
      state: "queued",
      requested_by: state.session.user.id,
      provider: chosenProvider.provider,
      model: chosenProvider.model,
    }).select("id").single();
    if (jobError) throw jobError;
    state.activeAnalysisJob = { id: job.id, state: "queued", progress_stage: "queued", progress_percent: 4 };
    const { data, error } = await client.functions.invoke("plan-analyze", {
      body: {
        action: "start", job_id: job.id, force: Boolean(options.force),
        provider: chosenProvider.provider, model: chosenProvider.model,
      },
    });
    const refused = window.MDAIAiUsage?.skippedVerdict(data);
    if (refused) {
      state.activeAnalysisJob = null;
      setBusy(false);
      /* An unknown outcome is a decision waiting for a person, so it is
         remembered against this project and taken when they press Analyze
         again — not sprung on them as a dialog nobody asked for. */
      if (refused === "outcome_unknown") window.MDAIAiUsage.rememberUnknown(unknownKey(), data);
      setMessage(window.MDAIAiUsage.skippedMessage(refused), refused === "reused" ? "success" : "");
      renderAnalysisFreshness(refused);
      return;
    }
    if (error) {
      console.warn("Analysis start response interrupted; checking the saved job", error);
      setMessage("The start response was interrupted. The job is saved; Studio is checking its status…");
    } else if (data?.error) {
      throw new Error(data.error);
    } else {
      state.activeAnalysisJob = { ...state.activeAnalysisJob, ...(data || {}) };
      applyServerAnalysisProgress(data || {});
    }
    state.analysisPolling = false;
    await monitorAnalysisJob(job.id);
  } catch (error) {
    console.error(error);
    finishAnalysisProgress(false, error.message || "Plan analysis failed");
    setMessage(error.message || "Plan analysis failed", "error");
    notify(error.message || "Plan analysis failed", "error");
    await openProperty(state.property.id);
  } finally {
    if (!state.analysisPolling) {
      setBusy(false, state.activeAnalysisJob ? "Plan analysis continues in the background" : `Cloud connected · ${state.role}`);
      render();
    }
  }
}

async function approveBaseline() {
  if (!state.baseline || state.busy) return;
  const criticalGaps = blockingBaselineGaps();
  if (criticalGaps.length) {
    $("#attestation-blockers").innerHTML = criticalGaps.map((gap, index) =>
      `<p><b>${index + 1}</b><span>${escapeHtml(gap.question)}</span></p>`,
    ).join("");
    $("#attestation-reference").value = "";
    $("#attestation-confirmed").checked = false;
    updateAttestationAction();
    $("#attestation-dialog").showModal();
    return;
  }
  setBusy(true, "Approving baseline…");
  try {
    const { error } = await client.rpc("approve_document_baseline", { target_baseline: state.baseline.id });
    if (error) throw error;
    notify("Baseline approved. Capture roadmap is active.");
    await openProperty(state.property.id);
    void ensureIntelligenceChain("approved");
    elements.roadmapSection.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    console.error(error);
    notify(error.message || "Approval failed", "error");
  } finally {
    setBusy(false, `Cloud connected · ${state.role}`);
    render();
  }
}

async function attestAndApproveBaseline() {
  if (!state.baseline || state.busy) return;
  const approvalReference = $("#attestation-reference").value.trim();
  if (approvalReference.length < 3 || !$("#attestation-confirmed").checked) return;
  setBusy(true, "Recording manager confirmation…");
  try {
    const { error } = await client.rpc("attest_and_approve_document_baseline", {
      target_baseline: state.baseline.id,
      approval_reference: approvalReference,
    });
    if (error) throw error;
    $("#attestation-dialog").close();
    notify("Governing set confirmed. Field capture roadmap is active.");
    await openProperty(state.property.id);
    void ensureIntelligenceChain("approved");
    elements.roadmapSection.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    console.error(error);
    notify(error.message || "Governing-set confirmation failed", "error");
  } finally {
    setBusy(false, `Cloud connected · ${state.role}`);
    render();
  }
}

$("#waive-task").addEventListener("click", waiveSelectedCapture);
$("#waive-phase").addEventListener("click", waiveSelectedPhase);
$("#lift-waiver").addEventListener("click", liftSelectedWaiver);
elements.propertySelect.addEventListener("change", async () => {
  // A different project has its own roadmap; the pinned baseline no longer applies.
  state.requestedBaselineId = null;
  await openProperty(elements.propertySelect.value);
  if (state.activeAnalysisJob) void monitorAnalysisJob(state.activeAnalysisJob.id, { resumed: true });
});
elements.fileInput.addEventListener("change", () => {
  state.pendingFiles = Array.from(elements.fileInput.files || []);
  elements.uploadFields.hidden = !state.pendingFiles.length;
  elements.selectedFiles.textContent = state.pendingFiles.map((file) => `${file.name} · ${(file.size / 1048576).toFixed(1)} MB`).join("  |  ");
});
$("#cancel-upload").addEventListener("click", () => {
  state.pendingFiles = [];
  elements.fileInput.value = "";
  elements.uploadFields.hidden = true;
});
$("#confirm-upload").addEventListener("click", savePendingFiles);
elements.analyze.addEventListener("click", () => {
  if (elements.analyze.dataset.action === "operations" && state.property?.id) {
    window.location.assign(`../operations/?property=${encodeURIComponent(state.property.id)}`);
    return;
  }
  /* A second reading of an unchanged set is bought only after the sentence
     that names the cost, and it is sent as a deliberate second purchase. */
  if (elements.analyze.dataset.action === "reanalyze") {
    if (!window.MDAIAiUsage.confirmReanalyze()) return;
    void analyzePlans({ force: true });
    return;
  }
  void analyzePlans();
});
/* A finished reading, put back together from its saved parts.
 *
 * A set larger than one request is read in parts, and each part's reading is
 * saved as the provider returned it. The baseline is one deterministic merge
 * of those parts — so when the merge is corrected, the same parts can be
 * merged again without reading a page or spending anything. The offer stands
 * only for the newest completed reading, only when every one of its parts
 * has a saved reading, and only for the roles that may analyze. */
async function loadRebuildOffer(propertyId) {
  state.rebuildOffer = null;
  if (!propertyId || !state.organizationId) return;
  const { data: jobs, error: jobError } = await client.from("plan_analysis_jobs")
    .select("id, state, baseline_id, created_at")
    .eq("organization_id", state.organizationId)
    .eq("property_id", propertyId)
    .eq("state", "completed")
    .order("created_at", { ascending: false })
    .limit(6);
  if (jobError) return;
  /* A rebuild is itself a completed reading without parts; the offer looks
     past it to the newest reading that was made in parts, so the parts can
     be brought together again as often as the merge improves. */
  for (const job of jobs || []) {
    const { data: chunks, error: chunkError } = await client.from("plan_analysis_chunks")
      .select("id, state, chunk_index")
      .eq("job_id", job.id)
      .order("chunk_index", { ascending: true });
    const parts = chunkError ? [] : (chunks || []);
    if (!parts.length) continue;
    if (parts.some((chunk) => chunk.state !== "complete")) return;
    state.rebuildOffer = { jobId: job.id, parts: parts.length, baselineId: job.baseline_id };
    return;
  }
}

function renderRebuildOffer() {
  if (!elements.rebuildBlock) return;
  const offer = state.rebuildOffer;
  const shown = Boolean(offer) && canAnalyzePlans() && !state.activeAnalysisJob;
  elements.rebuildBlock.hidden = !shown;
  if (!shown) return;
  elements.rebuildNote.textContent =
    `The latest reading was made in ${offer.parts} parts. Their saved readings can be brought together again without reading the plans again — no AI is called and nothing is spent.`;
}

async function rebuildFromSavedReadings() {
  const offer = state.rebuildOffer;
  if (!offer || state.busy) return;
  await window.MDAIAiUsage.once(`rebuild:${offer.jobId}`, async () => {
    setBusy(true, "Bringing the saved readings together…");
    try {
      const { data, error } = await client.functions.invoke("plan-analyze", {
        body: { action: "rebuild", job_id: offer.jobId },
      });
      let refusal = data?.error || "";
      if (!refusal && error) {
        refusal = error.message || "The rebuild did not answer";
        try { refusal = (await error.context?.json())?.error || refusal; } catch { /* the message stands */ }
      }
      if (refusal) {
        notify(`Nothing was rebuilt: ${refusal}`, "error");
        return;
      }
      notify(`Baseline v${data.version} rebuilt from the saved readings of ${data.parts} part${data.parts === 1 ? "" : "s"}. No AI was called.`);
      await openProperty(state.property.id);
    } finally {
      setBusy(false);
    }
  });
}

/* View results is the primary action on a current analysis: it goes to the
   baseline that was already bought, and spends nothing. */
elements.viewResults?.addEventListener("click", () => {
  elements.freshness.hidden = true;
  if (elements.analyze) elements.analyze.hidden = false;
  $("#baseline-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
});
/* Reanalyze is the only path that buys a second reading of unchanged inputs,
   and it never happens without the sentence that names the cost. */
elements.rebuildButton?.addEventListener("click", () => { void rebuildFromSavedReadings(); });
elements.reanalyze?.addEventListener("click", () => {
  if (!window.MDAIAiUsage.confirmReanalyze()) return;
  elements.freshness.hidden = true;
  if (elements.analyze) elements.analyze.hidden = false;
  void analyzePlans({ force: true });
});
$("#approve-baseline").addEventListener("click", approveBaseline);
$("#divergence-approve").addEventListener("click", () => {
  $("#baseline-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
  approveBaseline();
});
$("#divergence-open-active").addEventListener("click", (event) => {
  const baselineId = event.currentTarget.dataset.baseline;
  if (!baselineId || !state.property) return;
  window.location.href =
    `${window.location.pathname}?property=${encodeURIComponent(state.property.id)}&baseline=${encodeURIComponent(baselineId)}`;
});
$("#attestation-reference").addEventListener("input", updateAttestationAction);
$("#attestation-confirmed").addEventListener("change", updateAttestationAction);
$("#confirm-governing-set").addEventListener("click", attestAndApproveBaseline);
$("#gap-answer").addEventListener("input", updateGapDialogAction);
$("#answer-gap").addEventListener("click", () => { void submitGapAnswer("answered"); });
$("#withdraw-gap").addEventListener("click", () => { void submitGapAnswer("withdrawn"); });
$("#send-field-task").addEventListener("click", createFieldAssignment);
$("#copy-field-link").addEventListener("click", copyFieldLink);
$("#phase-filter").addEventListener("change", renderRoadmap);
$("#status-filter").addEventListener("change", renderRoadmap);
$("#sign-out").addEventListener("click", async () => {
  await client.auth.signOut();
  window.location.replace("../");
});

initialize().catch((error) => {
  console.error(error);
  elements.boot.innerHTML = `<p>${escapeHtml(error.message || "Plan Intelligence could not start.")}</p>`;
});


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
