/* Measured Decision · Owner View.
 *
 * The record, published. This page renders exactly one thing: the latest
 * HUMAN-APPROVED vision release — the governed package the project team
 * built and a reviewer signed. AI drafts, unverified captures, open
 * reviews and working state never reach this page; the release is the
 * publication boundary, and the page holds no inputs at all.
 *
 * Everything on screen already passed the release gates: rooms confirmed,
 * field tasks verified, interpretations reviewed by a person. Media
 * arrives through short-lived signed URLs from the same vision-release
 * function the headset uses — one pipeline, no parallel infrastructure —
 * and 360 captures open in the Studio's own viewer.
 */
const config = window.MDAI_CONFIG || {};
const $ = (selector) => document.querySelector(selector);

const client = window.supabase?.createClient && config.supabaseUrl && config.supabasePublishableKey
  ? window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null;

const state = {
  session: null,
  properties: [],
  property: null,
  release: null,
  manifest: null,
  media: new Map(),
};
window.__ownerViewState = state;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

function showEmpty(title, copy) {
  $("#release-head").hidden = true;
  $("#rooms").innerHTML = "";
  $("#release-empty").hidden = false;
  $("#empty-title").textContent = title;
  $("#empty-copy").textContent = copy;
}

function isSpatial(item) {
  return /360|spatial/i.test(String(item.mediaType || "")) || /\.insv$/i.test(String(item.filename || ""));
}

function renderRelease() {
  const release = state.release;
  const manifest = state.manifest;
  $("#release-empty").hidden = true;
  $("#release-head").hidden = false;
  $("#release-title").textContent = manifest.property?.name || state.property?.name || "Project";
  $("#release-meta").textContent =
    `Release v${release.version} · approved ${String(release.approvedAt || "").slice(0, 10)} · ${manifest.spaces.length} room${manifest.spaces.length === 1 ? "" : "s"} released`;
  /* The governance line is the manifest's own promise, printed, not invented
     here: originals preserved, media links short-lived, a person approved. */
  const governance = manifest.governance || {};
  $("#release-governance").innerHTML = [
    governance.humanApprovalRequired ? "<span>Approved by a person</span>" : "",
    governance.originalsPreserved ? "<span>Originals never altered</span>" : "",
    governance.ephemeralMediaDelivery ? "<span>Media links expire</span>" : "",
  ].filter(Boolean).join("");

  $("#rooms").innerHTML = manifest.spaces.map((space) => {
    const interpretation = space.interpretation
      ? `<p class="interpretation">${escapeHtml(space.interpretation.body)}<span class="interpretation-chip">Confirmed by a reviewer</span></p>`
      : "";
    const tiles = (space.evidence || []).map((item) => {
      const url = state.media.get(item.id) || "";
      const spatial = isSpatial(item);
      const isVideo = /^video\//.test(String(item.mimeType || ""));
      const preview = spatial || !url
        ? ""
        : isVideo
          ? `<video src="${escapeHtml(url)}" controls preload="metadata"></video>`
          : `<img src="${escapeHtml(url)}" alt="${escapeHtml(item.filename || "evidence")}" loading="lazy">`;
      return `
        <div class="evidence-tile">
          ${preview}
          <div class="tile-meta">
            <strong title="${escapeHtml(item.filename || "")}">${escapeHtml(item.filename || "Evidence")}</strong>
            <button class="tile-open" type="button" data-open-evidence="${escapeHtml(item.id)}">${spatial ? "Enter 360" : "Open"}</button>
          </div>
        </div>`;
    }).join("");
    return `
      <article class="room" data-room="${escapeHtml(space.id)}">
        <div class="room-head">
          <h2>${escapeHtml(space.name)}</h2>
          <small>${escapeHtml([space.building, space.level].filter(Boolean).join(" · "))} · ${(space.evidence || []).length} evidence file${(space.evidence || []).length === 1 ? "" : "s"}</small>
        </div>
        ${interpretation}
        <div class="evidence-grid">${tiles}</div>
      </article>`;
  }).join("");

  $("#rooms").querySelectorAll("[data-open-evidence]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.openEvidence;
      const item = manifest.spaces.flatMap((space) => space.evidence || []).find((entry) => entry.id === id);
      const url = state.media.get(id);
      if (!item || !url) return;
      window.MDAIPano360?.open({
        src: url,
        mediaType: item.mediaType,
        title: item.filename || "Evidence",
        subtitle: `Release v${release.version} · human-approved`,
        spatial: isSpatial(item),
      });
    });
  });
}

async function openProperty(propertyId) {
  state.property = state.properties.find((property) => property.id === propertyId) || null;
  if (!state.property) return;
  window.history.replaceState({}, "", `${window.location.pathname}?property=${encodeURIComponent(propertyId)}`);
  state.release = null; state.manifest = null; state.media = new Map();

  const { data, error } = await client.functions.invoke("vision-release", {
    body: { action: "get", property_id: propertyId },
  });
  if (error || data?.error || !data?.release) {
    /* No approved release is a state, not a dead end. If a draft exists,
       say the release is being prepared and how many governance checks
       still stand; the checks themselves are the team's work, not the
       owner's. */
    const { data: statusData } = await client.functions.invoke("vision-release", {
      body: { action: "status", property_id: propertyId },
    });
    const drafts = (statusData?.releases || []).filter((release) => release.state === "draft");
    if (drafts.length) {
      const blockers = (drafts[0].manifest?.blockers || []).length;
      showEmpty(
        "A release is being prepared",
        blockers
          ? `Draft v${drafts[0].version} exists, with ${blockers} governance check${blockers === 1 ? "" : "s"} still open — rooms confirmed, field tasks verified, interpretations reviewed. It appears here the moment a reviewer approves it.`
          : `Draft v${drafts[0].version} is awaiting a reviewer's approval. It appears here the moment that happens.`,
      );
    } else {
      showEmpty(
        "No approved release yet",
        "This page shows only what a person has approved for release — nothing unverified ever appears here. Ask your project team to build and approve a vision release in Studio.",
      );
    }
    return;
  }
  state.release = data.release;
  state.manifest = data.manifest;
  state.media = new Map((data.media || []).map((entry) => [entry.evidenceId, entry.url]));
  renderRelease();
}

async function initialize() {
  if (!client) {
    $("#boot-screen").innerHTML = "<p>Studio configuration is unavailable.</p>";
    return;
  }
  const { data, error } = await client.auth.getSession();
  if (error || !data.session) {
    window.location.replace("../");
    return;
  }
  state.session = data.session;
  const { data: membership } = await client
    .from("organization_members")
    .select("organization_id, role")
    .eq("user_id", state.session.user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!membership) {
    $("#boot-screen").innerHTML = "<p>This account does not have a Studio organization.</p>";
    return;
  }
  const { data: properties } = await client
    .from("properties")
    .select("id, name, address, created_at")
    .eq("organization_id", membership.organization_id)
    .order("created_at", { ascending: true });
  state.properties = properties || [];
  if (!state.properties.length) {
    $("#boot-screen").innerHTML = '<p>Create a property in <a href="../">Studio</a> first.</p>';
    return;
  }
  const select = $("#property-select");
  select.innerHTML = state.properties.map((property) =>
    `<option value="${property.id}">${escapeHtml(property.name)}</option>`).join("");
  select.addEventListener("change", () => { void openProperty(select.value); });
  const requested = new URLSearchParams(window.location.search).get("property");
  const initial = state.properties.find((property) => property.id === requested) || state.properties[0];
  select.value = initial.id;
  $("#boot-screen").hidden = true;
  $("#app").hidden = false;
  await openProperty(initial.id);
}

void initialize();
