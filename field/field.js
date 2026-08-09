const config = window.MDAI_CONFIG || {};
const $ = (selector) => document.querySelector(selector);
const params = new URLSearchParams(location.search);
const access = { assignment_id: params.get("assignment") || "", token: params.get("token") || "" };
const client = window.supabase?.createClient(config.supabaseUrl, config.supabasePublishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
let current = null;
let uploaded = [];
let pollTimer = null;

function escapeHtml(value = "") { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
function text(value, fallback = "Not stated") { return typeof value === "string" && value.trim() ? value.trim() : fallback; }
function title(value = "") { return String(value).replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function dateLabel(value) { if (!value) return "Before work is covered"; const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date); }

async function workflow(action, extra = {}) {
  const response = await fetch(`${config.supabaseUrl}/functions/v1/field-workflow`, {
    method: "POST",
    headers: { apikey: config.supabasePublishableKey, Authorization: `Bearer ${config.supabasePublishableKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...access, ...extra }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Field service is unavailable");
  return payload;
}

function fillList(selector, values) {
  const element = $(selector);
  element.innerHTML = (Array.isArray(values) ? values : []).map((value) => `<li>${escapeHtml(value)}</li>`).join("") || "<li>Follow the task title and photograph the full area.</li>";
}

function render(payload) {
  current = payload.assignment;
  uploaded = payload.evidence || [];
  const info = current.instructions || {};
  $("#loading").hidden = true;
  $("#task").hidden = false;
  $("#phase").textContent = info.phase?.name || "FIELD TASK";
  $("#status").textContent = title(current.status);
  $("#title").textContent = info.title || "Field capture";
  $("#project").textContent = info.project || "Private project";
  $("#location").textContent = info.location ? `${text(info.location.building, "Project")} · ${text(info.location.level, "Level")} · ${text(info.location.name, "Area")}` : "Confirm on site";
  $("#method").textContent = title(info.capture_type);
  $("#due").textContent = dateLabel(current.due_at);
  $("#why").textContent = info.rationale || "Create a clear visual record before this work is covered.";
  $("#before").textContent = info.before_concealment || "the work is covered";
  const documentTask = info.capture_type === "document";
  $("#upload-help").textContent = documentTask
    ? "Choose the requested PDF or project document. It will be stored in the document register, not in the room photo record."
    : "Take the requested photos, video, or 360 capture. Use a PDF only when the task specifically asks for one.";
  $("#capture-label").innerHTML = `${documentTask ? "Choose document" : "Take photos or choose files"} <span>＋</span>`;
  if (documentTask) $("#files").removeAttribute("capture"); else $("#files").setAttribute("capture", "environment");
  fillList("#instructions", info.instructions);
  fillList("#must-show", info.must_show);
  fillList("#criteria", info.acceptance_criteria);
  renderUploads();
  renderResult(payload.quality_check);
  if (["sent", "opened"].includes(current.status)) workflow("start").catch(console.error);
  if (current.status === "ai_check") schedulePoll(); else stopPolling();
}

function renderUploads() {
  $("#uploads").innerHTML = uploaded.map((item) => `<div class="upload-item"><i></i><span>${escapeHtml(item.original_filename)}</span></div>`).join("");
  $("#submit").disabled = !uploaded.length || ["ai_check", "ready_for_review", "completed"].includes(current?.status);
  $("#submit-note").textContent = uploaded.length ? `${uploaded.length} file${uploaded.length === 1 ? "" : "s"} ready to check.` : "Upload at least one file first.";
}

function renderResult(check) {
  const result = $("#result");
  result.classList.remove("retake-state");
  if (!check && current?.status !== "ai_check") { result.hidden = true; return; }
  result.hidden = false;
  if (current?.status === "ai_check" || check?.state === "processing" || check?.state === "queued") {
    $("#result-icon").textContent = "…";
    $("#result-title").textContent = "Automatic check in progress";
    $("#result-summary").textContent = "You may close this page. The project manager will see the result automatically.";
    $("#retake").hidden = true;
    return;
  }
  const qc = check?.result || {};
  const retake = check?.state === "retake" || current?.status === "retake";
  result.classList.toggle("retake-state", retake);
  $("#result-icon").textContent = retake ? "!" : "✓";
  $("#result-title").textContent = retake ? "One more capture is needed" : "Upload received";
  $("#result-summary").textContent = qc.summary || "The material is ready for project review.";
  $("#retake").hidden = !retake;
  $("#retake").textContent = qc.retake_instruction || "Open the task again and add the requested view.";
}

function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }
function schedulePoll() {
  stopPolling();
  pollTimer = setTimeout(async () => {
    try { render(await workflow("get_assignment")); }
    catch (error) { console.error(error); schedulePoll(); }
  }, 4000);
}

async function uploadFiles(files) {
  if (!files.length || !current) return;
  $("#files").disabled = true;
  await workflow("uploading");
  try {
    for (const file of files) {
      $("#upload-progress").hidden = false;
      const result = await window.MDAIObjectStorage.upload({
        client,
        entityType: "evidence",
        organizationId: current.upload_scope.organization_id,
        propertyId: current.upload_scope.property_id,
        spaceId: current.upload_scope.space_id,
        file,
        fieldAccess: access,
        metadata: {
          media_type: current.instructions.capture_type === "360" ? "360 capture" : "Field assignment",
          document_type: current.instructions.capture_type === "document" ? "other" : undefined,
          captured_at: new Date().toISOString(),
          capture_task_id: current.upload_scope.capture_task_id,
          baseline_id: current.upload_scope.baseline_id,
          source_metadata: { subject: current.instructions.title, context: "secure-field-portal" },
        },
        onProgress(progress) {
          $("#progress-label").textContent = progress.stage === "finalizing" ? "Saving secure record" : "Uploading";
          $("#progress-value").textContent = `${progress.percent}%`;
          $("#progress-fill").style.width = `${progress.percent}%`;
          $("#progress-detail").textContent = progress.label;
        },
      });
      uploaded.push(result.record);
      renderUploads();
    }
    $("#upload-progress").hidden = true;
  } catch (error) {
    $("#progress-label").textContent = "Upload stopped";
    $("#progress-detail").textContent = error.message;
    throw error;
  } finally { $("#files").disabled = false; }
}

$("#files").addEventListener("change", async () => { try { await uploadFiles(Array.from($("#files").files || [])); $("#files").value = ""; } catch (error) { alert(error.message); } });
$("#submit").addEventListener("click", async () => {
  try {
    $("#submit").disabled = true;
    $("#submit-note").textContent = "Starting automatic check…";
    await workflow("submit");
    render(await workflow("get_assignment"));
  } catch (error) { $("#submit-note").textContent = error.message; $("#submit").disabled = false; }
});

(async () => {
  try {
    if (!access.assignment_id || !access.token) throw new Error("Open the complete private link from your assignment email.");
    render(await workflow("get_assignment"));
  } catch (error) { $("#loading").hidden = true; $("#error").hidden = false; $("#error-message").textContent = error.message; }
})();
