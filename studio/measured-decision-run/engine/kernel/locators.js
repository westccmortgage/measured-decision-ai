export function normalisedBbox(value) {
    return Array.isArray(value) && value.length === 4
        && value.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1)
        && value[0] <= value[2] && value[1] <= value[3];
}
/* A locator that says something the kernel cannot accept: a box that is not
   normalised, a range that runs backwards, a time that is not a number. */
export function locatorProblem(locator) {
    if (!locator || typeof locator !== "object")
        return "locator is not an object";
    if ("bbox" in locator && locator.bbox !== undefined && !normalisedBbox(locator.bbox))
        return "box is not normalised 0..1";
    const hasStart = locator.start_ms !== undefined, hasEnd = locator.end_ms !== undefined;
    if (hasStart !== hasEnd)
        return "a time range needs both start_ms and end_ms";
    if (hasStart) {
        if (typeof locator.start_ms !== "number" || typeof locator.end_ms !== "number")
            return "start_ms and end_ms must be numbers";
        if (locator.start_ms < 0 || locator.end_ms < locator.start_ms)
            return "a time range runs forward from zero";
    }
    return null;
}
export function bboxInside(inner, outer) {
    const eps = 1e-9;
    return inner[0] >= outer[0] - eps && inner[1] >= outer[1] - eps && inner[2] <= outer[2] + eps && inner[3] <= outer[3] + eps;
}
/* Whether `inner` lies within `outer` on every geometry both of them have.
   A geometry only one of them has is not a disagreement. */
export function locatorInside(inner, outer) {
    if (normalisedBbox(inner.bbox) && normalisedBbox(outer.bbox) && !bboxInside(inner.bbox, outer.bbox))
        return false;
    if (typeof inner.start_ms === "number" && typeof inner.end_ms === "number"
        && typeof outer.start_ms === "number" && typeof outer.end_ms === "number") {
        if (inner.start_ms < outer.start_ms || inner.end_ms > outer.end_ms)
            return false;
    }
    return true;
}
export function sameLocator(a, b) {
    return JSON.stringify(a.bbox ?? null) === JSON.stringify(b.bbox ?? null)
        && (a.start_ms ?? null) === (b.start_ms ?? null) && (a.end_ms ?? null) === (b.end_ms ?? null);
}
/* Whether a locator carries any geometry the kernel recognises. */
export function hasGeometry(locator) {
    return normalisedBbox(locator.bbox) || (typeof locator.start_ms === "number" && typeof locator.end_ms === "number");
}
