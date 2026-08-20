/* Measured Decision · capture-to-capture comparison.

   A single capture answers "what is here". It cannot answer the question the
   money actually depends on: "what appeared since the last time, and is it what
   I was billed for". That answer only exists between two captures of the same
   space, and it is the difference between a viewer and an instrument.

   The comparison is deliberately conservative, because the failure modes are
   not symmetric. Claiming something appeared when it was merely visible from a
   better angle is an annoyance. Claiming something was removed when the camera
   simply did not look that way is a false accusation about a contractor. So a
   thing missing from the later capture is never called "removed" — it is
   "no longer visible", and it is ranked below everything else.

   Nothing here is a fact. Every line is an AI suggestion carrying the evidence
   it came from, and a person settles it.

   window.MDAICompare360.compare(earlier, later) -> the change set
*/
(() => {
  /* Words that carry no identity. Two observations that share only these are
     not the same thing. */
  const NOISE = new Set([
    "a", "an", "the", "and", "or", "of", "in", "on", "at", "to", "is", "are",
    "with", "for", "from", "by", "this", "that", "these", "those", "it", "its",
    "visible", "seen", "shows", "showing", "appears", "several", "some", "one",
    "two", "three", "across", "along", "near", "over", "under", "there", "be",
    "was", "were", "has", "have", "not", "no", "into", "onto", "within",
  ]);

  const SAME_THRESHOLD = 0.34;
  const NEAR_THRESHOLD = 0.2;
  /* Two anchors within about twelve degrees are pointing at the same place in
     the room, which is strong evidence they are the same object. */
  const SAME_DIRECTION_RADIANS = 0.21;

  function tokens(text) {
    return new Set(
      String(text || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .map((word) => word.replace(/(ing|ed|s)$/, ""))
        .filter((word) => word.length > 2 && !NOISE.has(word)),
    );
  }

  function overlap(a, b) {
    if (!a.size || !b.size) return 0;
    let shared = 0;
    a.forEach((word) => { if (b.has(word)) shared += 1; });
    return shared / (a.size + b.size - shared);
  }

  /* The angle between two anchors on the sphere. Two captures of one space are
     not filmed from the same spot, so this supports a match — it never makes
     one on its own. */
  function separation(one, two) {
    if (!window.MDAIMarkers360 || !one || !two) return null;
    const a = window.MDAIMarkers360.direction(one);
    const b = window.MDAIMarkers360.direction(two);
    const dot = Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y + a.z * b.z));
    return Math.acos(dot);
  }

  function normalize(analysis) {
    const list = Array.isArray(analysis?.visible_observations) ? analysis.visible_observations : [];
    return list
      .map((observation) => ({
        text: String(observation?.text || "").trim(),
        category: String(observation?.category || "other"),
        confidence: Number(observation?.confidence) || null,
        anchor: observation?.frame_anchor || null,
        words: tokens(observation?.text),
      }))
      .filter((observation) => observation.text && observation.words.size);
  }

  function bestMatch(observation, pool, used) {
    let best = null;
    pool.forEach((candidate, index) => {
      if (used.has(index)) return;
      const score = overlap(observation.words, candidate.words);
      if (score < NEAR_THRESHOLD) return;
      const angle = separation(observation.anchor, candidate.anchor);
      // A shared direction is worth roughly one more shared word.
      const bonus = angle != null && angle <= SAME_DIRECTION_RADIANS ? 0.12 : 0;
      const total = score + bonus;
      if (!best || total > best.total) best = { index, candidate, score, total, angle };
    });
    return best;
  }

  function quality(analysis) {
    const value = String(analysis?.capture_quality || "").toLowerCase();
    return value === "strong" ? 3 : value === "usable" ? 2 : value === "limited" ? 1 : 0;
  }

  /* A comparison is only as good as the weaker of the two captures. Saying so
     is the difference between a measurement and a guess dressed as one. */
  function reliability(earlier, later) {
    const weakest = Math.min(quality(earlier) || 2, quality(later) || 2);
    if (weakest >= 3) return { level: "strong", note: "" };
    if (weakest === 2) {
      return { level: "usable", note: "Both captures are usable, so a thing hidden behind stored material in one of them can read as a change." };
    }
    return {
      level: "limited",
      note: "One of the captures is limited, so this comparison shows candidates for review, not established changes.",
    };
  }

  function compare(earlier, later, context = {}) {
    const before = normalize(earlier);
    const after = normalize(later);
    const used = new Set();
    const appeared = [];
    const unchanged = [];

    after.forEach((observation) => {
      const match = bestMatch(observation, before, used);
      if (match && match.total >= SAME_THRESHOLD) {
        used.add(match.index);
        unchanged.push({
          text: observation.text,
          category: observation.category,
          anchor: observation.anchor,
          previous_text: match.candidate.text,
          confidence: Number(match.total.toFixed(2)),
          same_direction: match.angle != null && match.angle <= SAME_DIRECTION_RADIANS,
        });
        return;
      }
      appeared.push({
        text: observation.text,
        category: observation.category,
        anchor: observation.anchor,
        /* How sure we are it is new, not how sure the model was it is there:
           a weak partial match means it may be the same thing described
           differently, and that doubt travels with the line. */
        confidence: match ? Number((1 - match.total).toFixed(2)) : 1,
        nearest_previous: match ? match.candidate.text : "",
      });
    });

    const gone = before
      .map((observation, index) => (used.has(index) ? null : observation))
      .filter(Boolean)
      .map((observation) => ({
        text: observation.text,
        category: observation.category,
        anchor: observation.anchor,
        confidence: 0.4,
      }));

    const trust = reliability(earlier, later);
    return {
      compared_at: new Date().toISOString(),
      earlier_label: context.earlier_label || "the previous capture",
      later_label: context.later_label || "this capture",
      earlier_ids: context.earlier_ids || [],
      later_ids: context.later_ids || [],
      reliability: trust.level,
      reliability_note: trust.note,
      appeared,
      gone,
      unchanged,
      /* One sentence a person can read standing up, and it never says a change
         is a fact. */
      headline: appeared.length
        ? `${appeared.length} thing${appeared.length === 1 ? "" : "s"} appeared since ${context.earlier_label || "the previous capture"}`
        : gone.length
          ? `Nothing new is visible; ${gone.length} thing${gone.length === 1 ? " is" : "s are"} no longer in view`
          : "Nothing visibly changed between the two captures",
      state: "observed",
    };
  }

  window.MDAICompare360 = { compare, tokens, overlap, SAME_THRESHOLD };
})();
