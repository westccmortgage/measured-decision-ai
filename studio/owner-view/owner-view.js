/* Measured Decision · Owner View.
 *
 * The record, published — behind the right boundary. Two kinds of people
 * open this page:
 *
 *   An EXTERNAL OWNER, invited by email to one project. They sign in with
 *   a magic link to their own address (no password, no bearer token in a
 *   URL), the invitation becomes a revocable, expirable grant, and they
 *   see exactly the projects they were given — never the organization's
 *   other work, never the Studio, never a draft. Every read goes through
 *   the vision-release worker, which serves only human-approved releases
 *   and published technical results.
 *
 *   An INTERNAL Studio member, previewing what their client will see.
 *   Their path in is explicit (the Studio's own "Open Owner View" link),
 *   they wear an "Internal preview" badge, and only they see the way back
 *   into Studio.
 *
 * Three channels, one shell: Owner Summary (the 30-second answer),
 * Visual Evidence (the approved release, rooms and 360s), Technical
 * Intelligence (approved baseline, accepted takeoff, expert-confirmed
 * lines). The page holds no inputs beyond the sign-in email.
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
  mode: null,               // "internal" | "external"
  properties: [],
  property: null,
  channel: "summary",
  release: null,
  manifest: null,
  media: new Map(),
  technical: null,
  statusline: null,
};
window.__ownerViewState = state;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

/* ── channels ─────────────────────────────────────────────────────── */

function showChannel(channel) {
  state.channel = channel;
  $("#tab-summary").classList.toggle("active", channel === "summary");
  $("#tab-visual").classList.toggle("active", channel === "visual");
  $("#tab-technical").classList.toggle("active", channel === "technical");
  $("#summary-panel").hidden = channel !== "summary";
  $("#visual-panel-ov").hidden = channel !== "visual";
  $("#technical-panel").hidden = channel !== "technical";
}

function isSpatial(item) {
  return /360|spatial/i.test(String(item.mediaType || "")) || /\.insv$/i.test(String(item.filename || ""));
}

function renderVisual() {
  const release = state.release;
  const manifest = state.manifest;
  if (!release || !manifest) {
    $("#release-head").hidden = true;
    $("#rooms").innerHTML = "";
    $("#release-empty").hidden = false;
    const prep = state.statusline;
    $("#empty-title").textContent = prep?.preparing ? "A release is being prepared" : "No approved release yet";
    $("#empty-copy").textContent = prep?.preparing
      ? `Draft v${prep.version} exists, with ${prep.open_checks} governance check${prep.open_checks === 1 ? "" : "s"} still open — rooms confirmed, field tasks verified, interpretations reviewed. It appears here the moment a reviewer approves it.`
      : "This page shows only what a person has approved for release — nothing unverified ever appears here.";
    return;
  }
  $("#release-empty").hidden = true;
  $("#release-head").hidden = false;
  $("#release-title").textContent = manifest.property?.name || state.property?.name || "Project";
  $("#release-meta").textContent =
    `Release v${release.version} · approved ${String(release.approvedAt || "").slice(0, 10)} · ${manifest.spaces.length} room${manifest.spaces.length === 1 ? "" : "s"} released`;
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

function renderTechnical() {
  const technical = state.technical;
  const hasBaseline = Boolean(technical?.baseline);
  $("#technical-empty").hidden = hasBaseline;
  $("#technical-content").hidden = !hasBaseline;
  if (!hasBaseline) return;
  $("#technical-title").textContent = state.property?.name || "Project";
  $("#technical-meta").textContent =
    `Plan baseline v${technical.baseline.version} · approved ${String(technical.baseline.approved_at || "").slice(0, 10)}`;
  $("#technical-chips").innerHTML = [
    "<span>Approved by a person</span>",
    technical.takeoff ? `<span>Takeoff accepted ${String(technical.takeoff.accepted_at || "").slice(0, 10)}</span>` : "",
  ].filter(Boolean).join("");
  $("#technical-summary").textContent = technical.baseline.summary || "";
  const confirmed = technical.confirmed_lines || [];
  $("#confirmed-box").hidden = confirmed.length === 0;
  $("#confirmed-lines tbody").innerHTML = confirmed.map((line) => `
    <tr><td>${escapeHtml(line.line)}</td><td>${escapeHtml(line.value || "")}</td>
    <td>${escapeHtml(line.reviewer_role || "")}</td><td>${escapeHtml(String(line.reviewed_at || "").slice(0, 10))}</td></tr>`).join("");
  const questions = technical.open_questions || [];
  $("#questions-box").hidden = questions.length === 0;
  $("#technical-questions").innerHTML = questions.map((gap) =>
    `<div class="question-row ${gap.severity === "critical" ? "critical" : ""}">${escapeHtml(gap.question)}</div>`).join("");
  /* The comparison the product exists for, shown to the person it is for.
     Numbers, not a caption; a dash is an honest empty, never a zero; and the
     provenance line is part of the content, not a footnote. */
  const comparison = technical.comparison || [];
  const comparisonBox = $("#comparison-box");
  if (comparisonBox) {
    comparisonBox.hidden = comparison.length === 0;
    const quantity = (value) => (value === null || value === undefined ? "—" : Number(value).toLocaleString("en-US"));
    $("#comparison-lines tbody").innerHTML = comparison.map((row) => `
      <tr><td>${escapeHtml(row.component)}<br><small>${escapeHtml(row.narrative || "")}</small></td><td>${quantity(row.required)}</td><td>${quantity(row.delivered)}</td><td>${quantity(row.installed)}</td><td>${escapeHtml(row.verdict || "")}</td></tr>`).join("");
    $("#comparison-provenance").textContent = technical.comparison_provenance || "";
  }
}

function renderSummary() {
  const release = state.release;
  const technical = state.technical;
  const prep = state.statusline;
  /* An external owner never sees an action that starts analysis — that is
     the team's decision and the team's spend. When nothing visual has been
     released yet, the owner gets the state of the work as a statement. */
  const pending = $("#summary-pending");
  if (pending) {
    const showPending = state.mode === "external" && !release;
    pending.hidden = !showPending;
    pending.textContent = showPending
      ? "AI analysis pending — your project team is reviewing the available captures."
      : "";
  }
  const nothing = !release && !technical?.baseline && !prep?.preparing;
  $("#summary-empty").hidden = !nothing;
  $("#summary-content").hidden = nothing;
  if (nothing) {
    $("#summary-empty-title").textContent = "Nothing has been released yet";
    $("#summary-empty-copy").textContent =
      "This page shows only what your project team has approved for release. The moment a release or a technical baseline is published, it appears here — you will not be asked to do anything.";
    return;
  }
  $("#summary-project").textContent = state.property?.name || "Project";
  const statusText = release
    ? `Visual release v${release.version} approved ${String(release.approvedAt || "").slice(0, 10)}${technical?.baseline ? ` · technical baseline v${technical.baseline.version} approved` : " · technical baseline not yet published"}`
    : prep?.preparing
      ? `A visual release is being prepared — ${prep.open_checks} governance check${prep.open_checks === 1 ? "" : "s"} open${technical?.baseline ? ` · technical baseline v${technical.baseline.version} approved` : ""}`
      : `Technical baseline v${technical.baseline.version} approved · no visual release yet`;
  $("#summary-status").textContent = statusText;

  const numbers = [];
  if (release) {
    numbers.push(["Rooms released", state.manifest.spaces.length]);
    numbers.push(["Evidence files", state.manifest.spaces.reduce((sum, space) => sum + (space.evidence || []).length, 0)]);
  }
  if (technical?.baseline) {
    numbers.push(["Confirmed lines", (technical.confirmed_lines || []).length]);
    numbers.push(["Open questions", (technical.open_questions || []).length]);
    if ((technical.comparison || []).length) numbers.push(["Components compared", technical.comparison.length]);
  }
  if (prep?.preparing) numbers.push(["Checks before release", prep.open_checks]);
  $("#summary-numbers").innerHTML = numbers.slice(0, 5).map(([label, value]) =>
    `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></article>`).join("");

  const questions = (technical?.open_questions || []).slice(0, 3);
  $("#summary-questions-box").hidden = questions.length === 0;
  $("#summary-questions").innerHTML = questions.map((gap) =>
    `<div class="question-row ${gap.severity === "critical" ? "critical" : ""}">${escapeHtml(gap.question)}</div>`).join("");

  const next = release
    ? { label: "Walk the released rooms", channel: "visual" }
    : technical?.baseline
      ? { label: "Read the published technical results", channel: "technical" }
      : null;
  $("#summary-next").innerHTML = next
    ? `<button class="button" type="button" data-next-channel="${next.channel}">${escapeHtml(next.label)} →</button>`
    : "<span>Nothing is needed from you.</span>";
  $("#summary-next").querySelector("[data-next-channel]")?.addEventListener("click", (event) => {
    showChannel(event.currentTarget.dataset.nextChannel);
  });
}

/* ── data ─────────────────────────────────────────────────────────── */

async function openProperty(propertyId) {
  state.property = state.properties.find((property) => property.id === propertyId) || null;
  if (!state.property) return;
  window.history.replaceState({}, "", `${window.location.pathname}?property=${encodeURIComponent(propertyId)}`);
  state.release = null; state.manifest = null; state.media = new Map();
  state.technical = null; state.statusline = null;

  const [visual, technical] = await Promise.all([
    client.functions.invoke("vision-release", { body: { action: "get", property_id: propertyId } }),
    client.functions.invoke("vision-release", { body: { action: "technical", property_id: propertyId } }),
  ]);
  if (!visual.error && visual.data?.release) {
    state.release = visual.data.release;
    state.manifest = visual.data.manifest;
    state.media = new Map((visual.data.media || []).map((entry) => [entry.evidenceId, entry.url]));
  } else {
    const { data: statusData } = await client.functions.invoke("vision-release", {
      body: { action: "status", property_id: propertyId },
    });
    const draft = (statusData?.releases || []).find((release) => release.state === "draft");
    if (draft) {
      state.statusline = {
        preparing: true,
        version: draft.version,
        open_checks: Number.isFinite(draft.open_checks)
          ? draft.open_checks
          : (draft.manifest?.blockers || []).length,
      };
    }
  }
  if (!technical.error && technical.data && !technical.data.error) state.technical = technical.data;

  renderSummary();
  renderVisual();
  renderTechnical();
  showChannel(state.channel);
}

/* ── boot ─────────────────────────────────────────────────────────── */

function showSignIn() {
  $("#boot-screen").hidden = true;
  $("#app").hidden = true;
  $("#sign-in").hidden = false;
}

async function initialize() {
  if (!client) {
    $("#boot-screen").innerHTML = "<p>Owner View configuration is unavailable.</p>";
    return;
  }
  $("#sign-in-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = $("#sign-in-email").value.trim();
    if (!email) return;
    $("#sign-in-send").disabled = true;
    const { error } = await client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}${window.location.pathname}` },
    });
    $("#sign-in-message").textContent = error
      ? (error.message || "The sign-in link could not be sent. Try again.")
      : "Check your email — the sign-in link is on its way. It opens this page signed in.";
    $("#sign-in-send").disabled = false;
  });
  $("#sign-out")?.addEventListener("click", async () => {
    await client.auth.signOut();
    window.location.replace(window.location.pathname);
  });
  $("#tab-summary")?.addEventListener("click", () => showChannel("summary"));
  $("#tab-visual")?.addEventListener("click", () => showChannel("visual"));
  $("#tab-technical")?.addEventListener("click", () => showChannel("technical"));

  const { data, error } = await client.auth.getSession();
  if (error || !data.session) {
    showSignIn();
    return;
  }
  state.session = data.session;

  /* Assigned projects first: an invited owner may also own an empty personal
     workspace, and a grant — not an accidental membership row — is what
     decides whose Owner View this is. */
  const { data: projectsData } = await client.functions.invoke("vision-release", { body: { action: "projects" } });
  const granted = Array.isArray(projectsData?.projects) ? projectsData.projects : [];

  if (granted.length) {
    state.mode = "external";
    state.properties = granted;
  } else {
    const { data: membership } = await client
      .from("organization_members")
      .select("organization_id, role")
      .eq("user_id", state.session.user.id)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (membership) {
      state.mode = "internal";
      const { data: properties } = await client
        .from("properties")
        .select("id, name, address, created_at")
        .eq("organization_id", membership.organization_id)
        .order("created_at", { ascending: true });
      state.properties = properties || [];
    } else {
      $("#boot-screen").innerHTML =
        "<p>No projects have been shared with this account yet. Ask your project team to invite this email address, then open the link they send you.</p>"
        + '<p><button class="button secondary" id="boot-sign-out" type="button">Sign out</button></p>';
      $("#boot-sign-out")?.addEventListener("click", async () => {
        await client.auth.signOut();
        window.location.replace(window.location.pathname);
      });
      return;
    }
  }

  /* Only an internal member sees the way back into the workshop. */
  $("#open-studio-link").hidden = state.mode !== "internal";
  $("#preview-badge").hidden = state.mode !== "internal";

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
