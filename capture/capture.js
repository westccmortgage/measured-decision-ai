const config = window.MDAI_CONFIG || {};
const $ = (selector) => document.querySelector(selector);
const params = new URLSearchParams(location.search);
const access = { session_id: params.get("session") || "", token: params.get("token") || "" };
// The guest page deliberately does not load a third-party auth SDK. This tiny
// adapter exposes only the one Edge Function call needed by the multipart
// uploader, keeping the private token and upload surface narrowly scoped.
const client = config.supabaseUrl && config.supabasePublishableKey ? {
  functions: {
    async invoke(name, { body }) {
      const response = await fetch(`${config.supabaseUrl}/functions/v1/${name}`, {
        method: "POST",
        headers: { apikey: config.supabasePublishableKey, Authorization: `Bearer ${config.supabasePublishableKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const context = response.clone();
      const data = await response.json().catch(() => ({}));
      return response.ok ? { data, error: null } : { data: null, error: { message: data.error || "Upload service is unavailable", context } };
    },
  },
} : null;
const state = { session: null, property: null, scope: null, items: [], openItemId: null, localUrls: new Map() };

function escapeHtml(value = "") { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
function bytes(value) { return window.MDAIObjectStorage?.humanBytes(value) || `${Math.round(Number(value || 0) / 1048576)} MB`; }
function seconds(value) { const number = Number(value || 0); return `${number.toFixed(1)}s`; }
function clamp(value, minimum, maximum) { return Math.min(maximum, Math.max(minimum, Number(value))); }

async function api(action, extra = {}) {
  const response = await fetch(`${config.supabaseUrl}/functions/v1/capture-session`, {
    method: "POST",
    headers: { apikey: config.supabasePublishableKey, Authorization: `Bearer ${config.supabasePublishableKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...access, ...extra }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Capture service is unavailable");
  return payload;
}

function readVideo(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.addEventListener("loadedmetadata", () => resolve({
      url,
      duration: Number(video.duration || 0),
      width: Number(video.videoWidth || 0),
      height: Number(video.videoHeight || 0),
      projection: video.videoWidth / Math.max(1, video.videoHeight) >= 1.9 && video.videoWidth / Math.max(1, video.videoHeight) <= 2.1 ? "equirectangular" : "unknown",
    }), { once: true });
    video.addEventListener("error", () => { URL.revokeObjectURL(url); reject(new Error(`Could not read ${file.name}. Use an MP4 that plays on this device.`)); }, { once: true });
    video.src = url;
  });
}

function normalizedItem(item) {
  const duration = Number(item.source_duration_seconds || 0);
  return {
    ...item,
    room_name: item.room_name || "",
    start: Number(item.confirmed_trim_start_seconds ?? item.suggested_trim_start_seconds ?? 0),
    end: Number(item.confirmed_trim_end_seconds ?? item.suggested_trim_end_seconds ?? duration),
    duration,
  };
}

function render() {
  $("#loading").hidden = true;
  $("#session").hidden = false;
  $("#session-title").textContent = state.session?.label || "Upload room captures";
  $("#project-name").textContent = state.property?.name || "Private project";
  state.items = state.items.map(normalizedItem);
  $("#empty-items").hidden = state.items.length > 0;
  $("#items").innerHTML = state.items.map((item, index) => {
    const isOpen = state.openItemId === item.id;
    const confirmed = Boolean(item.trim_confirmed);
    const warning = item.projection === "equirectangular" ? "360 · 2:1 detected" : "Check format · 2:1 not confirmed";
    return `<article class="item ${confirmed ? "saved" : ""}" data-item="${item.id}">
      <div class="item-header"><span class="item-state">${confirmed ? "✓" : index + 1}</span><div class="item-name"><strong>${escapeHtml(item.room_name || `Room ${index + 1}`)}</strong><small>${escapeHtml(item.original_filename)} · ${escapeHtml(bytes(item.byte_size))} · ${escapeHtml(warning)}</small></div><button class="item-toggle" type="button" data-toggle="${item.id}">${isOpen ? "Close" : confirmed ? "Edit" : "Review"}</button></div>
      <div class="item-editor" ${isOpen ? "" : "hidden"}>
        ${isOpen ? `<video controls playsinline preload="metadata" data-video="${item.id}"></video>` : ""}
        <label class="room-field">Room name<input data-room="${item.id}" value="${escapeHtml(item.room_name)}" placeholder="Example: Living room"></label>
        <div class="trim-title"><span>Keep this part of the video</span><strong data-range-label="${item.id}">${seconds(item.start)} – ${seconds(item.end)}</strong></div>
        <p class="trim-help">Play or scrub to the first clean frame, then tap Start here. Do the same at the last clean frame.</p>
        <div class="mark-actions"><button type="button" data-mark-start="${item.id}">Set start here</button><button type="button" data-mark-end="${item.id}">Set end here</button></div>
        <details class="fine-tune"><summary>Fine-tune seconds</summary><div class="trim-values"><label>Start<input type="number" min="0" max="${item.duration}" step="0.1" value="${item.start}" data-start="${item.id}"></label><label>End<input type="number" min="0" max="${item.duration}" step="0.1" value="${item.end}" data-end="${item.id}"></label></div></details>
        <div class="item-actions"><button class="remove-item" type="button" data-remove="${item.id}">Remove video</button><button class="save-item" type="button" data-save="${item.id}">Confirm room & trim</button></div>
      </div>
    </article>`;
  }).join("");

  for (const button of document.querySelectorAll("[data-toggle]")) button.addEventListener("click", () => { state.openItemId = state.openItemId === button.dataset.toggle ? null : button.dataset.toggle; render(); });
  for (const button of document.querySelectorAll("[data-save]")) button.addEventListener("click", () => saveItem(button.dataset.save, button));
  for (const button of document.querySelectorAll("[data-remove]")) button.addEventListener("click", () => removeItem(button.dataset.remove, button));
  for (const input of document.querySelectorAll("[data-start],[data-end]")) input.addEventListener("input", () => updateRange(input));
  for (const button of document.querySelectorAll("[data-mark-start],[data-mark-end]")) button.addEventListener("click", () => markTrim(button));
  for (const video of document.querySelectorAll("[data-video]")) attachVideo(video.dataset.video, video);

  const confirmed = state.items.filter((item) => item.trim_confirmed).length;
  $("#submit").disabled = !state.items.length || confirmed !== state.items.length || ["submitted", "processing", "ready_for_review", "completed"].includes(state.session?.status);
  $("#submit-note").textContent = state.items.length ? `${confirmed} of ${state.items.length} rooms confirmed.` : "Upload at least one video, then confirm every room.";
  if (["submitted", "processing", "ready_for_review", "completed"].includes(state.session?.status)) {
    $("#success").hidden = false;
    $("#submit").hidden = true;
  }
}

function updateRange(input) {
  const id = input.dataset.start || input.dataset.end;
  const item = state.items.find((entry) => entry.id === id);
  if (!item) return;
  const startInput = document.querySelector(`[data-start="${id}"]`);
  const endInput = document.querySelector(`[data-end="${id}"]`);
  let start = Number(startInput.value);
  let end = Number(endInput.value);
  if (input.dataset.start !== undefined) start = Number(input.value);
  if (input.dataset.end !== undefined) end = Number(input.value);
  start = clamp(start, 0, Math.max(0, item.duration - 0.2));
  end = clamp(end, start + 0.1, item.duration);
  item.start = start; item.end = end;
  startInput.value = start.toFixed(1); endInput.value = end.toFixed(1);
  document.querySelector(`[data-range-label="${id}"]`).textContent = `${seconds(start)} – ${seconds(end)}`;
  const video = document.querySelector(`[data-video="${id}"]`);
  if (video && input.dataset.start !== undefined) video.currentTime = start;
}

function markTrim(button) {
  const id = button.dataset.markStart || button.dataset.markEnd;
  const video = document.querySelector(`[data-video="${id}"]`);
  if (!video || !Number.isFinite(video.currentTime)) return;
  const input = document.querySelector(button.dataset.markStart !== undefined ? `[data-start="${id}"]` : `[data-end="${id}"]`);
  input.value = video.currentTime.toFixed(1);
  updateRange(input);
}

async function attachVideo(id, video) {
  if (state.localUrls.has(id)) { video.src = state.localUrls.get(id); return; }
  try {
    video.src = await window.MDAIObjectStorage.getSignedUrl(client, "evidence", id, access);
  } catch (error) {
    video.replaceWith(Object.assign(document.createElement("p"), { textContent: error.message }));
  }
}

async function saveItem(id, button) {
  const item = state.items.find((entry) => entry.id === id);
  const room = document.querySelector(`[data-room="${id}"]`).value.trim();
  if (!room) return document.querySelector(`[data-room="${id}"]`).focus();
  button.disabled = true; button.textContent = "Saving…";
  try {
    await api("save_item", { item_id: id, room_name: room, trim_start_seconds: item.start, trim_end_seconds: item.end });
    item.room_name = room; item.trim_confirmed = true; item.state = "approved"; state.openItemId = null; render();
  } catch (error) { alert(error.message); button.disabled = false; button.textContent = "Confirm room & trim"; }
}

async function removeItem(id, button) {
  const item = state.items.find((entry) => entry.id === id);
  if (!item || !confirm(`Remove ${item.room_name || item.original_filename} from this capture session?`)) return;
  button.disabled = true; button.textContent = "Removing…";
  try {
    await window.MDAIObjectStorage.removeCaptureEvidence(client, id, access);
    if (state.localUrls.has(id)) URL.revokeObjectURL(state.localUrls.get(id));
    state.localUrls.delete(id);
    state.items = state.items.filter((entry) => entry.id !== id);
    if (state.openItemId === id) state.openItemId = null;
    render();
  } catch (error) {
    alert(error.message); button.disabled = false; button.textContent = "Remove video";
  }
}

async function uploadFiles(files) {
  if (!files.length) return;
  $("#files").disabled = true;
  await api("uploading");
  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      if (file.type && file.type !== "video/mp4" && !file.name.toLowerCase().endsWith(".mp4")) throw new Error(`${file.name} is not an MP4 video.`);
      const media = await readVideo(file);
      $("#upload-progress").hidden = false;
      const result = await window.MDAIObjectStorage.upload({
        client,
        entityType: "evidence",
        organizationId: state.scope.organization_id,
        propertyId: state.scope.property_id,
        spaceId: state.scope.space_id,
        file,
        captureAccess: access,
        metadata: {
          media_type: "360 capture",
          captured_at: new Date(file.lastModified || Date.now()).toISOString(),
          source_metadata: { duration_seconds: media.duration, width: media.width, height: media.height, projection: media.projection, original_immutable: true },
        },
        onProgress(progress) {
          $("#progress-title").textContent = `Room ${index + 1} of ${files.length} · ${progress.stage === "finalizing" ? "Saving" : "Uploading"}`;
          $("#progress-value").textContent = `${progress.percent}%`;
          $("#progress-fill").style.width = `${progress.percent}%`;
          $("#progress-detail").textContent = `${file.name} · ${progress.label}`;
        },
      });
      state.localUrls.set(result.record.id, media.url);
      const guard = Math.min(3, Math.max(0.5, media.duration * 0.1));
      state.items.push(normalizedItem({ ...result.record, source_duration_seconds: media.duration, source_width: media.width, source_height: media.height, projection: media.projection, suggested_trim_start_seconds: guard, suggested_trim_end_seconds: Math.max(guard + 0.1, media.duration - guard), trim_confirmed: false }));
      state.openItemId = result.record.id;
      render();
    }
    $("#upload-progress").hidden = true;
  } finally { $("#files").disabled = false; }
}

$("#files").addEventListener("change", async () => {
  try { await uploadFiles(Array.from($("#files").files || [])); $("#files").value = ""; }
  catch (error) { $("#progress-title").textContent = "Upload stopped"; $("#progress-detail").textContent = error.message; alert(error.message); }
});

$("#submit").addEventListener("click", async () => {
  $("#submit").disabled = true; $("#submit").textContent = "Submitting…";
  try { await api("submit"); state.session.status = "submitted"; render(); }
  catch (error) { alert(error.message); $("#submit").disabled = false; $("#submit").textContent = "Submit all rooms"; }
});

(async () => {
  try {
    if (!access.session_id || !access.token) throw new Error("Open the complete private link sent by the project manager.");
    const payload = await api("get");
    state.session = payload.session; state.property = payload.property; state.scope = payload.upload_scope; state.items = payload.items || [];
    render();
  } catch (error) { $("#loading").hidden = true; $("#error").hidden = false; $("#error-message").textContent = error.message; }
})();

window.addEventListener("beforeunload", () => { for (const url of state.localUrls.values()) URL.revokeObjectURL(url); });
