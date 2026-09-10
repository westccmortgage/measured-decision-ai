/* WHICH PIECES OF A FILE BECOME ASSIGNMENTS, AND WHAT THAT DOES NOT PROVE.
 *
 * A page of a PDF is a whole piece: every page becomes an assignment, so a
 * finished PDF analysis has looked at every page of that file.
 *
 * A video is not like that, and this module refuses to pretend otherwise. A
 * ten-minute clip is eighteen thousand frames; nothing here reads eighteen
 * thousand frames. It picks a bounded set of moments, records the moment each
 * frame actually came from, and `coverageSentence` below is the sentence the
 * screen must print beside the result. It says what was read and, in the same
 * breath, what was not.
 *
 * A plain ES module with no imports: the browser and the test suite run this
 * same copy.
 */

/* The most moments one clip contributes, and the closest two of them may be.
   Both are ceilings on cost as much as on time: every frame is a paid reading
   twice over, because two readers see it independently. */
export const MAXIMUM_MOMENTS = 60;
export const CLOSEST_MOMENTS_SECONDS = 2;
/* What the sampler aims for when the clip is short enough to allow it: a
   frame every two seconds. Past sixty frames the step widens instead, which
   is why a ten-minute clip is sampled every ten seconds and says so. */
export const PREFERRED_STEP_SECONDS = 2;

/* PAGES.
   1-based, in reading order, all of them. */
export function pagePlan(pageCount) {
  const pages = Math.max(0, Math.floor(Number(pageCount) || 0));
  const out = [];
  for (let page = 1; page <= pages; page += 1) out.push({ ordinal: page, page });
  return out;
}

/* MOMENTS.
   Evenly spaced from the first frame to the last, inclusive of both, with the
   step widened until the count fits. The seconds are what will be ASKED for;
   what a decoder actually lands on is written down separately, because a
   decoder seeks to the nearest keyframe it can and the difference is
   sometimes a second. */
export function momentPlan(durationSeconds, options = {}) {
  const duration = Number(durationSeconds);
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const maximum = Math.max(1, Math.floor(options.maximumMoments ?? MAXIMUM_MOMENTS));
  const closest = Math.max(0.1, Number(options.closestSeconds ?? CLOSEST_MOMENTS_SECONDS));
  const preferred = Math.max(closest, Number(options.preferredStepSeconds ?? PREFERRED_STEP_SECONDS));

  /* How many moments the preferred step would give, then reduced until it is
     inside the ceiling. */
  let count = Math.floor(duration / preferred) + 1;
  if (count > maximum) count = maximum;
  if (count < 1) count = 1;

  /* A single-moment clip is the first frame and nothing else. */
  if (count === 1) return [{ ordinal: 1, seconds: 0 }];

  const step = duration / (count - 1);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    /* The last one is pulled a hair inside the end: seeking to exactly the
       duration lands past the final frame in every browser and returns the
       poster or nothing at all. */
    const raw = i === count - 1 ? Math.max(0, duration - 0.05) : i * step;
    const seconds = Math.round(raw * 100) / 100;
    if (out.length > 0 && seconds - out[out.length - 1].seconds < closest * 0.5) continue;
    out.push({ ordinal: out.length + 1, seconds });
  }
  return out;
}

/* THE SENTENCE THAT MUST APPEAR BESIDE A VIDEO RESULT.
   `moments` are the ones actually prepared, with the seconds they actually
   came from. */
export function coverageSentence(durationSeconds, moments) {
  const duration = Number(durationSeconds) || 0;
  const n = Array.isArray(moments) ? moments.length : 0;
  if (n === 0) return "No moment of this clip was read.";
  const seconds = moments.map((m) => Number(m.seconds) || 0).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < seconds.length; i += 1) gaps.push(seconds[i] - seconds[i - 1]);
  const widest = gaps.length ? Math.max(...gaps) : duration;
  return (
    `${n} ${n === 1 ? "moment" : "moments"} of this ${clock(duration)} clip were read, ` +
    `the widest unread gap between them being ${widest.toFixed(1)} seconds. ` +
    `Nothing between two read moments was looked at, so this analysis cannot say that something is absent from the clip — only that it was not in these ${n} frames.`
  );
}

export function clock(seconds) {
  const whole = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/* HOW MANY SUBJECTS A SET OF FILES WOULD MAKE, for the estimate on the screen
   and for the refusal when it is too many. One page is one subject; one
   moment is one subject. */
export function subjectCount(files) {
  return (files || []).reduce((total, file) => total + (Number(file.totalUnits) || 0), 0);
}
