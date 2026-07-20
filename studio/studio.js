let propertyRecord = {
  id: "private-pilot-property",
  name: "Private Pilot Property",
  city: "Los Angeles",
  state: "CA",
  description: "Los Angeles, California · Spatial evidence record",
  access: "private",
};

const config = window.MDAI_CONFIG || {};
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
let objectUrls = [];
let fileDatabase;

const $ = (selector) => document.querySelector(selector);
const elements = {
  gate: $("#prototype-gate"),
  shell: $("#app-shell"),
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
  sourceStatus: $("#source-status"),
  visible: $("#visible-observations"),
  unknown: $("#unknown-observations"),
  note: $("#review-note"),
  badge: $("#review-badge"),
  toast: $("#toast"),
  autosave: $("#autosave-status"),
  authForm: $("#auth-form"),
  authMessage: $("#auth-message"),
  roomDialog: $("#room-dialog"),
  uploadDialog: $("#upload-dialog"),
  fileUpload: $("#file-upload"),
  intakeUpload: $("#file-upload-intake"),
  uploadRoom: $("#upload-room"),
  lightbox: $("#lightbox"),
};

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

function safeStorageName(filename) {
  const extension = filename.includes(".") ? `.${filename.split(".").pop()}` : "";
  const base = filename
    .replace(extension, "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${base || "evidence"}${extension.toLowerCase()}`;
}

async function uploadEvidenceToCloud(file, room, mediaType) {
  const uniqueId = crypto.randomUUID();
  const storagePath = `${cloud.organizationId}/${cloud.propertyId}/${uniqueId}-${safeStorageName(file.name)}`;
  const { error: uploadError } = await cloud.client.storage
    .from(config.storageBucket)
    .upload(storagePath, file, {
      cacheControl: "3600",
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });
  if (uploadError) throw uploadError;

  const now = new Date();
  const { data, error: insertError } = await cloud.client
    .from("evidence_items")
    .insert({
      organization_id: cloud.organizationId,
      property_id: cloud.propertyId,
      space_id: room.id,
      storage_path: storagePath,
      original_filename: file.name,
      media_type: mediaType,
      mime_type: file.type || "application/octet-stream",
      byte_size: file.size,
      captured_at: now.toISOString(),
      source_metadata: {
        source: "measured-decision-studio",
        last_modified: file.lastModified || null,
      },
      created_by: cloud.session.user.id,
    })
    .select("id")
    .single();
  if (insertError) throw insertError;

  return {
    id: data.id,
    src: await signedEvidenceUrl(storagePath),
    storagePath,
    name: file.name,
    type: mediaType,
    mimeType: file.type || "application/octet-stream",
    byteSize: file.size,
    date: formatEvidenceDate(now.toISOString()),
    status: "Private cloud original · Awaiting analysis",
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
  if (!room) return;
  const evidence = room.evidence[0];
  elements.title.textContent = room.name;
  elements.level.textContent = `${room.building} · ${room.level}`;
  elements.count.textContent = `${room.evidence.length} evidence item${room.evidence.length === 1 ? "" : "s"}`;
  showEvidence(evidence, room.name);
  elements.strip.innerHTML = room.evidence
    .filter((item) => item.src)
    .map(
      (item, index) =>
        `<button class="evidence-thumb" data-evidence="${index}" type="button">${evidenceThumbnail(item, "strip-thumb")}</button>`,
    )
    .join("");
  elements.strip
    .querySelectorAll("[data-evidence]")
    .forEach((button) =>
      button.addEventListener("click", () =>
        showEvidence(room.evidence[Number(button.dataset.evidence)]),
      ),
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
  elements.note.value = room.note || "";
  const confirmed = room.status === "confirmed";
  elements.badge.textContent = confirmed
    ? "Human confirmed"
    : "Needs verification";
  elements.badge.className = `review-badge ${confirmed ? "confirmed" : "needs"}`;
}

function showEvidence(item, roomName = currentRoom()?.name || "Room") {
  elements.video.pause();
  elements.image.hidden = true;
  elements.video.hidden = true;
  elements.document.hidden = true;
  elements.image.removeAttribute("src");
  elements.video.removeAttribute("src");
  elements.documentOpen.removeAttribute("href");

  if (!item?.src) {
    elements.image.alt = "No evidence uploaded";
    elements.type.textContent = "No evidence selected";
    elements.sourceName.textContent = "—";
    elements.sourceDate.textContent = "—";
    elements.sourceStatus.textContent = "Awaiting upload";
    $("#expand-image").hidden = true;
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
    elements.document.hidden = false;
  }

  $("#expand-image").hidden = !isImage(item);
  elements.type.textContent = item.type || "Evidence";
  elements.sourceName.textContent = item.name || "—";
  elements.sourceDate.textContent = item.date || "—";
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

function renderUploadRooms() {
  elements.uploadRoom.innerHTML = rooms
    .map(
      (room) =>
        `<option value="${room.id}" ${room.id === activeRoomId ? "selected" : ""}>${escapeText(room.name)} · ${escapeText(room.level)}</option>`,
    )
    .join("");
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
            `<article class="inventory-row"><span class="file-icon">${isVideo(item) ? "▶" : item.type?.includes("Plan") ? "⌑" : isImage(item) ? "◫" : "DOC"}</span><div><strong>${escapeText(item.name)}</strong><small>${escapeText(item.type)} · ${escapeText(item.room)}</small></div><span>${escapeText(item.date || "Date unavailable")}</span><span class="inventory-status ${item.roomStatus}">${item.roomStatus === "confirmed" ? "Human confirmed" : "Review required"}</span></article>`,
        )
        .join("")
    : `<div class="empty-state"><strong>No evidence yet</strong><p>Add source material to begin the governed record.</p></div>`;
}

function renderJobs() {
  const list = $("#job-list");
  if (!list) return;
  $("#queue-count").textContent =
    `${jobs.length} job${jobs.length === 1 ? "" : "s"}`;
  $("#queue-nav-count").textContent = jobs.length;
  list.innerHTML = jobs.length
    ? jobs
        .map(
          (job) =>
            `<article class="job-card"><div class="job-state"><i></i><span>${escapeText(job.status)}</span></div><div><strong>${escapeText(job.roomName)}</strong><p>${job.evidenceCount} evidence item${job.evidenceCount === 1 ? "" : "s"} · ${escapeText(job.profile)}</p></div><time>${escapeText(job.createdAt)}</time><button class="mini-button" data-cancel-job="${job.id}" type="button">Remove</button></article>`,
        )
        .join("")
    : `<div class="empty-state"><strong>No processing jobs</strong><p>Open a room and request AI interpretation. The job will remain explicitly blocked until the secure worker is connected.</p></div>`;
  list.querySelectorAll("[data-cancel-job]").forEach((button) =>
    button.addEventListener("click", () => {
      jobs = jobs.filter((job) => job.id !== button.dataset.cancelJob);
      saveJobs();
      notify("Processing request removed");
    }),
  );
}

function renderReviewQueue() {
  const queue = $("#review-queue");
  queue.innerHTML = rooms
    .map(
      (room) =>
        `<article class="review-queue-card"><div class="review-room-thumb">${evidenceThumbnail(room.evidence.find((item) => item.src), "review-thumb-media")}</div><div><p>${escapeText(room.building)} · ${escapeText(room.level)}</p><h2>${escapeText(room.name)}</h2><small>${room.evidence.length} source item${room.evidence.length === 1 ? "" : "s"} · ${jobs.some((job) => job.roomId === room.id) ? "AI request awaiting worker" : "No AI suggestion"}</small></div><span class="review-badge ${room.status === "confirmed" ? "confirmed" : "needs"}">${room.status === "confirmed" ? "Human confirmed" : "Needs verification"}</span><button class="secondary-button" data-review-room="${room.id}" type="button">Open record</button></article>`,
    )
    .join("");
  queue.querySelectorAll("[data-review-room]").forEach((button) =>
    button.addEventListener("click", () => {
      activeRoomId = button.dataset.reviewRoom;
      activateView("property");
      render();
    }),
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
      label: "visionOS client build",
      ready: false,
      note: "Native client not built",
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
    false,
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
function notify(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  setTimeout(() => elements.toast.classList.remove("show"), 2600);
}

function setAuthMessage(message, tone = "neutral") {
  elements.authMessage.textContent = message;
  elements.authMessage.dataset.tone = tone;
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

async function signedEvidenceUrl(storagePath) {
  if (!storagePath) return "";
  const { data, error } = await cloud.client.storage
    .from(config.storageBucket)
    .createSignedUrl(storagePath, 60 * 60);
  if (error) return "";
  return data?.signedUrl || "";
}

async function hydrateCloudRecord() {
  const { data: property, error: propertyError } = await cloud.client
    .from("properties")
    .select("id, name, address, access_classification")
    .eq("organization_id", cloud.organizationId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (propertyError) throw propertyError;
  if (!property) {
    elements.autosave.textContent = "Cloud connected · No property assigned";
    return;
  }

  cloud.propertyId = property.id;
  const address = property.address || {};
  propertyRecord = {
    id: property.id,
    name: property.name,
    city: address.city || "",
    state: address.state || "",
    description:
      [address.city, address.state].filter(Boolean).join(", ") ||
      "Private spatial evidence record",
    access: property.access_classification,
  };

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
          "id, space_id, storage_path, original_filename, media_type, mime_type, byte_size, captured_at, created_at",
        )
        .eq("property_id", property.id)
        .order("created_at", { ascending: true }),
    ]);
  if (spacesError) throw spacesError;
  if (evidenceError) throw evidenceError;

  const evidenceWithUrls = await Promise.all(
    (evidenceRows || []).map(async (item) => ({
      id: item.id,
      src: await signedEvidenceUrl(item.storage_path),
      storagePath: item.storage_path,
      name: item.original_filename,
      type: item.media_type,
      mimeType: item.mime_type,
      byteSize: item.byte_size,
      date: formatEvidenceDate(item.captured_at || item.created_at),
      status: "Private cloud original · Awaiting analysis",
    })),
  );

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
    .select("id, space_id, state, profile, created_at, evidence_ids")
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
        status:
          job.state === "queued"
            ? "Awaiting secure AI worker"
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
}

async function hydrateCloudContext() {
  if (!cloud.client || !cloud.session) return;
  const { data, error } = await cloud.client
    .from("organization_members")
    .select("organization_id, role")
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
    elements.autosave.textContent = "Signed in · No organization assigned";
    return;
  }
  cloud.schemaReady = true;
  cloud.organizationId = data.organization_id;
  cloud.role = data.role;
  try {
    await hydrateCloudRecord();
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
  elements.gate.hidden = true;
  elements.shell.hidden = false;
  $(".avatar").textContent = sessionInitials(session);
  await hydrateEvidenceFiles();
  await hydrateCloudContext();
  render();
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
  if (data.session) await enterWorkspace(data.session);
  cloud.client.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT") {
      cloud.session = null;
      elements.shell.hidden = true;
      elements.gate.hidden = false;
      setAuthMessage("Signed out. Authorized accounts only.");
    } else if (event === "SIGNED_IN" && session && !cloud.session) {
      enterWorkspace(session);
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
}

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
$("#sign-out").addEventListener("click", async () => {
  if (cloud.client) await cloud.client.auth.signOut();
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
$("#add-room").addEventListener("click", () => elements.roomDialog.showModal());
$("#save-room").addEventListener("click", async (event) => {
  event.preventDefault();
  const name = $("#new-room-name").value.trim();
  if (!name) return;
  const building = $("#new-room-building").value;
  const level = $("#new-room-level").value;
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
    if (error) {
      notify(`Room was not added: ${error.message}`);
      return;
    }
    id = data.id;
  }
  rooms.push({
    id,
    name,
    building,
    level,
    status: "needs",
    note: "",
    evidence: [],
    visible: [],
    unknown: ["Evidence has not been uploaded or reviewed"],
  });
  activeRoomId = id;
  saveRooms(cloud.schemaReady ? "Room added to cloud record" : "Room added locally");
  render();
  $("#room-form").reset();
  elements.roomDialog.close();
  notify(`${name} added to the ${cloud.schemaReady ? "private cloud" : "local"} record`);
});

function beginUploadFiles(files) {
  pendingFiles = [...files];
  if (!pendingFiles.length) return;
  $("#upload-summary").innerHTML =
    `<strong>${pendingFiles.length} file${pendingFiles.length === 1 ? "" : "s"} selected</strong><br>${pendingFiles.map((file) => escapeText(file.name)).join("<br>")}`;
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
  const button = $("#save-upload");
  button.disabled = true;
  button.textContent = cloud.schemaReady ? "Uploading securely…" : "Saving locally…";
  try {
    for (const file of pendingFiles) {
      if (cloud.schemaReady && cloud.propertyId) {
        room.evidence.push(await uploadEvidenceToCloud(file, room, type));
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
        });
      }
    }
  } catch (uploadError) {
    console.error(uploadError);
    notify(`Upload failed: ${uploadError.message || "Cloud storage error"}`);
    button.disabled = false;
    button.textContent = "Save evidence";
    return;
  }
  room.status = "needs";
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

$("#confirm-record").addEventListener("click", async () => {
  const room = currentRoom();
  if (!(await persistRoomReview(room, "confirmed"))) return;
  room.status = "confirmed";
  room.note = elements.note.value;
  saveRooms(cloud.schemaReady ? "Human review saved to cloud" : "Human review saved");
  render();
  notify("Visible record confirmed by human review");
});
$("#flag-record").addEventListener("click", async () => {
  const room = currentRoom();
  if (!(await persistRoomReview(room, "needs_review"))) return;
  room.status = "needs";
  saveRooms("Verification flag saved");
  render();
  notify("Room remains in the verification queue");
});
$("#request-analysis").addEventListener("click", async () => {
  const room = currentRoom();
  if (!room.evidence.length) {
    notify("Add evidence before requesting interpretation");
    return;
  }
  const existing = jobs.find((job) => job.roomId === room.id);
  if (existing) {
    activateView("processing");
    notify("This room already has a processing request");
    return;
  }
  let jobId = `job-${Date.now()}`;
  if (cloud.schemaReady && cloud.propertyId) {
    const evidenceIds = room.evidence
      .filter((item) => item.storagePath)
      .map((item) => item.id);
    if (!evidenceIds.length) {
      notify("Re-upload this browser-only evidence to secure cloud storage first");
      return;
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
      notify(`Processing request failed: ${error.message}`);
      return;
    }
    jobId = data.id;
  }
  jobs.unshift({
    id: jobId,
    roomId: room.id,
    roomName: room.name,
    evidenceCount: room.evidence.length,
    profile: "Property evidence · conservative",
    status: cloud.schemaReady
      ? "Awaiting secure AI worker"
      : "Awaiting secure AI connector",
    createdAt: new Date().toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
  });
  saveJobs();
  activateView("processing");
  notify(
    cloud.schemaReady
      ? "Processing request recorded securely; no AI result has been fabricated"
      : "Request recorded locally; no data was sent",
  );
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

$("#export-vision-manifest").addEventListener("click", () => {
  const manifest = {
    schema: "com.measureddecision.spatial-record/0.1",
    packageType: "visionos-release-manifest",
    status: "draft-not-installable",
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
      "visionos_client_not_built",
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
