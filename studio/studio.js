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

function collapseInsta360Sources(items) {
  const grouped = new Map();
  const ordinary = [];
  items.forEach((item) => {
    const key = insta360CaptureKey(item);
    if (!key) { ordinary.push(item); return; }
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  });
  grouped.forEach((sources, key) => {
    const clip = key.split("_").pop();
    const paired = sources.length >= 2;
    ordinary.push({
      ...sources[0],
      src: "",
      name: `360 capture ${clip || ""}`.trim(),
      type: "360 capture",
      mimeType: "application/x-insta360-capture",
      sourceIds: sources.map((source) => source.id),
      sourceMetadata: { ...sources[0].sourceMetadata, insta360_capture_key: key },
      status: paired ? "Original pair verified · VR processing prepared" : "Waiting for the matching camera original",
    });
  });
  return ordinary;
}

function waitForMediaEvent(target, eventName, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out while preparing video ${eventName}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      target.removeEventListener(eventName, onSuccess);
      target.removeEventListener("error", onError);
    };
    const onSuccess = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("The video could not be decoded for AI keyframes"));
    };
    target.addEventListener(eventName, onSuccess, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

async function extractVideoFrames(item, frameLimit = 4) {
  if (!item?.src || !isVideo(item) || frameLimit < 1) return [];
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.preload = "auto";
  video.playsInline = true;
  video.src = item.src;
  try {
    if (video.readyState < 1) await waitForMediaEvent(video, "loadedmetadata");
    const duration = Number(video.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("The video duration is unavailable");
    }
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
        Math.max(0.05, duration * position),
        Math.max(0.05, duration - 0.05),
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
      });
    }
    return frames;
  } finally {
    video.removeAttribute("src");
    video.load();
  }
}

async function prepareVideoFrames(room) {
  const frames = [];
  const warnings = [];
  for (const item of room.evidence.filter(isVideo)) {
    if (frames.length >= 8) break;
    try {
      frames.push(...(await extractVideoFrames(item, Math.min(4, 8 - frames.length))));
    } catch (error) {
      console.warn("Video keyframe extraction failed", item.name, error);
      warnings.push(item.name || "Video");
    }
  }
  return { frames, warnings };
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
  room.status = "needs";
  room.evidence.forEach((item) => {
    item.status = "Private cloud original · AI suggestion available";
  });
}

function evidenceThumbnail(item, className = "room-thumb") {
  if (!item?.src) return `<span class="${className}"></span>`;
  if (isImage(item)) {
    return `<img class="${className}" src="${escapeText(item.src)}" alt="">`;
  }
  if (isVideo(item)) {
    return `<span class="${className} video-thumb" aria-hidden="true">▶</span>`;
  }
  return `<span class="${className} document-thumb" aria-hidden="true">DOC</span>`;
}

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
      source_metadata: {
        source: "measured-decision-studio",
        last_modified: file.lastModified || null,
        subject: metadata.subject || null,
        context: metadata.context || null,
        intake_mode: metadata.intakeMode || null,
        evidence_category: metadata.evidenceCategory || null,
        vr: metadata.vr || null,
      },
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
    subject: metadata.subject || "",
    context: metadata.context || "",
    sourceMetadata: {
      source: "measured-decision-studio",
      last_modified: file.lastModified || null,
      subject: metadata.subject || null,
      context: metadata.context || null,
      intake_mode: metadata.intakeMode || null,
      evidence_category: metadata.evidenceCategory || null,
      vr: metadata.vr || null,
    },
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

  if (isVideo(item)) {
    elements.video.src = item.src;
    elements.video.hidden = false;
  } else if (isImage(item)) {
    elements.image.src = item.src;
    elements.image.alt = `${roomName} evidence capture`;
    elements.image.hidden = false;
  } else {
    elements.documentName.textContent = item.name || "Document evidence";
    elements.documentOpen.href = item.src;
    elements.documentOpen.hidden = false;
    elements.document.hidden = false;
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
  /* A list of projects, nothing else. Every row is the same one action. */
  elements.propertyDirectory.innerHTML = properties
    .map(
      (property) =>
        `<button class="property-directory-card" type="button" data-property-id="${escapeText(property.id)}">
        <h2>Open ${escapeText(property.name)}</h2>
        <small>→</small>
      </button>`,
    )
    .join("");
  $("#empty-property-state").hidden = properties.length > 0;
  elements.propertyDirectory.hidden = properties.length === 0;
  elements.propertyDirectory
    .querySelectorAll("[data-property-id]")
    .forEach((button) =>
      button.addEventListener("click", () => openProperty(button.dataset.propertyId)),
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

  const evidenceWithUrls = collapseInsta360Sources(await Promise.all(
    (evidenceRows || []).map(async (item) => ({
      id: item.id,
      src: await signedEvidenceUrl(item.storage_path, item),
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
    evidence: evidenceWithUrls.filter((item) => {
      const source = (evidenceRows || []).find((row) => row.id === item.id);
      return source?.space_id === space.id;
    }),
    visible: [],
    unknown: [
      "Uploaded material has not been analyzed",
      "No factual observations have been confirmed",
    ],
  }));
  activeRoomId = rooms[0]?.id || null;

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
  const evidenceId = params.get("evidence");
  if (!evidenceId) return;
  const room = rooms.find((candidate) =>
    (candidate.evidence || []).some(
      (item) => item.id === evidenceId || (item.sourceIds || []).includes(evidenceId),
    ),
  );
  const item = room?.evidence.find(
    (candidate) => candidate.id === evidenceId || (candidate.sourceIds || []).includes(evidenceId),
  );
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
$("#property-account-security")?.addEventListener("click", () =>
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
let focusProcessingComplete = false;
let focusProcessingRows = [];
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
  return time ? new Date(time).toISOString().slice(0, 10) : "";
}

function focusRelativeDay(time) {
  if (!time) return "date unavailable";
  const days = Math.round((Date.now() - time) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(time).toLocaleDateString("en-US", { month: "short", day: "numeric" });
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
  const awaitingReview = spaces.filter((room) => room.analysis && room.status !== "confirmed");
  const confirmedRooms = spaces.filter((room) => room.status === "confirmed");
  const unanalyzedRooms = analyzableRooms.filter((room) => !room.analysis);
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
  const isVideo = Boolean(file?.type?.startsWith("video/"));
  const isImage = Boolean(file?.type?.startsWith("image/"));
  if (!isVideo && !isImage) return Promise.resolve({});
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const element = document.createElement(isVideo ? "video" : "img");
    const finish = (measured = {}) => {
      URL.revokeObjectURL(url);
      resolve(measured);
    };
    const timeout = window.setTimeout(() => finish(), 15000);
    const done = (measured) => {
      window.clearTimeout(timeout);
      finish(measured);
    };
    if (isVideo) {
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

async function ensureFocusDestination(file) {
  /* An export belongs with the capture it came from, not in a general inbox:
     same room, so the sphere sits beside the protected originals. */
  const captureKey = exportCaptureKey(file?.name);
  if (captureKey) {
    const pairedRoom = rooms.find((room) =>
      (room.evidence || []).some(
        (item) =>
          item.sourceMetadata?.insta360_capture_key === captureKey ||
          insta360CaptureKey(item) === captureKey,
      ),
    );
    if (pairedRoom) return pairedRoom;
  }
  const normalizedName = String(file?.name || "").toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const namedRoom = rooms.find((room) => {
    if (!room.name || /evidence inbox|unsorted evidence/i.test(room.name)) return false;
    const tokens = room.name.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2);
    return tokens.length > 0 && tokens.every((token) => normalizedName.includes(token));
  });
  if (namedRoom) return namedRoom;
  const existingInbox = rooms.find((room) => /evidence inbox|unsorted evidence/i.test(room.name));
  if (existingInbox) return existingInbox;
  return createRoomRecord({
    name: "Evidence inbox",
    building: "Automatic intake",
    level: "AI organized",
  });
}

function showFocusStage(name) {
  focusStage = FOCUS_STAGE_ORDER[name] ? name : "upload";
  closeFocusSheet(false);
  $("#focus-upload-stage").hidden = focusStage !== "upload";
  $("#focus-processing-stage").hidden = focusStage !== "process";
  $("#focus-results-stage").hidden = focusStage !== "results";
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
    item.setAttribute("role", canOpen ? "button" : "presentation");
    item.tabIndex = canOpen ? 0 : -1;
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
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
      copy: `${names}${stats.unanalyzedRooms.length > 2 ? " and others" : ""} hold visual evidence that has not been interpreted yet.`,
      label: "Start AI review",
      owner: "Automatic · you stay in control of the result",
      run: () => processFocusEvidence(),
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
      state: stats.spatial.length ? "done" : stats.paired360 || stats.waiting360 ? "active" : "waiting",
      detail: stats.spatial.length
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
  const batchFiles = stats.latestBatch.reduce((total, item) => total + focusSourceCount(item), 0);
  const batchSpaces = new Set();
  stats.latestBatch.forEach((item) => {
    const room = rooms.find((candidate) => candidate.evidence.includes(item));
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

  const changes = focusChangeItems(stats);
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

function openProjectPlans() {
  if (!cloud.propertyId) {
    notify("Open a project before its plans can be reviewed");
    return;
  }
  window.location.href = `plans/?property=${encodeURIComponent(cloud.propertyId)}`;
}

function openFieldOperations() {
  if (!cloud.propertyId) {
    notify("Open a project before a field task can be sent");
    return;
  }
  window.location.href = `operations/?property=${encodeURIComponent(cloud.propertyId)}`;
}

function openFirstSpatial() {
  const stats = focusEvidenceStats();
  const item = stats.spatial[0];
  if (!item) {
    notify("This project has no playable 360 export yet. Upload an equirectangular MP4 to open the space.", 6000);
    showFocusStage("upload");
    return;
  }
  const room = rooms.find((candidate) => candidate.evidence.includes(item));
  openEvidenceViewer(item, room);
}

/* ------------------------------------------------------------- Evidence viewer */

function focusEvidenceUrl(item) {
  if (!cloud.propertyId || !item?.id) return "";
  return `${window.location.origin}${window.location.pathname}?property=${encodeURIComponent(cloud.propertyId)}&evidence=${encodeURIComponent(item.id)}`;
}

async function copyFocusLink(item) {
  const url = focusEvidenceUrl(item);
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    notify("Link copied. Open it in Vision Pro Safari to inspect the space in the headset.", 6000);
  } catch {
    window.prompt("Copy this link and open it in Vision Pro Safari:", url);
  }
}

function openEvidenceViewer(item, room) {
  if (!item) return;
  if (!window.MDAIPano360) {
    if (item.src) window.open(item.src, "_blank", "noopener");
    return;
  }
  const spatial = focusIsSpatial(item);
  const roomName = room?.name || "Project evidence";
  const actions = [];

  if (focusIsCameraOriginal(item)) {
    const paired = (item.sourceIds?.length || 0) >= 2;
    window.MDAIPano360.open({
      src: "",
      title: item.name || "360 camera original",
      subtitle: paired
        ? "Both camera originals are preserved. A browser cannot play the protected INSV format — export a full 360 MP4 in Insta360 Studio and upload it to make this space walkable."
        : "One camera original is missing. Upload the matching INSV file, then export a full 360 MP4 to make this space walkable.",
      actions: [
        { label: "Upload the 360 export", primary: true, onSelect: () => { window.MDAIPano360.close(); showFocusStage("upload"); } },
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
  if (item.src) {
    actions.push({ label: "Open the original file", onSelect: () => window.open(item.src, "_blank", "noopener") });
  }

  window.MDAIPano360.open({
    src: item.src,
    mediaType: item.mimeType || "",
    spatial,
    title: item.subject || item.name || "Evidence",
    subtitle: `${roomName} · ${focusEvidenceLabel(item)} · ${item.date || "date unavailable"}`,
    actions,
  });
}

/* --------------------------------------------------------------- Space detail */

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
          return `<button class="sheet-evidence-item" type="button" data-evidence="${index}">${preview}<span><strong>${escapeText(item.subject || item.name || "Evidence")}</strong><small>${escapeText(label)} · ${escapeText(item.date || "date unavailable")}</small></span></button>`;
        })
        .join("")
    : `<p class="sheet-empty">No evidence is attached to this space yet.</p>`;
  evidenceList.querySelectorAll("[data-evidence]").forEach((button) => {
    button.addEventListener("click", () => openEvidenceViewer(room.evidence[Number(button.dataset.evidence)], room));
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
    const analyzable = room.evidence.some((item) => isImage(item) || isVideo(item));
    findings.innerHTML = `<p class="sheet-empty">${
      analyzable
        ? "No AI interpretation has been produced for this space yet."
        : "The AI can only interpret photos or video. This space holds documents or camera originals only."
    }</p>`;
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
    room.analysis
      ? { label: "Re-run AI", run: () => runFocusRoomAnalysis(room) }
      : { label: "Request AI", run: () => runFocusRoomAnalysis(room) },
    { label: "Request another capture", run: () => openFieldOperations() },
  ];
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

async function runFocusRoomAnalysis(room) {
  if (!room.evidence.some((item) => isImage(item) || isVideo(item))) {
    notify("The AI can only interpret photos or video. Add a visual capture first.", 5200);
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
  showFocusStage("process");
  focusProcessingRows = [{ roomId: room.id, name: room.name, state: "queued", detail: "Queued" }];
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
}

/* --------------------------------------------------------------- Results view */

function focusReadyCopy(stats) {
  if (!stats.rawFiles) return "Ready for evidence.";
  const captureCopy = stats.paired360
    ? ` · ${stats.paired360} paired 360 capture${stats.paired360 === 1 ? "" : "s"}`
    : "";
  return `${stats.rawFiles} file${stats.rawFiles === 1 ? "" : "s"} ready${captureCopy}.`;
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
  if (stats.spatial.length) {
    vrCard.innerHTML = `<header><h3>Spatial evidence</h3><span class="focus-vr-badge">VR-ready</span></header><p>${stats.spatial.length} capture${stats.spatial.length === 1 ? " is" : "s are"} playable as a full sphere. Open one here, or send the link to a headset for review in place.</p><div class="focus-vr-actions"><button class="focus-primary-action" type="button" data-vr-action="open">Open 360 view <span>&rarr;</span></button><button class="focus-secondary-action" type="button" data-vr-action="copy">Copy link for Vision Pro</button></div>`;
  } else if (stats.paired360 || stats.waiting360) {
    const pairText = `${stats.paired360} paired 360 capture${stats.paired360 === 1 ? "" : "s"}`;
    const waitingText = stats.waiting360
      ? ` ${stats.waiting360} capture${stats.waiting360 === 1 ? " is" : "s are"} waiting for a matching lens file.`
      : "";
    vrCard.innerHTML = `<header><h3>Spatial evidence</h3><span class="focus-vr-badge">Originals secured</span></header><p>${pairText} preserved and linked to the project.${waitingText} A browser cannot play the protected camera format — export a full 360 MP4 in Insta360 Studio and upload it to make the space walkable.</p><div class="focus-vr-actions"><button class="focus-secondary-action" type="button" data-vr-action="upload">Upload the 360 export</button></div>`;
  } else {
    vrCard.innerHTML = `<header><h3>Spatial evidence</h3><span class="focus-vr-badge">Not captured</span></header><p>This project has no 360 capture yet. A photo record still works, but only a full sphere lets a reviewer stand inside the space.</p><div class="focus-vr-actions"><button class="focus-secondary-action" type="button" data-vr-action="upload">Add a 360 capture</button></div>`;
  }
  vrCard.querySelectorAll("[data-vr-action]").forEach((button) => {
    const action = button.dataset.vrAction;
    button.addEventListener("click", () => {
      if (action === "open") openFirstSpatial();
      else if (action === "copy") copyFocusLink(stats.spatial[0]);
      else showFocusStage("upload");
    });
  });

  const list = $("#focus-result-list");
  list.innerHTML = stats.spaces.length
    ? stats.spaces
        .map((room) => {
          const rawCount = room.evidence.reduce((total, item) => total + focusSourceCount(item), 0);
          const spatialCount = room.evidence.filter(focusIsSpatial).length;
          const status = room.status === "confirmed"
            ? "Human verified"
            : room.analysis
              ? "Needs verification"
              : "Not interpreted";
          const tone = room.status === "confirmed" ? "ok" : room.analysis ? "review" : "wait";
          const summary = room.analysis?.summary || room.visible?.[0] ||
            "Evidence is preserved. No interpretation has been produced for this space yet.";
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
  $("#focus-upload-done-copy").textContent =
    `${stats.rawFiles} file${stats.rawFiles === 1 ? "" : "s"} uploaded successfully`;
  $("#focus-upload-more").hidden = !stats.rawFiles;
  $("#focus-process").disabled = !stats.rawFiles || focusUploadBusy;
  renderFocusToday();
  renderFocusResults();
  if ($("#focus-sheet") && !$("#focus-sheet").hidden) renderFocusSheet();
  showFocusStage(focusStage);
}

function openFocusStudio() {
  focusUploadBusy = false;
  focusProcessingRows = [];
  focusProcessingComplete = window.localStorage.getItem(`mdai-focus-processed:${cloud.propertyId}`) === "1";
  /* Opening a project always lands on the one action that moves it forward. */
  focusStage = "upload";
  renderFocusStudio();
}

/* --------------------------------------------------------------------- Upload */

async function uploadFocusEvidence(fileList) {
  const files = [...fileList].filter(focusFileAllowed);
  if (!files.length || focusUploadBusy) {
    if (fileList?.length) notify("Choose photos, video, PDF, INSV, INSP, or LRV files");
    return;
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
          vr: focusVrMetadata(file, measured),
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
    notify(`${files.length} evidence file${files.length === 1 ? "" : "s"} uploaded`);
  } catch (error) {
    console.error(error);
    $("#focus-upload-progress-title").textContent = "Upload needs attention";
    progressDetail.textContent = error.message || "The upload could not be completed.";
    notify(error.message || "Upload failed", 10000);
  } finally {
    focusUploadBusy = false;
    renderFocusStudio();
  }
}

/* ----------------------------------------------------------------- Processing */

async function analyzeFocusRoom(room, onStatus) {
  const evidenceIds = room.evidence
    .filter((item) => item.storagePath && (isImage(item) || isVideo(item)))
    .map((item) => item.id);
  if (!evidenceIds.length) return { skipped: true };
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
    status: "Preparing evidence",
    createdAt: new Date().toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
  };
  jobs.unshift(localJob);
  saveJobs();
  try {
    onStatus(`Preparing ${room.name}`);
    const { frames, warnings } = await prepareVideoFrames(room);
    localJob.status = "Analyzing evidence";
    saveJobs();
    onStatus(`AI is reviewing ${room.name}`);
    const { data, error } = await cloud.client.functions.invoke(config.aiFunctionName, {
      body: { job_id: jobRow.id, video_frames: frames },
    });
    if (error) throw await functionInvocationError(error);
    if (!data?.analysis) throw new Error(data?.error || "AI returned no result");
    localJob.status = "Completed";
    applyAnalysisResult(room, data.analysis, data.suggestion_id);
    saveJobs();
    return { warnings, analyzed: true };
  } catch (error) {
    localJob.status = "Failed";
    localJob.errorCode = error.message || "analysis_failed";
    saveJobs();
    throw error;
  }
}

function renderFocusProcessing(percent, message) {
  const progress = $("#focus-processing-progress");
  progress.value = Math.max(0, Math.min(100, percent));
  $("#focus-processing-percent").textContent = `${Math.round(progress.value)}%`;
  $("#focus-processing-status").textContent = message;
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
  $("#focus-process").disabled = false;
  renderFocusToday();
  renderFocusResults();
  document.querySelector('[data-focus-step="upload"]')?.classList.add("complete");
}

async function processFocusEvidence() {
  const stats = focusEvidenceStats();
  if (!stats.rawFiles) {
    notify("Add evidence before starting the AI review");
    showFocusStage("upload");
    return;
  }
  const candidates = stats.analyzableRooms.filter((room) => !room.analysis);
  $("#focus-process").disabled = true;
  closeFocusSheet(false);
  showFocusStage("process");
  $("#focus-view-results").disabled = true;
  $("#focus-processing-title").textContent = "Processing evidence\u2026";
  $("#focus-processing-copy").textContent = "Organizing files and building the project record.";
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

$("#focus-evidence-files").addEventListener("change", (event) => uploadFocusEvidence(event.target.files));
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
$("#focus-process").addEventListener("click", processFocusEvidence);
$("#focus-view-results").addEventListener("click", () => {
  renderFocusResults();
  showFocusStage("results");
});
$("#focus-add-more").addEventListener("click", () => showFocusStage("upload"));
$("#focus-upload-more").addEventListener("click", () => $("#focus-evidence-files").click());
document.querySelectorAll("[data-focus-step]").forEach((item) => {
  const open = () => {
    if (!item.classList.contains("reachable")) return;
    showFocusStage(item.dataset.focusStep);
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
  renderFocusSheet();
  renderFocusToday();
  renderFocusResults();
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
  if (cloud.schemaReady && cloud.propertyId) {
    if (evidence.storageProvider === "aws-s3") {
      if (!window.MDAIObjectStorage) throw new Error("The secure S3 service is unavailable. Reload and retry.");
      await window.MDAIObjectStorage.deleteEvidence(cloud.client, evidence.id);
    } else {
      const { data: deletedRows, error: databaseError } = await cloud.client
        .from("evidence_items")
        .delete()
        .eq("id", evidence.id)
        .eq("property_id", cloud.propertyId)
        .select("id");
      if (databaseError) throw databaseError;
      if (!deletedRows?.length) throw new Error("Deletion is not authorized or the evidence no longer exists");
    }

    if (evidence.storagePath && evidence.storageProvider !== "aws-s3") {
      const { error: storageError } = await cloud.client.storage
        .from(config.storageBucket)
        .remove([evidence.storagePath]);
      if (storageError) {
        console.error("Evidence record deleted but storage cleanup failed", storageError);
        storageCleanupFailed = true;
      }
    }
  } else if (evidence.fileRef) {
    await deleteStoredEvidenceFile(evidence.fileRef);
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
    elements.deleteEvidenceDialog.close();
    deletingEvidenceId = null;
    notify(
      result.storageCleanupFailed
        ? `${filename} removed from the database; storage cleanup requires attention`
        : `${filename} deleted permanently`,
    );
  } catch (error) {
    console.error(error);
    notify(`Evidence was not deleted: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = "Delete permanently";
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

    const { frames, warnings } = await prepareVideoFrames(room);
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
        ? `AI suggestion ready; ${warnings.length} video could not be sampled`
        : `AI suggestion ready from ${data.analyzed_images || 0} images and ${data.analyzed_video_frames || 0} video frames`,
      5000,
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
