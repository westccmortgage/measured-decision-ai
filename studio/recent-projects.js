/* Measured Decision · recent projects.

   The front door should remember where you were. A project opened in the
   workspace is recorded on this device so the next visit is one tap, not a
   sign-in followed by a hunt through a directory.

   Only the project id, its name, and when it was opened are stored. Opening
   one still requires a session — this is a shortcut, never an access grant.
*/
(() => {
  const KEY = "mdai-recent-projects-v1";
  const LIMIT = 8;

  function read() {
    try {
      const rows = JSON.parse(window.localStorage.getItem(KEY) || "[]");
      return Array.isArray(rows) ? rows.filter((row) => row?.id && row?.name) : [];
    } catch {
      return [];
    }
  }

  function write(rows) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(rows.slice(0, LIMIT)));
    } catch {
      /* A full or blocked storage must never break opening a project. */
    }
  }

  function remember(project) {
    if (!project?.id || !project?.name) return;
    write([
      { id: project.id, name: String(project.name), openedAt: Date.now() },
      ...read().filter((row) => row.id !== project.id),
    ]);
  }

  function forget(id) {
    write(read().filter((row) => row.id !== id));
  }

  function list() {
    return read().sort((left, right) => Number(right.openedAt || 0) - Number(left.openedAt || 0));
  }

  window.MDAIRecentProjects = { remember, forget, list, clear: () => write([]) };
})();
