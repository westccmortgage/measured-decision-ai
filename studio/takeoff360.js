/* Measured Decision · framing takeoff calculator.
 *
 * Deterministic on purpose. The AI's job ends at reading the dimensions that
 * are printed on the sheets — a fact drawn on a drawing, with the sheet as its
 * citation. Everything from there to a lumber count is arithmetic and framing
 * convention, and arithmetic does not belong in a language model: the same wall
 * must produce the same stud count every time, and a person checking the order
 * must be able to follow every step by hand.
 *
 * What this is: a draft takeoff for verification, every line traceable to the
 * sheets it came from. What it is not: a contractor's estimate. Waste, cut
 * optimisation, and regional practice are a builder's judgement, and the screen
 * that shows this output says so.
 *
 * Conventions encoded (standard platform framing, stated so they can be
 * disputed):
 *   - studs: ceil(length / spacing) + 1, plus 2 extra per corner (three-stud
 *     corner keeps one from the run), plus 1 extra per wall intersection.
 *   - openings: 2 king studs; trimmers per side (1 up to 6', 2 above); the
 *     studs displaced by the opening are NOT subtracted — they become cripples
 *     above the header and below the sill, which is the conservative reading.
 *   - plates: one bottom + double top = 3 × wall length, in stock lengths.
 *   - headers: 2 pieces, opening width + 3" bearing each side, depth by span:
 *     ≤4' → 2×6, ≤6' → 2×8, ≤8' → 2×10, wider → 2×12 and flagged for review.
 *   - stock lengths: shortest standard length that covers, from 8/10/12/14/16'.
 *
 * Units: lengths arrive in inches (parseFeetInches turns drawing strings into
 * inches). Output quantities are pieces of dimensional lumber by stock length.
 */
(() => {
  const STOCK_LENGTHS_FT = [8, 10, 12, 14, 16];

  /* "12'-6"", "12'-6 1/2"", "12 ft 6 in", "150"", "12'" — the ways a drawing
     writes a length. Returns inches, or null for anything it cannot read;
     null is a gap to report, never a zero to compute with. */
  function parseFeetInches(text) {
    if (typeof text === "number" && Number.isFinite(text)) return text;
    const raw = String(text || "").trim().toLowerCase().replace(/[”″]/g, '"').replace(/[’′]/g, "'");
    if (!raw) return null;
    let feet = 0; let inches = 0; let matched = false;
    const ftMatch = raw.match(/(\d+(?:\.\d+)?)\s*(?:'|ft|feet)/);
    if (ftMatch) { feet = Number(ftMatch[1]); matched = true; }
    const inPart = ftMatch ? raw.slice(ftMatch.index + ftMatch[0].length) : raw;
    const inMatch = inPart.match(/(\d+(?:\.\d+)?)(?:\s+(\d+)\/(\d+))?\s*(?:"|in\b|inch)/);
    if (inMatch) {
      inches = Number(inMatch[1]);
      if (inMatch[2] && inMatch[3] && Number(inMatch[3]) !== 0) inches += Number(inMatch[2]) / Number(inMatch[3]);
      matched = true;
    } else if (ftMatch) {
      const bare = inPart.match(/^\s*-?\s*(\d+(?:\.\d+)?)(?:\s+(\d+)\/(\d+))?\s*$/);
      if (bare) {
        inches = Number(bare[1]);
        if (bare[2] && bare[3] && Number(bare[3]) !== 0) inches += Number(bare[2]) / Number(bare[3]);
      }
    }
    if (!matched) return null;
    const total = feet * 12 + inches;
    return Number.isFinite(total) && total > 0 ? total : null;
  }

  function stockLengthFor(inches) {
    const feet = inches / 12;
    for (const stock of STOCK_LENGTHS_FT) if (feet <= stock) return stock;
    /* Longer than any stock piece: spliced from the longest. */
    return STOCK_LENGTHS_FT[STOCK_LENGTHS_FT.length - 1];
  }

  function headerDepthFor(spanInches) {
    if (spanInches <= 48) return "2x6";
    if (spanInches <= 72) return "2x8";
    if (spanInches <= 96) return "2x10";
    return "2x12";
  }

  /* One wall in, the lumber it needs out. Every number in the result is
     explainable from the inputs by hand, and the trace says how. */
  function takeoffWall(wall) {
    const length = parseFeetInches(wall.length);
    const height = parseFeetInches(wall.height) ?? 97.125; /* 8' precut studs */
    const spacing = Number(wall.stud_spacing_inches) || 16;
    if (length == null) return { unmeasured: true, wall };
    const size = /^2x[0-9]+$/.test(String(wall.stud_size || "")) ? wall.stud_size : "2x4";
    const corners = Math.max(0, Number(wall.corners) || 0);
    const intersections = Math.max(0, Number(wall.intersections) || 0);
    const openings = Array.isArray(wall.openings) ? wall.openings : [];

    const lines = [];
    const trace = [];
    const gaps = [];

    const runStuds = Math.ceil(length / spacing) + 1;
    const cornerStuds = corners * 2;
    const intersectionStuds = intersections;
    let studCount = runStuds + cornerStuds + intersectionStuds;
    trace.push(`studs: ceil(${length}" / ${spacing}") + 1 = ${runStuds}, + ${cornerStuds} for ${corners} corner(s), + ${intersectionStuds} for ${intersections} intersection(s)`);

    let headerPieces = [];
    for (const opening of openings) {
      const span = parseFeetInches(opening.width);
      if (span == null) {
        gaps.push(`${opening.label || "an opening"} in ${wall.label || "this wall"} has no readable width`);
        continue;
      }
      const trimmersPerSide = span > 72 ? 2 : 1;
      const kings = 2;
      const added = kings + trimmersPerSide * 2;
      studCount += added;
      const depth = headerDepthFor(span);
      const headerLength = span + 6; /* 3" bearing each side */
      headerPieces.push({ depth, lengthInches: headerLength, span, review: span > 96 });
      trace.push(`${opening.label || "opening"}: ${kings} kings + ${trimmersPerSide * 2} trimmers; header 2 × ${depth} @ ${Math.ceil(headerLength)}" (${span}" span + bearing)`);
    }

    const studStock = height <= 97.125 ? "92 5/8\" precut" : `${stockLengthFor(height)}'`;
    lines.push({ item: `${size} stud · ${studStock}`, quantity: studCount, unit: "pieces" });

    const plateLengthIn = length * 3;
    const plateStockFt = stockLengthFor(Math.min(length, 16 * 12));
    const platePieces = Math.ceil(plateLengthIn / (plateStockFt * 12));
    lines.push({ item: `${size} plate · ${plateStockFt}'`, quantity: platePieces, unit: "pieces" });
    trace.push(`plates: 3 × ${length}" = ${plateLengthIn}" → ${platePieces} × ${plateStockFt}' stock`);

    const headers = new Map();
    for (const piece of headerPieces) {
      const stock = stockLengthFor(piece.lengthInches);
      const key = `${piece.depth} header · ${stock}'${piece.review ? " · REVIEW: span over 8'" : ""}`;
      headers.set(key, (headers.get(key) || 0) + 2);
    }
    headers.forEach((quantity, item) => lines.push({ item, quantity, unit: "pieces" }));

    return { unmeasured: false, wall, lines, trace, gaps, lengthInches: length };
  }

  /* The whole set of walls the AI read, turned into one order draft. Walls
     without a readable length are returned as what they are — gaps that need a
     person — never silently dropped and never guessed at. */
  function takeoff(walls, decks) {
    const lines = new Map();
    const traces = [];
    const gaps = [];
    const unmeasured = [];
    let measuredWalls = 0;
    for (const deck of Array.isArray(decks) ? decks : []) {
      const result = takeoffDeck(deck);
      if (result.lines.length) measuredWalls += 1;
      traces.push({ wall: deck.label || "deck", source_refs: deck.source_refs || [], steps: result.steps });
      gaps.push(...result.gaps);
      for (const line of result.lines) {
        const key = line.item;
        if (!lines.has(key)) lines.set(key, { item: line.item, quantity: 0, unit: line.unit });
        lines.get(key).quantity += line.quantity;
      }
    }
    for (const wall of Array.isArray(walls) ? walls : []) {
      const result = takeoffWall(wall);
      if (result.unmeasured) {
        unmeasured.push(wall);
        continue;
      }
      measuredWalls += 1;
      traces.push({ wall: wall.label || "wall", source_refs: wall.source_refs || [], steps: result.trace });
      gaps.push(...result.gaps);
      for (const line of result.lines) {
        const key = line.item;
        if (!lines.has(key)) lines.set(key, { item: line.item, quantity: 0, unit: line.unit });
        lines.get(key).quantity += line.quantity;
      }
    }
    return {
      lines: [...lines.values()].sort((a, b) => a.item.localeCompare(b.item)),
      traces,
      gaps,
      unmeasured,
      measuredWalls,
    };
  }

  /* A deck is not a wall. Its lumber is joists over an area, beams and posts
     on a pile grid, and a walking surface — and the first version of this
     calculator had no vocabulary for any of it, so a deck plan produced "no
     framing dimensions" while the schedules sat printed on S-2.0. This is the
     deck's arithmetic, under the same rules: printed numbers in, every step
     shown, unreadable is a gap and never a zero.

     Joist linear feet from an area is exact arithmetic, not estimation:
     LF = area / spacing — one joist-line every `spacing` across the whole
     surface, independent of which way the joists run. Piece counts, by
     contrast, need span layout, which is a builder's cut list, not a
     drawing's fact — so LF is what this states. */
  function takeoffDeck(deck) {
    const lines = [];
    const steps = [];
    const gaps = [];
    const label = deck.label || "deck";

    let areaSqft = Number(String(deck.area_sqft ?? "").replace(/[^0-9.]/g, "")) || null;
    if (areaSqft) {
      steps.push(`area: ${areaSqft} sq ft as printed`);
    } else {
      const length = parseFeetInches(deck.length);
      const width = parseFeetInches(deck.width);
      if (length != null && width != null) {
        areaSqft = (length / 12) * (width / 12);
        steps.push(`area: ${(length / 12).toFixed(2)}' × ${(width / 12).toFixed(2)}' = ${areaSqft.toFixed(0)} sq ft from printed overalls — jogs not netted, so this is the outer bound`);
      }
    }

    const spacing = parseFeetInches(deck.joist_spacing)
      ?? (Number(String(deck.joist_spacing ?? "").replace(/[^0-9.]/g, "")) || null);
    const joistSize = /^\d+x\d+$/.test(String(deck.joist_size || "")) ? deck.joist_size : null;
    if (areaSqft && spacing && joistSize) {
      const joistLf = Math.ceil((areaSqft * 12) / spacing);
      lines.push({
        item: `${joistSize} joist${deck.joist_treatment ? ` (${deck.joist_treatment})` : ""} — linear feet`,
        quantity: joistLf, unit: "LF",
      });
      steps.push(`joists: ${areaSqft.toFixed(0)} sq ft × 12 / ${spacing}" o.c. = ${joistLf} LF`);
    } else {
      if (!areaSqft) gaps.push(`${label}: no printed area or overall dimensions, so joist footage cannot be computed`);
      if (!spacing) gaps.push(`${label}: joist spacing is not printed`);
      if (!joistSize && deck.joist_size) gaps.push(`${label}: joist size "${deck.joist_size}" is not a lumber size this calculator reads`);
    }

    /* The walking surface. Board decking is exact arithmetic per face width at
       zero gap — the stated upper bound, because the gap between boards is a
       product spec the sheets rarely print. Sheathing is exact per 4×8 sheet. */
    const decking = String(deck.decking || "");
    const boardMatch = decking.match(/2\s*x\s*(4|6)/i);
    const sheetMatch = decking.match(/plywood|sheathing|19\/32|23\/32|osb/i);
    if (areaSqft && boardMatch) {
      const face = boardMatch[1] === "6" ? 5.5 : 3.5;
      const boardLf = Math.ceil((areaSqft * 12) / face);
      lines.push({ item: `decking 2x${boardMatch[1]} — linear feet (zero gap, upper bound)`, quantity: boardLf, unit: "LF" });
      steps.push(`decking: ${areaSqft.toFixed(0)} sq ft × 12 / ${face}" face = ${boardLf} LF at zero board gap`);
    } else if (areaSqft && sheetMatch) {
      const sheets = Math.ceil(areaSqft / 32);
      lines.push({ item: `deck sheathing ${decking.trim()} — 4×8 sheets`, quantity: sheets, unit: "sheets" });
      steps.push(`sheathing: ${areaSqft.toFixed(0)} sq ft / 32 sq ft per sheet = ${sheets} sheets`);
    } else if (decking && areaSqft) {
      gaps.push(`${label}: decking "${decking.trim()}" — the area is ${areaSqft.toFixed(0)} sq ft, but this product's coverage is not something the sheets state`);
    }

    /* Members that are drawn and labelled are counted, not measured: counting
       the P1 marks on a foundation plan is reading the drawing, the same way
       counting corners is. A mark with no count stays a question. */
    for (const beam of Array.isArray(deck.beams) ? deck.beams : []) {
      const count = Number(beam.count_drawn) || 0;
      if (count > 0) {
        lines.push({ item: `beam ${beam.mark || ""}: ${String(beam.description || "").trim()}`.trim(), quantity: count, unit: "drawn on plan" });
        steps.push(`${beam.mark || "beam"}: ${count} drawn on the framing plan`);
      } else {
        gaps.push(`${label}: beam ${beam.mark || ""} (${String(beam.description || "").trim()}) is scheduled but its drawn count was not read`);
      }
    }
    for (const column of Array.isArray(deck.columns) ? deck.columns : []) {
      const count = Number(column.count_drawn) || 0;
      if (count > 0) {
        lines.push({ item: `column ${column.mark || ""}: ${String(column.description || "").trim()}`.trim(), quantity: count, unit: "drawn on plan" });
      } else {
        gaps.push(`${label}: column ${column.mark || ""} is scheduled but its drawn count was not read`);
      }
    }
    if (deck.piles && (Number(deck.piles.count_drawn) || 0) > 0) {
      lines.push({ item: `pile: ${String(deck.piles.description || "").trim()}`, quantity: Number(deck.piles.count_drawn), unit: "drawn on plan" });
    } else if (deck.piles?.description) {
      gaps.push(`${label}: piles are scheduled (${String(deck.piles.description).trim()}) but their drawn count was not read`);
    }

    const railLength = parseFeetInches(deck.guardrail_length);
    if (deck.guardrail && railLength != null) {
      lines.push({ item: `guardrail: ${String(deck.guardrail).trim()}`, quantity: Math.ceil(railLength / 12), unit: "LF" });
      steps.push(`guardrail: ${Math.ceil(railLength / 12)} LF as printed`);
    } else if (deck.guardrail) {
      gaps.push(`${label}: a guardrail is specified (${String(deck.guardrail).trim()}) but no printed run length was read`);
    }

    return { lines, steps, gaps };
  }

  const api = { parseFeetInches, takeoffWall, takeoff, takeoffDeck, stockLengthFor, headerDepthFor };
  if (typeof window !== "undefined") window.MDAITakeoff360 = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
