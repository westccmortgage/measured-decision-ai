/* Measured Decision · capture trim policy.

   A 360 walkthrough is filmed with nobody holding the camera: the operator
   presses record, walks out of the space, comes back at the end and presses
   stop. Those seconds are the operator, not the object, and they are the first
   and last thing anyone sees in a headset.

   So every consumer of a 360 capture — the AI keyframe sampler, the sphere
   viewer, and the GPU master the worker publishes — reads its usable window
   from here, and one policy decides it. The original file is never cut: the
   window is recorded, so a reviewer can always play the whole clip.

   window.MDAITrim360.plan(durationSeconds) -> the window for a fresh capture
   window.MDAITrim360.resolve(metadata, durationSeconds) -> recorded window, or a fresh one
   window.MDAITrim360.label(window) -> one line for a person
*/
(() => {
  /* Ten seconds is the working default; five is the floor the operator can
     actually make on foot. Below fifteen seconds of remaining footage there is
     no record left to trim, so nothing is hidden. */
  const PREFERRED_SECONDS = 10;
  const MINIMUM_SECONDS = 5;
  const KEEP_AT_LEAST_SECONDS = 15;
  const POLICY = "camera-handling-v1";
  const REASON = "The operator leaves and re-enters the space while the camera is running";

  function round(value) {
    return Number(Number(value).toFixed(2));
  }

  function untrimmed(duration, reason) {
    const total = Number.isFinite(duration) && duration > 0 ? round(duration) : 0;
    return {
      applied: false,
      policy: POLICY,
      head_seconds: 0,
      tail_seconds: 0,
      start_seconds: 0,
      end_seconds: total,
      kept_seconds: total,
      duration_seconds: total,
      reason,
    };
  }

  function plan(durationSeconds) {
    const duration = Number(durationSeconds);
    if (!Number.isFinite(duration) || duration <= 0) {
      return untrimmed(0, "The clip length is unknown, so the whole clip is used");
    }
    for (const pad of [PREFERRED_SECONDS, MINIMUM_SECONDS]) {
      if (duration - pad * 2 >= KEEP_AT_LEAST_SECONDS) {
        return {
          applied: true,
          policy: POLICY,
          head_seconds: pad,
          tail_seconds: pad,
          start_seconds: pad,
          end_seconds: round(duration - pad),
          kept_seconds: round(duration - pad * 2),
          duration_seconds: round(duration),
          reason: REASON,
        };
      }
    }
    return untrimmed(duration, "The clip is too short to trim without losing the space itself");
  }

  /* A window recorded at upload stays authoritative, but it is still checked
     against the file actually playing: a re-upload or a replaced original must
     not leave the viewer seeking past the end of the stream. */
  function resolve(metadata, durationSeconds) {
    const duration = Number(durationSeconds);
    const recorded = metadata && typeof metadata === "object" ? metadata.trim : null;
    if (recorded && recorded.applied) {
      const start = Number(recorded.start_seconds);
      const end = Number(recorded.end_seconds);
      const fits = Number.isFinite(start) && Number.isFinite(end) && end > start &&
        (!Number.isFinite(duration) || duration <= 0 || end <= duration + 0.5);
      if (fits) {
        return {
          ...recorded,
          applied: true,
          policy: recorded.policy || POLICY,
          start_seconds: round(start),
          end_seconds: round(Math.min(end, Number.isFinite(duration) && duration > 0 ? duration : end)),
          kept_seconds: round(Math.max(0, end - start)),
          duration_seconds: Number.isFinite(duration) && duration > 0 ? round(duration) : Number(recorded.duration_seconds) || 0,
          reason: recorded.reason || REASON,
        };
      }
    }
    if (recorded && recorded.applied === false && Number(recorded.duration_seconds) > 0) {
      return { ...untrimmed(duration || recorded.duration_seconds, recorded.reason || ""), policy: recorded.policy || POLICY };
    }
    return plan(duration);
  }

  function label(window) {
    if (!window || !window.applied) return "";
    const head = window.head_seconds;
    const tail = window.tail_seconds;
    return head === tail
      ? `First and last ${head}s hidden — camera handling`
      : `First ${head}s and last ${tail}s hidden — camera handling`;
  }

  window.MDAITrim360 = {
    plan,
    resolve,
    label,
    PREFERRED_SECONDS,
    MINIMUM_SECONDS,
    KEEP_AT_LEAST_SECONDS,
    POLICY,
  };
})();
