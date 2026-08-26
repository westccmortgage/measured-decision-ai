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
  requirements: [],
  tasks: [],
  assignments: [],
  qualityChecks: [],
  selectedRequirementId: null,
  requestedBaselineId: new URLSearchParams(window.location.search).get("baseline"),
  baselines: [],
  activeBaseline: null,
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
  elements.analysisProgressValue.textContent = `${bounded}%`;
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
      title: "Baseline ready for review",
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

function canAnalyzeDocument(document) {
  return ANALYZABLE_DOCUMENT_STATUSES.has(document?.status);
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
    return {
      disabled: !approved,
      label: approved ? "Open Field Operations" : `Baseline v${state.baseline.version} is ready`,
      message: approved
        ? `Baseline v${state.baseline.version} is approved and the roadmap is active. Continue in Field Operations.`
        : "This exact plan set is already analyzed. Next: review the baseline below and activate the roadmap.",
      kind: "success",
      action: approved ? "operations" : "analyze",
    };
  }

  const totalBytes = documents.reduce((sum, document) => sum + Number(document.byte_size || 0), 0);
  const oversized = documents.find((document) => Number(document.byte_size || 0) > AI_INPUT_LIMIT_BYTES);
  if (oversized || totalBytes > AI_INPUT_LIMIT_BYTES) {
    return {
      disabled: true,
      label: "Select a smaller PDF set",
      message: oversized
        ? `${oversized.original_filename} exceeds the 49 MB analysis limit. Keep the original here and add an optimized PDF copy.`
        : `${documents.length} selected PDFs total ${formatMegabytes(totalBytes)}. Select a set below 49 MB or add optimized PDF copies.`,
      kind: "warning",
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
  await openProperty(initial.id);
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
      .select("id, storage_path, storage_provider, storage_bucket, object_version_id, original_filename, mime_type, byte_size, document_type, revision_label, issued_at, status, processing_error, created_at")
      .eq("organization_id", state.organizationId)
      .eq("property_id", propertyId)
      .order("created_at", { ascending: false }),
    client.from("document_baselines")
      .select("id, version, state, source_document_ids, project_summary, analysis, gaps, model, created_at, approved_at")
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
  render();
  elements.sync.textContent = state.activeAnalysisJob
    ? "Plan analysis continues in the background"
    : `Cloud connected · ${state.role}`;
}

function render() {
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
  renderRoadmap();
  renderRoutes();
  renderTakeoff();
  renderOwnerSummary();
  if (state.baseline && !state.activeAnalysisJob && state.analysisOutcome !== "failed") {
    const approved = state.baseline.state === "approved";
    renderAnalysisProgress(100, analysisStages.length - 1, {
      success: true,
      title: approved ? "Roadmap active" : "Baseline ready for review",
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

function renderDocuments() {
  elements.documentEmpty.hidden = state.documents.length > 0;
  elements.documentList.hidden = state.documents.length === 0;
  elements.documentList.innerHTML = state.documents.map((document) => {
    const selectable = canAnalyzeDocument(document);
    const choiceTitle = document.status === "failed"
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
    return `
    <article class="document-row">
      <label class="document-choice" title="${escapeHtml(choiceTitle)}"><input type="checkbox" data-document-select="${document.id}" ${state.selectedDocumentIds.has(document.id) ? "checked" : ""} ${selectable ? "" : "disabled"}><span class="document-icon">PDF</span></label>
      <div class="document-name"><strong title="${escapeHtml(document.original_filename)}">${escapeHtml(document.original_filename)}</strong><small>${document.byte_size ? `${(document.byte_size / 1048576).toFixed(1)} MB` : "Private source"}</small></div>
      <div class="document-cell"><span>Discipline</span><strong>${escapeHtml(label(document.document_type))}</strong></div>
      <div class="document-cell"><span>Revision</span><strong>${escapeHtml(display(document.revision_label, "Not stated"))}</strong></div>
      <span class="document-status ${document.status}" title="${escapeHtml(document.processing_error || "")}">${escapeHtml(label(document.status))}</span>
      ${canDeletePlans() ? `<button class="document-delete" type="button" data-document-delete="${document.id}" title="${escapeHtml(deleteTitle)}" aria-label="${escapeHtml(deleteTitle)}" ${baselineVersion ? "disabled" : ""}>Delete</button>` : ""}
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
  if ((!walls.length && !decks.length) || !window.MDAITakeoff360) return null;
  return { walls, decks, result: window.MDAITakeoff360.takeoff(walls, decks) };
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
      const shownValue = review?.verdict === "corrected" ? review.value : `${line.quantity} ${line.unit || ""}`;
      return `<tr${line.status === "hold" ? ` class="review"` : ""}><td>${escapeHtml(line.item)}
        <small class="line-meta">${escapeHtml(takeoffLineMeta(line, review))}${line.hold_reason ? ` — ${escapeHtml(line.hold_reason)}` : ""}</small></td>
        <td>${escapeHtml(String(shownValue))}</td></tr>`;
    }),
    ...proposals.map((proposal) => {
      const review = reviews.get(proposal.question);
      const shownValue = review && review.verdict !== "kept_open" ? review.value : proposal.proposed;
      return `<tr><td>${escapeHtml(proposal.question)}
        <small class="line-meta">AI plan count · ${escapeHtml(proposal.confidence)} confidence · ${escapeHtml(proposal.basis)}${review && review.verdict !== "kept_open" ? ` · HUMAN_CONFIRMED by ${escapeHtml(review.reviewer_role)}` : " · proposed, not confirmed"}</small></td>
        <td>${escapeHtml(String(shownValue))}</td></tr>`;
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
  downloadWorkbook(aiTakeoffSheets(draft, state.property?.name || "project"), "ai-takeoff");
  notify("The AI takeoff is downloading — no signature needed; every row carries its provenance.");
});

$("#download-takeoff")?.addEventListener("click", () => {
  const draft = takeoffDraft();
  if (!draft) return;
  const confirmed = [...activeReviews().values()].filter((review) => review.verdict !== "kept_open");
  if (!confirmed.length) { notify("Nothing is human-confirmed yet — that takes line-by-line expert review", "error"); return; }
  downloadWorkbook(verifiedOrderSheets(draft, state.property?.name || "project"), "verified-order");
  notify("The human-verified order is downloading.");
});

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
  const hasAnalysis = Boolean(state.baseline) && Boolean(draft);
  section.hidden = !hasAnalysis;
  document.body.classList.toggle("summary-mode", hasAnalysis && state.summaryMode !== false);
  if (!hasAnalysis) return;

  const gaps = takeoffOpenGaps(draft);
  const proposals = draft.result.proposals || [];
  const lines = draft.result.lines || [];
  const holds = lines.filter((line) => line.status === "hold");
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

  /* Five numbers, no more. Counted from the record, like everything here. */
  const sheetCount = Array.isArray(state.baseline.source_document_ids) ? state.baseline.source_document_ids.length : 0;
  const deckArea = (state.baseline.analysis?.framing_decks || [])
    .map((deck) => window.MDAITakeoff360.parsePrintedNumber?.(deck.area_sqft))
    .find((value) => value > 0);
  const principal = [...lines].sort((a, b) => (b.quantity || 0) - (a.quantity || 0))[0];
  const numbers = [
    { value: sheetCount, label: `plan sheet${sheetCount === 1 ? "" : "s"} analyzed` },
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
  ].slice(0, 8);
  $("#summary-table tbody").innerHTML = previewRows.map((row) =>
    `<tr><td>${escapeHtml(row.item)}</td><td>${escapeHtml(row.qty)}</td><td>${escapeHtml(row.basis)}</td><td><span class="summary-chip ${escapeHtml(row.status.toLowerCase())}">${escapeHtml(row.status)}</span></td></tr>`).join("");

  /* Three issues: holds first (money waits on them), then RFIs. */
  const issues = [
    ...holds.map((line) => ({ title: line.item.split(" — ")[0], impact: line.hold_reason || "On hold before procurement.", status: "Hold" })),
    ...gaps.filter((gap) => !/^.*HOLD — /.test(gap)).map((gap) => {
      const [head, ...rest] = gap.split(": ");
      return { title: rest.length ? rest.join(": ").split(" is scheduled")[0].split(" — ")[0].slice(0, 60) : head.slice(0, 60), impact: gap, status: "RFI" };
    }),
  ].slice(0, 3);
  $("#summary-issues").innerHTML = issues.length
    ? issues.map((issue) => `<div class="summary-issue"><p><strong>${escapeHtml(issue.title)}</strong> <span class="summary-chip ${issue.status.toLowerCase()}">${escapeHtml(issue.status)}</span></p><small>${escapeHtml(issue.impact)}</small></div>`).join("")
    : `<p class="summary-clear">No open issues — the sheets answered everything asked of them.</p>`;
}

function exitSummaryMode(scrollTo) {
  state.summaryMode = false;
  document.body.classList.remove("summary-mode");
  if (scrollTo) document.querySelector(scrollTo)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

$("#summary-download")?.addEventListener("click", () => $("#download-ai-takeoff")?.click());
$("#summary-full")?.addEventListener("click", () => exitSummaryMode("#takeoff-section"));
$("#summary-rfis")?.addEventListener("click", () => exitSummaryMode("#takeoff-gaps"));
$("#summary-view-takeoff")?.addEventListener("click", (event) => { event.preventDefault(); exitSummaryMode("#takeoff-section"); });
$("#summary-all-rfis")?.addEventListener("click", (event) => { event.preventDefault(); exitSummaryMode("#takeoff-gaps"); });

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
  approvalGuidance.hidden = !blockingGaps.length;
  approvalGuidance.textContent = blockingGaps.length
    ? `AI reported ${blockingGaps.length} blocking plan question${blockingGaps.length === 1 ? "" : "s"}. If this is the official approved set, an authorized manager can acknowledge those items, record the approval reference, and activate the roadmap.`
    : "";
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
  $("#gap-list").innerHTML = gaps.length
    ? gaps.map((gap) => `<div class="gap-item ${escapeHtml(gap.severity)}"><i></i><span>${escapeHtml(gap.question)}${gap.blocks_activation ? " · Blocks activation" : ""}</span></div>`).join("")
    : '<div class="gap-item"><i></i><span>No unresolved gaps were reported. Human review is still required.</span></div>';
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
  const invalid = state.pendingFiles.find((file) => file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf"));
  if (invalid) return notify(`${invalid.name} is not a PDF. Convert drawings to PDF before upload.`, "error");
  setBusy(true, "Preparing document upload…");
  const documentType = $("#document-type").value;
  const revision = $("#document-revision").value.trim() || null;
  const issuedAt = $("#document-issued").value || null;
  const uploadedDocumentIds = [];
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
      if (uploadResult?.record?.id) uploadedDocumentIds.push(uploadResult.record.id);
    }
    notify(`${state.pendingFiles.length} plan document${state.pendingFiles.length === 1 ? "" : "s"} saved`);
    state.pendingFiles = [];
    elements.fileInput.value = "";
    elements.uploadFields.hidden = true;
    await openProperty(state.property.id);
    if (uploadedDocumentIds.length) {
      state.selectedDocumentIds = new Set(uploadedDocumentIds);
      render();
      setMessage(`${uploadedDocumentIds.length} new PDF${uploadedDocumentIds.length === 1 ? " is" : "s are"} selected and ready for analysis.`, "success");
    }
  } catch (error) {
    console.error(error);
    notify(error.message || "Upload failed", "error");
  } finally {
    setBusy(false, `Cloud connected · ${state.role}`);
    render();
  }
}

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

async function analyzePlans() {
  const eligibility = analyzeSelectionState();
  if (eligibility.disabled) {
    if (eligibility.message) setMessage(eligibility.message, eligibility.kind);
    return;
  }
  const activeDocuments = selectedDocuments();
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
    }).select("id").single();
    if (jobError) throw jobError;
    state.activeAnalysisJob = { id: job.id, state: "queued", progress_stage: "queued", progress_percent: 4 };
    const { data, error } = await client.functions.invoke("plan-analyze", {
      body: { action: "start", job_id: job.id },
    });
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
  void analyzePlans();
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
