const config = window.MDAI_CONFIG || {};
const $ = (selector) => document.querySelector(selector);

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
  pendingFiles: [],
  selectedDocumentIds: new Set(),
  busy: false,
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
  elements.toast.textContent = message;
  elements.toast.className = `toast show ${kind === "error" ? "error" : ""}`;
  window.clearTimeout(notify.timer);
  notify.timer = window.setTimeout(() => elements.toast.classList.remove("show"), 5000);
}

function setMessage(message = "", kind = "") {
  elements.message.textContent = message;
  elements.message.className = `action-message ${kind}`;
}

function safeStorageName(name) {
  const parts = name.split(".");
  const extension = parts.length > 1 ? `.${parts.pop().toLowerCase()}` : "";
  const base = parts.join(".").normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${(base || "plan").slice(0, 100)}${extension}`;
}

function shortDate(value) {
  if (!value) return "Not stated";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function taskForRequirement(requirementId) {
  return state.tasks.find((task) => task.requirement_id === requirementId) || { status: "blocked" };
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

function setBusy(busy, message = "") {
  state.busy = busy;
  elements.analyze.disabled = busy || !canAnalyzePlans() || !state.selectedDocumentIds.size;
  $("#confirm-upload").disabled = busy || !canUploadPlans();
  $("#approve-baseline").disabled = busy || !canApproveBaseline() || state.baseline?.state === "approved";
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
}

async function openProperty(propertyId) {
  state.property = state.properties.find((property) => property.id === propertyId) || null;
  if (!state.property) return;
  window.history.replaceState({}, "", `${window.location.pathname}?property=${encodeURIComponent(propertyId)}`);
  elements.sync.textContent = "Loading project…";
  setMessage("");
  const [documentsResult, baselinesResult] = await Promise.all([
    client.from("project_documents")
      .select("id, storage_path, original_filename, mime_type, byte_size, document_type, revision_label, issued_at, status, processing_error, created_at")
      .eq("organization_id", state.organizationId)
      .eq("property_id", propertyId)
      .order("created_at", { ascending: false }),
    client.from("document_baselines")
      .select("id, version, state, source_document_ids, project_summary, analysis, gaps, model, created_at, approved_at")
      .eq("organization_id", state.organizationId)
      .eq("property_id", propertyId)
      .order("version", { ascending: false })
      .limit(1),
  ]);
  if (documentsResult.error || baselinesResult.error) {
    const error = documentsResult.error || baselinesResult.error;
    notify(error.message, "error");
    elements.sync.textContent = "Cloud query failed";
    return;
  }
  state.documents = documentsResult.data || [];
  state.selectedDocumentIds = new Set(
    state.documents.filter((document) => document.status !== "superseded").map((document) => document.id),
  );
  state.baseline = baselinesResult.data?.[0] || null;
  state.phases = [];
  state.planSpaces = [];
  state.requirements = [];
  state.tasks = [];
  if (state.baseline) {
    const [phaseResult, spaceResult, requirementResult, taskResult] = await Promise.all([
      client.from("construction_phases").select("*").eq("baseline_id", state.baseline.id).order("sequence"),
      client.from("plan_spaces").select("*").eq("baseline_id", state.baseline.id),
      client.from("capture_requirements").select("*").eq("baseline_id", state.baseline.id).order("created_at"),
      client.from("capture_tasks").select("*").eq("baseline_id", state.baseline.id).order("created_at"),
    ]);
    const loadError = phaseResult.error || spaceResult.error || requirementResult.error || taskResult.error;
    if (loadError) notify(loadError.message, "error");
    state.phases = phaseResult.data || [];
    state.planSpaces = spaceResult.data || [];
    state.requirements = requirementResult.data || [];
    state.tasks = taskResult.data || [];
  }
  render();
  elements.sync.textContent = `Cloud connected · ${state.role}`;
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
  elements.analyze.disabled = state.busy || !canAnalyzePlans() || !state.selectedDocumentIds.size;
  $("#upload-plans-label").hidden = !canUploadPlans();
  renderDocuments();
  renderBaseline();
  renderRoadmap();
  $("#step-analyze").classList.toggle("done", Boolean(state.baseline));
  $("#step-approve").classList.toggle("done", state.baseline?.state === "approved");
  $("#step-capture").classList.toggle("done", state.tasks.some((task) => ["submitted", "verified"].includes(task.status)));
}

function renderDocuments() {
  elements.documentEmpty.hidden = state.documents.length > 0;
  elements.documentList.hidden = state.documents.length === 0;
  elements.documentList.innerHTML = state.documents.map((document) => `
    <article class="document-row">
      <label class="document-choice" title="Include in the next baseline"><input type="checkbox" data-document-select="${document.id}" ${state.selectedDocumentIds.has(document.id) ? "checked" : ""}><span class="document-icon">PDF</span></label>
      <div class="document-name"><strong title="${escapeHtml(document.original_filename)}">${escapeHtml(document.original_filename)}</strong><small>${document.byte_size ? `${(document.byte_size / 1048576).toFixed(1)} MB` : "Private source"}</small></div>
      <div class="document-cell"><span>Discipline</span><strong>${escapeHtml(label(document.document_type))}</strong></div>
      <div class="document-cell"><span>Revision</span><strong>${escapeHtml(display(document.revision_label, "Not stated"))}</strong></div>
      <span class="document-status ${document.status}" title="${escapeHtml(document.processing_error || "")}">${escapeHtml(label(document.status))}</span>
    </article>
  `).join("");
  elements.documentList.querySelectorAll("[data-document-select]").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) state.selectedDocumentIds.add(input.dataset.documentSelect);
      else state.selectedDocumentIds.delete(input.dataset.documentSelect);
      elements.analyze.disabled = state.busy || !canAnalyzePlans() || !state.selectedDocumentIds.size;
      setMessage(`${state.selectedDocumentIds.size} document${state.selectedDocumentIds.size === 1 ? "" : "s"} selected for the next baseline.`);
    });
  });
}

function renderBaseline() {
  elements.baselineSection.hidden = !state.baseline;
  if (!state.baseline) return;
  $("#baseline-state").textContent = `${label(state.baseline.state)} · v${state.baseline.version}`;
  $("#baseline-state").className = `state-pill ${state.baseline.state}`;
  $("#approve-baseline").hidden = state.baseline.state === "approved" || !canApproveBaseline();
  $("#approve-baseline").disabled = state.busy || !canApproveBaseline();
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
  const space = planSpace(requirement.plan_space_id);
  const location = space ? `${space.building} · ${space.level} · ${space.name}` : "Project-wide / location to confirm";
  const refs = Array.isArray(requirement.plan_refs) ? requirement.plan_refs : [];
  return `
    <button class="task-card" type="button" data-requirement="${requirement.id}">
      <div class="task-topline"><span class="task-priority ${requirement.priority}">${escapeHtml(requirement.priority)}</span><span class="task-status ${task.status}">${escapeHtml(label(task.status))}</span></div>
      <h3>${escapeHtml(requirement.title)}</h3>
      <p class="task-location">${escapeHtml(location)}</p>
      <p class="task-why">${escapeHtml(requirement.rationale)}</p>
      <div class="task-bottom"><strong>${escapeHtml(requirement.capture_type)}</strong><span>${refs.length} plan reference${refs.length === 1 ? "" : "s"} · ${escapeHtml(phase.code)}</span></div>
    </button>`;
}

function openTask(requirementId) {
  const requirement = state.requirements.find((item) => item.id === requirementId);
  if (!requirement) return;
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
  $("#task-dialog").showModal();
}

async function uploadResumable(file, storagePath) {
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  const currentSession = sessionData?.session;
  if (sessionError || !currentSession?.access_token) {
    throw new Error("Your secure session expired. Sign out, sign back in, and retry.");
  }
  state.session = currentSession;
  const projectId = new URL(config.supabaseUrl).hostname.split(".")[0];
  return new Promise((resolve, reject) => {
    const upload = new window.tus.Upload(file, {
      endpoint: `https://${projectId}.storage.supabase.co/storage/v1/upload/resumable`,
      headers: {
        authorization: `Bearer ${currentSession.access_token}`,
        "x-upsert": "false",
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      retryDelays: [0, 1000, 3000, 5000, 10000],
      chunkSize: 6 * 1024 * 1024,
      metadata: {
        bucketName: "project-documents",
        objectName: storagePath,
        contentType: "application/pdf",
        cacheControl: "3600",
      },
      onError: reject,
      onProgress(bytesUploaded, bytesTotal) {
        const percent = Math.round((bytesUploaded / bytesTotal) * 100);
        elements.sync.textContent = `Uploading ${file.name} · ${percent}%`;
      },
      onSuccess: () => resolve(upload.url),
    });
    upload.findPreviousUploads().then((previous) => {
      if (previous.length) upload.resumeFromPreviousUpload(previous[0]);
      upload.start();
    }).catch(reject);
  });
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
    for (const file of state.pendingFiles) {
      const documentId = crypto.randomUUID();
      const storagePath = `${state.organizationId}/${state.property.id}/${documentId}-${safeStorageName(file.name)}`;
      await uploadResumable(file, storagePath);
      const { error } = await client.from("project_documents").insert({
        id: documentId,
        organization_id: state.organizationId,
        property_id: state.property.id,
        storage_path: storagePath,
        original_filename: file.name,
        mime_type: "application/pdf",
        byte_size: file.size,
        document_type: documentType,
        revision_label: revision,
        issued_at: issuedAt,
        status: "uploaded",
        created_by: state.session.user.id,
      });
      if (error) {
        await client.storage.from("project-documents").remove([storagePath]);
        throw error;
      }
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

async function analyzePlans() {
  if (!state.selectedDocumentIds.size || state.busy) return;
  const activeDocuments = state.documents.filter((document) => state.selectedDocumentIds.has(document.id));
  const totalBytes = activeDocuments.reduce((sum, document) => sum + Number(document.byte_size || 0), 0);
  const oversized = activeDocuments.find((document) => Number(document.byte_size || 0) > 49 * 1024 * 1024);
  if (oversized || totalBytes > 49 * 1024 * 1024) {
    const message = oversized
      ? `${oversized.original_filename} is larger than the AI input limit. Preserve it here, then upload an optimized PDF copy for analysis.`
      : "The active plan set is larger than the AI input limit. Analyze smaller discipline sets or add optimized PDF copies.";
    setMessage(message, "error");
    notify(message, "error");
    return;
  }
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
    const { data, error } = await client.functions.invoke("plan-analyze", { body: { job_id: job.id } });
    if (error) {
      let detail = error.message;
      try { detail = (await error.context?.json())?.error || detail; } catch (_) { /* response may not be JSON */ }
      throw new Error(detail);
    }
    if (data?.error) throw new Error(data.error);
    setMessage(`Baseline v${data.version} is ready for human review.`);
    notify("Plan roadmap generated. Review it before activation.");
    await openProperty(state.property.id);
    elements.baselineSection.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    console.error(error);
    setMessage(error.message || "Plan analysis failed", "error");
    notify(error.message || "Plan analysis failed", "error");
    await openProperty(state.property.id);
  } finally {
    setBusy(false, `Cloud connected · ${state.role}`);
    render();
  }
}

async function approveBaseline() {
  if (!state.baseline || state.busy) return;
  const criticalGaps = (state.baseline.gaps || []).filter((gap) => gap.blocks_activation);
  if (criticalGaps.length) {
    const message = `${criticalGaps.length} blocking plan gap${criticalGaps.length === 1 ? "" : "s"} must be resolved. Upload the missing or corrected document and generate a new baseline.`;
    notify(message, "error");
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

elements.propertySelect.addEventListener("change", () => openProperty(elements.propertySelect.value));
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
elements.analyze.addEventListener("click", analyzePlans);
$("#approve-baseline").addEventListener("click", approveBaseline);
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
