(() => {
  const taskId = new URLSearchParams(window.location.search).get("capture_task");
  if (!taskId) return;

  const config = window.MDAI_CONFIG || {};
  if (!window.supabase?.createClient || !config.supabaseUrl || !config.supabasePublishableKey) return;
  const bridgeClient = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  let context = null;
  let selectedNames = [];
  let uploadStartedAt = null;
  let linking = false;

  const style = document.createElement("style");
  style.textContent = `
    .capture-task-context{margin:0 0 18px;padding:14px 17px;display:grid;grid-template-columns:1fr auto;gap:10px 18px;align-items:center;border:1px solid rgba(72,211,232,.32);background:rgba(72,211,232,.06)}
    .capture-task-context p{margin:0;color:#48d3e8;text-transform:uppercase;letter-spacing:.1em;font-size:9px;font-weight:700}
    .capture-task-context h2{margin:2px 0 0;font-size:15px}
    .capture-task-context small{color:#7890a2}
    .capture-task-context .task-bridge-status{grid-column:1/-1;color:#8ea5b6}
    .capture-task-context .task-bridge-status.success{color:#54d39a}
    .capture-task-context .task-bridge-status.error{color:#ff7b76}
  `;
  document.head.appendChild(style);

  function escapeHtml(value = "") {
    return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  }

  function status(message, kind = "") {
    const element = document.querySelector("#task-bridge-status");
    if (!element) return;
    element.textContent = message;
    element.className = `task-bridge-status ${kind}`;
  }

  async function loadContext() {
    const { data: sessionData } = await bridgeClient.auth.getSession();
    if (!sessionData.session) return;
    const { data: task, error } = await bridgeClient
      .from("capture_tasks")
      .select("id, property_id, baseline_id, status, requirement:capture_requirements(id, title, capture_type, before_concealment, plan_space:plan_spaces(building, level, name))")
      .eq("id", taskId)
      .single();
    if (error || !task) return;
    context = task;
    const requirement = task.requirement || {};
    const space = requirement.plan_space;
    const location = space ? `${space.building} → ${space.level} → ${space.name}` : "Project-wide capture";
    const section = document.createElement("section");
    section.className = "capture-task-context";
    section.innerHTML = `
      <div><p>Active roadmap assignment</p><h2>${escapeHtml(requirement.title || "Capture requirement")}</h2><small>${escapeHtml(location)} · ${escapeHtml(requirement.capture_type || "Evidence")}</small></div>
      <a class="secondary-button" href="plans/?property=${encodeURIComponent(task.property_id)}">View roadmap</a>
      <small id="task-bridge-status" class="task-bridge-status">Upload evidence normally. The new source will be attached to this requirement automatically.</small>`;
    const header = document.querySelector("main[data-view='property'] .property-header");
    if (header) header.insertAdjacentElement("afterend", section);
  }

  function rememberFiles(input) {
    selectedNames = Array.from(input.files || []).map((file) => file.name);
  }

  async function findAndLinkEvidence() {
    if (!context || !uploadStartedAt || !selectedNames.length || linking) return;
    linking = true;
    status("Waiting for the secure upload to finish…");
    try {
      const { data: sessionData } = await bridgeClient.auth.getSession();
      const userId = sessionData.session?.user?.id;
      if (!userId) throw new Error("Secure session expired");
      for (let attempt = 0; attempt < 200; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, attempt ? 3000 : 800));
        const { data: rows, error } = await bridgeClient
          .from("evidence_items")
          .select("id, original_filename, capture_task_id")
          .eq("property_id", context.property_id)
          .eq("created_by", userId)
          .gte("created_at", uploadStartedAt)
          .in("original_filename", selectedNames);
        if (error) throw error;
        const unlinked = (rows || []).filter((row) => !row.capture_task_id);
        if (rows?.length >= selectedNames.length && unlinked.length) {
          const { error: linkError } = await bridgeClient.rpc("link_evidence_to_capture_task", {
            target_task: context.id,
            target_evidence: unlinked.map((row) => row.id),
          });
          if (linkError) throw linkError;
          status(`${rows.length} evidence item${rows.length === 1 ? "" : "s"} attached to this roadmap task.`, "success");
          window.history.replaceState({}, "", `${window.location.pathname}?property=${encodeURIComponent(context.property_id)}`);
          return;
        }
      }
      throw new Error("Upload was not detected. Open the roadmap and retry from the task.");
    } catch (error) {
      console.error(error);
      status(error.message || "Evidence could not be linked to the roadmap task.", "error");
    } finally {
      linking = false;
    }
  }

  [document.querySelector("#file-upload"), document.querySelector("#file-upload-intake")]
    .filter(Boolean)
    .forEach((input) => input.addEventListener("change", () => rememberFiles(input)));

  const save = document.querySelector("#save-upload");
  if (save) {
    save.addEventListener("click", () => {
      if (!context || !selectedNames.length) return;
      uploadStartedAt = new Date(Date.now() - 2000).toISOString();
      findAndLinkEvidence();
    });
  }

  loadContext().catch(console.error);
})();
