const config = window.MDAI_CONFIG || {};
const $ = (selector) => document.querySelector(selector);
const AI_INPUT_LIMIT_BYTES = 49 * 1024 * 1024;

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
  requirements: [],
  tasks: [],
  assignments: [],
  qualityChecks: [],
  selectedRequirementId: null,
  generatedFieldLink: null,
  pendingFiles: [],
  selectedDocumentIds: new Set(),
  busy: false,
  analysisStartedAt: null,
  analysisProgressTimer: null,
  analysisProgress: 0,
  analysisStage: 0,
  activeAnalysisJob: null,
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
  elements.analysisStageDetail.textContent = options.detail || stage.detail;
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

function updateAnalysisProgress() {
  const elapsedSeconds = (Date.now() - state.analysisStartedAt) / 1000;
  const snapshot = progressSnapshot(elapsedSeconds);
  renderAnalysisProgress(Math.max(state.analysisProgress, snapshot.percent), Math.max(state.analysisStage, snapshot.stage));
}

function startAnalysisProgress() {
  window.clearInterval(state.analysisProgressTimer);
  state.analysisStartedAt = Date.now();
  state.analysisProgress = 0;
  state.analysisStage = 0;
  state.analysisOutcome = null;
  elements.analysisProgress.className = "analysis-progress";
  updateAnalysisProgress();
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
  if (!documents.length) return { disabled: true, label: "Select ready PDFs", message: "Select one or more ready PDFs to build a new baseline.", kind: "info" };

  const unavailable = documents.find((document) => document.status !== "ready");
  if (unavailable) return { disabled: true, label: "Wait for PDFs to be ready", message: `${unavailable.original_filename} is not ready for analysis yet.`, kind: "info" };

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
    message: `${documents.length} ready PDF${documents.length === 1 ? "" : "s"} selected · ${formatMegabytes(totalBytes)} of 49 MB.`,
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
  window.history.replaceState({}, "", `${window.location.pathname}?property=${encodeURIComponent(propertyId)}`);
  document.querySelectorAll('a[href="../operations/"],a[href^="../operations/?property="]').forEach((link) => {
    link.href = `../operations/?property=${encodeURIComponent(propertyId)}`;
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
      .limit(1),
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
  state.baseline = baselinesResult.data?.[0] || null;
  state.activeAnalysisJob = activeJobResult.data?.[0] || null;
  const readyDocumentIds = new Set(state.documents.filter((document) => document.status === "ready").map((document) => document.id));
  const baselineDocumentIds = (state.baseline?.source_document_ids || []).filter((id) => readyDocumentIds.has(id));
  state.selectedDocumentIds = new Set(baselineDocumentIds.length ? baselineDocumentIds : readyDocumentIds);
  state.phases = [];
  state.planSpaces = [];
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
  renderDocuments();
  renderBaseline();
  renderRoadmap();
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
  $("#step-analyze").classList.toggle("done", Boolean(state.baseline));
  $("#step-approve").classList.toggle("done", state.baseline?.state === "approved");
  $("#step-capture").classList.toggle("done", state.tasks.some((task) => ["submitted", "verified"].includes(task.status)));
}

function renderDocuments() {
  elements.documentEmpty.hidden = state.documents.length > 0;
  elements.documentList.hidden = state.documents.length === 0;
  elements.documentList.innerHTML = state.documents.map((document) => {
    const selectable = document.status === "ready";
    const choiceTitle = selectable ? "Include in a new baseline" : `Available after the PDF is ready (${label(document.status)})`;
    const baselineVersion = (state.baseline?.source_document_ids || []).includes(document.id)
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
  $("#send-field-task").disabled = !canApproveBaseline() || ["blocked", "waived", "submitted", "verified"].includes(task.status);
  $("#send-field-task").textContent = assignment ? "Send again" : "Send field task";
  $("#task-dialog").showModal();
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
  try {
    if (!window.MDAIObjectStorage) throw new Error("The secure S3 uploader did not load. Reload the page and retry.");
    for (const file of state.pendingFiles) {
      await window.MDAIObjectStorage.upload({
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
    }
    notify(`${state.pendingFiles.length} plan document${state.pendingFiles.length === 1 ? "" : "s"} saved`);
    state.pendingFiles = [];
    elements.fileInput.value = "";
    elements.uploadFields.hidden = true;
    await openProperty(state.property.id);
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
  if (!state.analysisStartedAt || options.resumed) startAnalysisProgress();
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

elements.propertySelect.addEventListener("change", async () => {
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
