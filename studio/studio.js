const propertyRecord = {
  id: "private-pilot-property",
  name: "Private Pilot Property",
  city: "Los Angeles",
  state: "CA",
  description: "Los Angeles, California · Spatial evidence record",
  access: "private",
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
  roomDialog: $("#room-dialog"),
  uploadDialog: $("#upload-dialog"),
  fileUpload: $("#file-upload"),
  intakeUpload: $("#file-upload-intake"),
  uploadRoom: $("#upload-room"),
  lightbox: $("#lightbox"),
};

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

function saveRooms(message = "Saved locally") {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(rooms, (key, value) =>
      key === "src" && String(value).startsWith("blob:") ? "" : value,
    ),
  );
  elements.autosave.textContent = message;
  setTimeout(() => (elements.autosave.textContent = "Saved locally"), 1300);
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
      const thumb = room.evidence.find((item) => item.src)?.src || "";
      return `<button class="room-card ${room.id === activeRoomId ? "active" : ""}" data-room="${room.id}" type="button">
      ${thumb ? `<img class="room-thumb" src="${thumb}" alt="">` : `<span class="room-thumb"></span>`}
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
  if (evidence?.src) {
    elements.image.src = evidence.src;
    elements.image.alt = `${room.name} evidence capture`;
    elements.image.hidden = false;
  } else {
    elements.image.removeAttribute("src");
    elements.image.alt = "No evidence uploaded";
    elements.image.hidden = true;
  }
  elements.type.textContent = evidence?.type || "No evidence selected";
  elements.sourceName.textContent = evidence?.name || "—";
  elements.sourceDate.textContent = evidence?.date || "—";
  elements.sourceStatus.textContent = evidence?.status || "Awaiting upload";
  elements.strip.innerHTML = room.evidence
    .filter((item) => item.src)
    .map(
      (item, index) =>
        `<button class="evidence-thumb" data-evidence="${index}" type="button"><img src="${item.src}" alt="${escapeText(item.type)}"></button>`,
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

function showEvidence(item) {
  if (!item) return;
  elements.image.src = item.src;
  elements.type.textContent = item.type;
  elements.sourceName.textContent = item.name;
  elements.sourceDate.textContent = item.date;
  elements.sourceStatus.textContent = item.status;
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
            `<article class="inventory-row"><span class="file-icon">${item.type?.includes("video") ? "▶" : item.type?.includes("Plan") ? "⌑" : "◫"}</span><div><strong>${escapeText(item.name)}</strong><small>${escapeText(item.type)} · ${escapeText(item.room)}</small></div><span>${escapeText(item.date || "Date unavailable")}</span><span class="inventory-status ${item.roomStatus}">${item.roomStatus === "confirmed" ? "Human confirmed" : "Review required"}</span></article>`,
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
        `<article class="review-queue-card"><div class="review-room-thumb">${room.evidence.find((item) => item.src) ? `<img src="${room.evidence.find((item) => item.src).src}" alt="">` : "<span>—</span>"}</div><div><p>${escapeText(room.building)} · ${escapeText(room.level)}</p><h2>${escapeText(room.name)}</h2><small>${room.evidence.length} source item${room.evidence.length === 1 ? "" : "s"} · ${jobs.some((job) => job.roomId === room.id) ? "AI request awaiting connector" : "No AI suggestion"}</small></div><span class="review-badge ${room.status === "confirmed" ? "confirmed" : "needs"}">${room.status === "confirmed" ? "Human confirmed" : "Needs verification"}</span><button class="secondary-button" data-review-room="${room.id}" type="button">Open record</button></article>`,
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
      ready: false,
      note: "Supabase Storage not connected",
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

$("#enter-studio").addEventListener("click", async () => {
  elements.gate.hidden = true;
  elements.shell.hidden = false;
  await hydrateEvidenceFiles();
  render();
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
$("#save-room").addEventListener("click", (event) => {
  event.preventDefault();
  const name = $("#new-room-name").value.trim();
  if (!name) return;
  const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`;
  rooms.push({
    id,
    name,
    building: $("#new-room-building").value,
    level: $("#new-room-level").value,
    status: "needs",
    note: "",
    evidence: [],
    visible: [],
    unknown: ["Evidence has not been uploaded or reviewed"],
  });
  activeRoomId = id;
  saveRooms("Room added");
  render();
  $("#room-form").reset();
  elements.roomDialog.close();
  notify(`${name} added to the property record`);
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
  for (const file of pendingFiles) {
    const id = `${Date.now()}-${Math.random()}`;
    await storeEvidenceFile(id, file);
    const src =
      file.type.startsWith("image/") || file.type.startsWith("video/")
        ? URL.createObjectURL(file)
        : "";
    if (src) objectUrls.push(src);
    room.evidence.push({
      id,
      fileRef: id,
      src,
      name: file.name,
      type,
      date: new Date().toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
      }),
      status: "Stored in browser · Awaiting analysis",
    });
  }
  room.status = "needs";
  room.visible = [];
  room.unknown = [
    "Uploaded material has not been analyzed",
    "No factual observations have been confirmed",
  ];
  activeRoomId = room.id;
  saveRooms("Evidence added");
  render();
  pendingFiles = [];
  elements.fileUpload.value = "";
  elements.intakeUpload.value = "";
  elements.uploadDialog.close();
  notify("Evidence saved locally and assigned to the room");
});

elements.note.addEventListener("input", () => {
  currentRoom().note = elements.note.value;
  saveRooms("Saving…");
});
$("#confirm-record").addEventListener("click", () => {
  const room = currentRoom();
  room.status = "confirmed";
  room.note = elements.note.value;
  saveRooms("Human review saved");
  render();
  notify("Visible record confirmed by human review");
});
$("#flag-record").addEventListener("click", () => {
  currentRoom().status = "needs";
  saveRooms("Verification flag saved");
  render();
  notify("Room remains in the verification queue");
});
$("#request-analysis").addEventListener("click", () => {
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
  jobs.unshift({
    id: `job-${Date.now()}`,
    roomId: room.id,
    roomName: room.name,
    evidenceCount: room.evidence.length,
    profile: "Property evidence · conservative",
    status: "Awaiting secure AI connector",
    createdAt: new Date().toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
  });
  saveJobs();
  activateView("processing");
  notify("Request recorded; no data was sent");
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
    blockers: ["private_storage_not_connected", "visionos_client_not_built"],
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
