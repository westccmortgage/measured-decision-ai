/* Measured Decision · spatial markers.

   A 360 capture is not a video, it is a place. Reading a paragraph that says
   "a wall-mounted enclosure is visible" and then hunting for it by dragging the
   sphere is not evidence — it is homework. A marker turns the sentence into a
   point: the reviewer looks at the thing itself, and the statement, its state,
   the file it came from and the second it was seen travel with it.

   The anchor is stored the way it is produced and the way the sphere is
   sampled: as a fraction of the equirectangular frame. u runs left to right,
   v runs top to bottom with v = 0 at the zenith — exactly the mapping in the
   viewer's shader, so a point written by the model, by a person, or by a later
   worker all land in the same place.

   window.MDAIMarkers360.direction(marker)     -> unit vector in world space
   window.MDAIMarkers360.view(marker)          -> the yaw/pitch that centres it
   window.MDAIMarkers360.anchorFromView(view)  -> the anchor at screen centre
   window.MDAIMarkers360.project(marker, view) -> screen position, or not visible
   window.MDAIMarkers360.fromAnalysis(...)     -> markers an AI run produced
   window.MDAIMarkers360.merge(existing, next) -> keeps human review across runs
*/
(() => {
  const TAU = Math.PI * 2;

  /* Four states, and every one of them is honest about who decided. An AI
     observation is never a fact; a person's verdict is the record. */
  const STATES = {
    observed: { label: "Seen by AI · not verified", tone: "review" },
    confirmed: { label: "Confirmed by a person", tone: "ok" },
    rejected: { label: "Marked incorrect by a person", tone: "off" },
    needs_more: { label: "Needs more evidence", tone: "wait" },
    placed: { label: "Placed by a person", tone: "ok" },
  };

  function clamp01(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.min(1, Math.max(0, number));
  }

  function wrapU(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return ((number % 1) + 1) % 1;
  }

  function direction(marker) {
    const theta = (wrapU(marker?.u) - 0.5) * TAU;
    const phi = clamp01(marker?.v) * Math.PI;
    const sinPhi = Math.sin(phi);
    return {
      x: sinPhi * Math.sin(theta),
      y: Math.cos(phi),
      z: -sinPhi * Math.cos(theta),
    };
  }

  function view(marker) {
    return {
      yaw: -((wrapU(marker?.u) - 0.5) * TAU),
      pitch: Math.PI / 2 - clamp01(marker?.v) * Math.PI,
    };
  }

  function anchorFromView(state) {
    return {
      u: wrapU(-(Number(state?.yaw) || 0) / TAU + 0.5),
      v: clamp01((Math.PI / 2 - (Number(state?.pitch) || 0)) / Math.PI),
    };
  }

  /* The inverse of the viewer's shader: undo the yaw, then the pitch, and the
     result is the ray the camera would have to send to hit this point. A ray
     that still points away from the camera is behind the reviewer. */
  function project(marker, state) {
    const dir = direction(marker);
    const cy = Math.cos(-(state.yaw || 0));
    const sy = Math.sin(-(state.yaw || 0));
    const tx = dir.x * cy + dir.z * sy;
    const ty = dir.y;
    const tz = -dir.x * sy + dir.z * cy;
    const cp = Math.cos(-(state.pitch || 0));
    const sp = Math.sin(-(state.pitch || 0));
    const ry = ty * cp - tz * sp;
    const rz = ty * sp + tz * cp;
    if (rz > -0.0001) return { visible: false, x: 0, y: 0, depth: Infinity };
    const tanHalfFov = Math.tan((state.fov || 1.4) / 2);
    const aspect = state.aspect || 1;
    const x = tx / -rz / (tanHalfFov * aspect);
    const y = ry / -rz / tanHalfFov;
    return { visible: Math.abs(x) <= 1.2 && Math.abs(y) <= 1.2, x, y, depth: -rz };
  }

  function timecode(seconds) {
    // A capture with no known second is not second zero, and must not be shown
    // as one — a false timecode sends a reviewer to the wrong moment.
    if (seconds == null || seconds === "") return "";
    const total = Number(seconds);
    if (!Number.isFinite(total) || total < 0) return "";
    const minutes = Math.floor(total / 60);
    const rest = Math.floor(total % 60);
    return `${minutes}:${String(rest).padStart(2, "0")}`;
  }

  function shortLabel(text) {
    const clean = String(text || "").trim().replace(/\s+/g, " ");
    if (clean.length <= 46) return clean;
    const cut = clean.slice(0, 46);
    const space = cut.lastIndexOf(" ");
    return `${(space > 24 ? cut.slice(0, space) : cut).replace(/[,;:.]$/, "")}…`;
  }

  function fingerprint(marker) {
    if (marker?.origin === "person") return `person:${marker.id}`;
    return `ai:${marker?.evidence_id || ""}:${String(marker?.detail || marker?.label || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()}`;
  }

  function makeId(prefix) {
    const random = Math.random().toString(36).slice(2, 8);
    return `${prefix}-${Date.now().toString(36)}-${random}`;
  }

  /* Only an observation the model actually placed becomes a marker. An
     observation with no anchor stays a sentence in the findings list — the
     sphere is not the place to guess where something was. */
  function fromAnalysis(analysis, options = {}) {
    const observations = Array.isArray(analysis?.visible_observations)
      ? analysis.visible_observations
      : [];
    const allowed = options.evidenceIds ? new Set(options.evidenceIds) : null;
    const markers = [];
    observations.forEach((observation) => {
      const anchor = observation?.frame_anchor;
      if (!anchor || typeof anchor !== "object") return;
      const evidenceId = String(anchor.evidence_id || "");
      if (allowed && !allowed.has(evidenceId)) return;
      const u = Number(anchor.u);
      const v = Number(anchor.v);
      if (!Number.isFinite(u) || !Number.isFinite(v)) return;
      markers.push({
        id: makeId("mk"),
        u: wrapU(u),
        v: clamp01(v),
        label: shortLabel(observation.text),
        detail: String(observation.text || "").trim(),
        category: String(observation.category || "other"),
        confidence: Number(observation.confidence) || null,
        origin: "ai",
        state: "observed",
        evidence_id: evidenceId,
        timestamp_seconds: Number.isFinite(Number(anchor.timestamp_seconds))
          ? Number(anchor.timestamp_seconds)
          : null,
        created_at: new Date().toISOString(),
        requests: [],
      });
    });
    return markers;
  }

  function place(anchor, fields = {}) {
    return {
      id: makeId("mk"),
      u: wrapU(anchor?.u),
      v: clamp01(anchor?.v),
      label: shortLabel(fields.label || "Point of interest"),
      detail: String(fields.detail || fields.label || "").trim(),
      category: "other",
      confidence: null,
      origin: "person",
      state: "placed",
      evidence_id: fields.evidence_id || null,
      // Number(null) is 0 and 0 is finite, so a marker on a photo used to claim
      // it was seen at second zero. No known second means no second.
      timestamp_seconds:
        fields.timestamp_seconds != null && Number.isFinite(Number(fields.timestamp_seconds))
          ? Number(fields.timestamp_seconds)
          : null,
      created_at: new Date().toISOString(),
      requests: [],
    };
  }

  /* A second AI run must not erase a person's verdict, and must not silently
     drop the marker a person placed by hand. Anything the new run no longer
     sees disappears only if nobody has touched it. */
  function merge(existing, next) {
    const kept = [];
    const byPrint = new Map();
    (Array.isArray(existing) ? existing : []).forEach((marker) => {
      byPrint.set(fingerprint(marker), marker);
      if (marker.origin === "person" || marker.state !== "observed") kept.push(marker);
    });
    const merged = kept.slice();
    (Array.isArray(next) ? next : []).forEach((marker) => {
      const previous = byPrint.get(fingerprint(marker));
      if (previous) {
        if (merged.includes(previous)) {
          previous.u = marker.u;
          previous.v = marker.v;
          previous.timestamp_seconds = marker.timestamp_seconds;
          return;
        }
      }
      merged.push(marker);
    });
    return merged;
  }

  function stateLabel(state) {
    return (STATES[state] || STATES.observed).label;
  }

  function stateTone(state) {
    return (STATES[state] || STATES.observed).tone;
  }

  window.MDAIMarkers360 = {
    STATES,
    direction,
    view,
    anchorFromView,
    project,
    fromAnalysis,
    place,
    merge,
    stateLabel,
    stateTone,
    timecode,
    shortLabel,
  };
})();
