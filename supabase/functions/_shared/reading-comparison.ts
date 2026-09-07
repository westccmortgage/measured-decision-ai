/* WHAT CODE CAN SETTLE BEFORE ANYONE IS ASKED TO JUDGE.
 *
 * Three readers have read one plan set. Before a model is paid to say which
 * read it better, this file does the part that needs no opinion: line the
 * three answers up position by position, and name — mechanically, from the
 * rows themselves — where they agree, where they differ, where only one of
 * them saw something at all, where two say the same number about different
 * things, and where a number does not follow from the row that carries it.
 *
 * Three rules hold this together, and each of them exists because breaking
 * it produces a confident wrong answer:
 *
 *   A position is a category, a mark, a place and a source. The same mark
 *   in two different schedules is two positions, not one — merging them is
 *   how "FB1 in the roof schedule" becomes "FB1" and a comparison starts
 *   comparing a beam with a footing.
 *
 *   A count is only comparable to a count of the same thing. `counted`
 *   distinguishes a framing zone from an individual member from an assembly
 *   from the boards inside it. Twelve zones and twelve rafters are not
 *   agreement, and twelve zones read as twelve rafters is the specific
 *   error this comparison exists to catch.
 *
 *   Agreement is not proof. Two readers saying the same wrong thing is two
 *   readers saying the same wrong thing. Nothing here returns a verdict —
 *   it returns what was found, for a check that looks at the drawings.
 */

export type ReadingInput = {
  /* The baseline this answer came from. */
  id: string;
  /* A, B or C — the label a checker sees. Which provider it was stays on
     the server. */
  blind: string;
  analysis: Record<string, any>;
};

export type Position = {
  section: string;
  /* category | mark | level | place — what makes two rows the same position. */
  key: string;
  mark: string;
  category: string;
  level: string;
  location: string;
  description: string;
  size: string;
  spacing: string;
  unit: string;
  counted: string;
  plies: number | null;
  size_basis: string;
  count: number | null;
  count_scheduled: number | null;
  count_drawn: number | null;
  count_confidence: string;
  count_note: string;
  sources: string[];
};

const text = (value: unknown) => String(value ?? "").trim();
const squash = (value: unknown) => text(value).toLowerCase().replace(/\s+/g, " ");
/* Marks are written FB-1, FB.1, FB 1 and FB1 by three different readers and
   by two different sheets. The separators carry no meaning; the letters and
   the digits do. */
const markKey = (value: unknown) => squash(value).replace(/[^a-z0-9]+/g, "");
const integer = (value: unknown) => (Number.isFinite(Number(value)) && text(value) !== "" ? Math.trunc(Number(value)) : null);

/* "ea", "EA", "each", "ea." are one unit. "lf" and "linear feet" are one
   unit. "ea" and "lf" are not, and a comparison that treats them as one
   compares a count of pieces with a length. */
const UNIT_ALIASES: Record<string, string> = {
  ea: "ea", each: "ea", eaches: "ea", pc: "ea", pcs: "ea", piece: "ea", pieces: "ea", no: "ea", nos: "ea", count: "ea",
  lf: "lf", "linear feet": "lf", "linear foot": "lf", "lin ft": "lf", ft: "lf", feet: "lf", foot: "lf",
  sf: "sf", "square feet": "sf", "square foot": "sf", sqft: "sf", "sq ft": "sf",
  cy: "cy", "cubic yard": "cy", "cubic yards": "cy",
  bf: "bf", "board feet": "bf", "board foot": "bf",
};
export function unitKey(value: unknown) {
  const raw = squash(value).replace(/\.$/, "");
  if (!raw) return "";
  return UNIT_ALIASES[raw] || raw;
}

/* What a number counts, in the four kinds the contract distinguishes. An
   empty value is not "members" — it is unstated, and unstated is not
   agreement with anything. */
const SCOPES = new Set(["members", "labels", "zones", "assemblies", "none"]);
const scopeKey = (value: unknown) => (SCOPES.has(squash(value)) ? squash(value) : "");

function positionKey(section: string, category: string, mark: string, level: string, location: string) {
  return [section, squash(category), markKey(mark), squash(level), squash(location)].join("|");
}

/* Every row of one reading that a comparison can line up: the structural
   members, the scheduled components, and the printed rules. Walls, decks,
   spaces and phases are compared by their own counts elsewhere; these three
   are where marks, sizes, quantities and units live. */
export function positionsOf(analysis: Record<string, any>): Position[] {
  const positions: Position[] = [];
  const rows = (name: string) => (Array.isArray(analysis?.[name]) ? analysis[name] : []);

  for (const row of rows("structural_members")) {
    positions.push({
      section: "structural_members",
      key: positionKey("structural_members", row.member_type, row.mark, row.level, row.location),
      mark: text(row.mark),
      category: text(row.member_type),
      level: text(row.level),
      location: text(row.location),
      description: text(row.description),
      size: text(row.size),
      spacing: text(row.spacing),
      unit: text(row.unit),
      counted: scopeKey(row.counted),
      plies: integer(row.plies),
      size_basis: text(row.size_basis),
      count: integer(row.count_proposed),
      count_scheduled: integer(row.count_scheduled),
      count_drawn: integer(row.count_drawn),
      count_confidence: text(row.count_confidence),
      count_note: text(row.count_note),
      sources: (Array.isArray(row.source_refs) ? row.source_refs : []).map(text).filter(Boolean),
    });
  }

  for (const row of rows("component_schedules")) {
    positions.push({
      section: "component_schedules",
      key: positionKey("component_schedules", row.category, row.mark, "", ""),
      mark: text(row.mark),
      category: text(row.category),
      level: "",
      location: "",
      description: text(row.description),
      size: "",
      spacing: "",
      unit: text(row.unit),
      counted: "",
      plies: null,
      size_basis: "",
      count: integer(row.count_proposed),
      count_scheduled: integer(row.count_scheduled),
      count_drawn: integer(row.count_drawn),
      count_confidence: text(row.count_confidence),
      count_note: text(row.count_note),
      sources: (Array.isArray(row.source_refs) ? row.source_refs : []).map(text).filter(Boolean),
    });
  }

  /* A printed rule is a requirement read out of the notes. Its identity is
     what it applies to, not its wording — three readers will phrase the same
     rule three ways and mean one requirement. */
  for (const row of rows("framing_defaults")) {
    positions.push({
      section: "framing_defaults",
      key: positionKey("framing_defaults", row.kind, row.applies_to || row.rule, "", ""),
      mark: text(row.applies_to) || text(row.rule).slice(0, 60),
      category: text(row.kind),
      level: "",
      location: "",
      description: text(row.rule),
      size: "",
      spacing: "",
      unit: "",
      counted: "",
      plies: null,
      size_basis: "",
      count: null,
      count_scheduled: null,
      count_drawn: null,
      count_confidence: "",
      count_note: text(row.exception),
      sources: (Array.isArray(row.source_refs) ? row.source_refs : []).map(text).filter(Boolean),
    });
  }

  return positions;
}

export type ComparisonRow = {
  key: string;
  section: string;
  mark: string;
  category: string;
  level: string;
  location: string;
  /* One entry per reader that has this position, by blind label. */
  readings: Record<string, Position>;
  present: string[];
  missing: string[];
  agreement: "all" | "majority" | "single";
  /* What differs between the readers that do have it. */
  differences: string[];
  /* Named problems, each one a thing a person can go and look at. */
  flags: string[];
};

/* Two readers reporting 12 of a mark agree on a number. Whether they agree
   on anything else — the size, the unit, what the number counts — is a
   separate question, and this is where it is asked. */
function differencesAcross(entries: Position[]) {
  const differences: string[] = [];
  const distinct = (pick: (item: Position) => string) =>
    new Set(entries.map(pick).filter((value) => value !== "")).size > 1;

  const counts = new Set(entries.map((entry) => entry.count).filter((value) => value !== null));
  if (counts.size > 1) differences.push("count");
  if (distinct((entry) => unitKey(entry.unit))) differences.push("unit");
  if (distinct((entry) => squash(entry.size))) differences.push("size");
  if (distinct((entry) => squash(entry.spacing))) differences.push("spacing");
  if (distinct((entry) => entry.counted)) differences.push("counted");
  if (distinct((entry) => String(entry.plies ?? ""))) differences.push("plies");
  if (distinct((entry) => squash(entry.size_basis))) differences.push("size_basis");
  const sourceSets = entries.map((entry) => entry.sources.map(squash).sort().join(";")).filter(Boolean);
  if (new Set(sourceSets).size > 1) differences.push("sources");
  return differences;
}

function flagsFor(entries: Position[], differences: string[]) {
  const flags: string[] = [];

  /* The error this whole exercise exists to catch: one reader counting the
     framing zones a mark appears in, another counting the members, and both
     writing a number in the same column. */
  const scopes = new Set(entries.map((entry) => entry.counted).filter(Boolean));
  if (scopes.has("zones") && (scopes.has("members") || scopes.has("assemblies"))) flags.push("zone_read_as_member");
  if (scopes.has("labels") && scopes.has("members")) flags.push("label_read_as_member");
  if (scopes.has("assemblies") && scopes.has("members")) flags.push("assembly_read_as_member");

  /* A number in pieces against a number in feet is not a disagreement about
     quantity — it is two different quantities. */
  if (differences.includes("unit") && differences.includes("count")) flags.push("count_in_different_units");

  for (const entry of entries) {
    /* An assembly of two plies is one member made of two boards. A count
       that is exactly the members multiplied by the plies has counted the
       boards and called them members. */
    if (entry.counted === "members" && (entry.plies || 0) > 1 && entry.count !== null && entry.count_drawn !== null
      && entry.count === entry.count_drawn * (entry.plies || 1)) {
      flags.push("boards_counted_as_members");
    }
    /* A proposed number that matches neither the schedule nor the drawing
       and says nothing about why is a number with no source. */
    if (entry.count !== null && entry.count_scheduled !== null && entry.count_drawn !== null
      && entry.count !== entry.count_scheduled && entry.count !== entry.count_drawn && !entry.count_note) {
      flags.push("count_not_reconciled");
    }
    /* A size that came only from a plan label, presented with a confident
       count, is a size nobody has traced to a schedule row. */
    if (entry.size_basis === "not_resolved" && entry.count_confidence === "high") flags.push("confident_count_unresolved_size");
  }

  /* Same mark, same category, different sheets: two schedules, not one
     position — and never to be merged into one row silently. */
  const sheetSets = entries.map((entry) => new Set(entry.sources.map(squash)));
  if (sheetSets.length > 1 && sheetSets.every((set) => set.size)
    && sheetSets.some((set, index) => sheetSets.slice(index + 1).some((other) => ![...set].some((sheet) => other.has(sheet))))) {
    flags.push("same_mark_different_sources");
  }

  return [...new Set(flags)];
}

export type MechanicalReport = {
  rows: ComparisonRow[];
  sections: Array<{
    section: string;
    positions: number;
    all_three: number;
    majority: number;
    single_reader: number;
    count_differences: number;
    unit_differences: number;
    scope_flags: number;
    by_reading: Record<string, { positions: number; only_here: number; counted_positions: number }>;
  }>;
  summary: {
    positions: number;
    all_three: number;
    majority: number;
    single_reader: number;
    count_differences: number;
    unit_differences: number;
    flagged: number;
  };
  /* Said out loud so nothing downstream can forget it. */
  caveat: string;
};

export function compareReadings(readings: ReadingInput[]): MechanicalReport {
  const byBlind = new Map(readings.map((reading) => [reading.blind, positionsOf(reading.analysis)]));
  const rowsByKey = new Map<string, ComparisonRow>();

  for (const [blind, positions] of byBlind) {
    for (const position of positions) {
      const existing = rowsByKey.get(position.key) || {
        key: position.key,
        section: position.section,
        mark: position.mark,
        category: position.category,
        level: position.level,
        location: position.location,
        readings: {} as Record<string, Position>,
        present: [] as string[],
        missing: [] as string[],
        agreement: "single" as ComparisonRow["agreement"],
        differences: [] as string[],
        flags: [] as string[],
      };
      /* One reader listing a position twice is that reader's own duplicate,
         not a second position: the first row is kept and the duplicate is
         flagged rather than quietly overwriting it. */
      if (existing.readings[blind]) existing.flags.push("duplicate_row_in_one_reading");
      else existing.readings[blind] = position;
      rowsByKey.set(position.key, existing);
    }
  }

  const blinds = readings.map((reading) => reading.blind);
  const rows = [...rowsByKey.values()].map((row) => {
    const present = blinds.filter((blind) => row.readings[blind]);
    const missing = blinds.filter((blind) => !row.readings[blind]);
    const entries = present.map((blind) => row.readings[blind]);
    const differences = entries.length > 1 ? differencesAcross(entries) : [];
    return {
      ...row,
      present,
      missing,
      agreement: present.length === blinds.length ? "all" : present.length > 1 ? "majority" : "single",
      differences,
      flags: [...new Set([...row.flags, ...flagsFor(entries, differences)])],
    } as ComparisonRow;
  }).sort((a, b) => a.section.localeCompare(b.section) || a.mark.localeCompare(b.mark) || a.key.localeCompare(b.key));

  const sectionNames = [...new Set(rows.map((row) => row.section))].sort();
  const sections = sectionNames.map((section) => {
    const inSection = rows.filter((row) => row.section === section);
    const by_reading: Record<string, { positions: number; only_here: number; counted_positions: number }> = {};
    for (const blind of blinds) {
      const mine = inSection.filter((row) => row.readings[blind]);
      by_reading[blind] = {
        positions: mine.length,
        only_here: mine.filter((row) => row.present.length === 1).length,
        counted_positions: mine.filter((row) => row.readings[blind].count !== null).length,
      };
    }
    return {
      section,
      positions: inSection.length,
      all_three: inSection.filter((row) => row.agreement === "all").length,
      majority: inSection.filter((row) => row.agreement === "majority").length,
      single_reader: inSection.filter((row) => row.agreement === "single").length,
      count_differences: inSection.filter((row) => row.differences.includes("count")).length,
      unit_differences: inSection.filter((row) => row.differences.includes("unit")).length,
      scope_flags: inSection.filter((row) => row.flags.some((flag) => /read_as_member|boards_counted/.test(flag))).length,
      by_reading,
    };
  });

  return {
    rows,
    sections,
    summary: {
      positions: rows.length,
      all_three: rows.filter((row) => row.agreement === "all").length,
      majority: rows.filter((row) => row.agreement === "majority").length,
      single_reader: rows.filter((row) => row.agreement === "single").length,
      count_differences: rows.filter((row) => row.differences.includes("count")).length,
      unit_differences: rows.filter((row) => row.differences.includes("unit")).length,
      flagged: rows.filter((row) => row.flags.length).length,
    },
    caveat: "Agreement between readers is not evidence that a reading is right: three readers can miss the same position, and two can make the same mistake. "
      + "Nothing in this pass looked at the drawings.",
  };
}

/* WHAT NONE OF THEM SAW.
 *
 * A control markup is a list of positions read off the real sheets by a
 * person, each with the page it is on. Compared against the three readings
 * it gives the one thing agreement cannot: the positions every reader
 * missed. Entries marked disputed are carried through and reported, and
 * never counted for or against a reader. */
export type TruthEntry = {
  section: string;
  category: string;
  mark: string;
  level?: string;
  location?: string;
  sheet: string;
  page?: number | null;
  count?: number | null;
  counted?: string;
  disputed?: boolean;
  note?: string;
};

export function againstTruth(report: MechanicalReport, entries: TruthEntry[], blinds: string[]) {
  const found = new Map(report.rows.map((row) => [
    [row.section, squash(row.category), markKey(row.mark)].join("|"),
    row,
  ]));
  const checked: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    const row = found.get([entry.section, squash(entry.category), markKey(entry.mark)].join("|")) || null;
    const readers: Record<string, string> = {};
    for (const blind of blinds) {
      const position = row?.readings?.[blind];
      if (!position) readers[blind] = "not read";
      else if (entry.count === null || entry.count === undefined) readers[blind] = "read";
      /* A markup records what was marked — usually the printed labels, with
         their coordinates. A reader that reports members where the markup
         counted labels has not necessarily made a mistake: one line can
         carry two labels, and one label can cover several members. So this
         is reported as a difference in what was counted, and never scored
         as wrong. */
      else if (entry.counted && position.counted && entry.counted !== position.counted) {
        readers[blind] = `counts ${position.counted} where the markup counted ${entry.counted} (${position.count ?? "no count"} against ${entry.count})`;
      } else if (position.count === null) readers[blind] = "read without a count";
      else readers[blind] = position.count === entry.count ? "matches" : `${position.count} against ${entry.count}`;
    }
    checked.push({
      mark: entry.mark,
      section: entry.section,
      category: entry.category,
      sheet: entry.sheet,
      page: entry.page ?? null,
      expected_count: entry.count ?? null,
      expected_counted: entry.counted || "",
      /* A disputed entry is shown and never scored: the reference itself is
         not settled, and settling it with a reader's answer would be
         circular. */
      disputed: Boolean(entry.disputed),
      note: entry.note || "",
      readers,
      missed_by_all: blinds.every((blind) => readers[blind] === "not read"),
    });
  }
  const scorable = checked.filter((item) => !item.disputed);
  return {
    entries: checked,
    coverage: {
      entries_total: checked.length,
      entries_scored: scorable.length,
      entries_disputed: checked.length - scorable.length,
      /* Counted over the entries that can be scored. A disputed entry every
         reader missed is still worth showing, but it is not a miss anyone
         can be held to — the reference itself is not settled. */
      missed_by_all: scorable.filter((item) => item.missed_by_all).length,
      missed_by_all_disputed: checked.filter((item) => item.disputed && item.missed_by_all).length,
    },
    per_reading: Object.fromEntries(blinds.map((blind) => [blind, {
      matches: scorable.filter((item) => (item.readers as Record<string, string>)[blind] === "matches").length,
      read_without_count: scorable.filter((item) => (item.readers as Record<string, string>)[blind] === "read without a count").length,
      not_read: scorable.filter((item) => (item.readers as Record<string, string>)[blind] === "not read").length,
      /* Only a like-for-like number that does not match is wrong. */
      wrong: scorable.filter((item) => /^\d+ against /.test((item.readers as Record<string, string>)[blind] || "")).length,
      /* Counted something else — reported for a person to look at, never
         scored for or against a reader. */
      scope_differs: scorable.filter((item) => /^counts /.test((item.readers as Record<string, string>)[blind] || "")).length,
    }])),
  };
}

/* CONDITIONS.
 *
 * Two readings are comparable when they read the same pages, at the same
 * enlargement budget, under the same task. Anything else is a comparison of
 * circumstances wearing the clothes of a comparison of readers, and this
 * says so rather than letting a winner be declared. */
export type ReadingConditions = {
  id: string;
  provider: string;
  model: string;
  version: number;
  source_document_ids: string[];
  agent_contract_version: string;
  image_budget: number | null;
  state: string;
};

export function conditionsVerdict(readings: ReadingConditions[]) {
  const differences: string[] = [];
  const sameSet = (a: string[], b: string[]) =>
    a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
  const first = readings[0];
  if (!first) return { comparable: false, differences: ["no readings"], detail: [] };

  if (!readings.every((reading) => sameSet(reading.source_document_ids || [], first.source_document_ids || []))) {
    differences.push("different plan documents");
  }
  if (new Set(readings.map((reading) => reading.agent_contract_version || "")).size > 1) {
    differences.push("different task versions");
  }
  if (new Set(readings.map((reading) => String(reading.image_budget ?? ""))).size > 1) {
    differences.push("different enlargement budgets");
  }
  if (new Set(readings.map((reading) => reading.provider || "")).size !== readings.length) {
    differences.push("two of these readings came from the same reader");
  }
  return {
    comparable: differences.length === 0,
    differences,
    detail: readings.map((reading) => ({
      id: reading.id,
      provider: reading.provider,
      model: reading.model,
      version: reading.version,
      documents: (reading.source_document_ids || []).length,
      agent_contract_version: reading.agent_contract_version,
      image_budget: reading.image_budget,
    })),
  };
}

/* A VERDICT IS ONLY AS GOOD AS ITS EVIDENCE.
 *
 * The checker is asked for marks behind every quantity verdict. Where it did
 * not give them, this downgrades the finding rather than trusting it — the
 * one place where the application overrules the model, and it overrules it
 * only towards "could not verify", never towards a stronger claim. */
export function sanitiseVerdict(verdict: Record<string, any>) {
  const downgraded: string[] = [];
  const findings = (Array.isArray(verdict?.findings) ? verdict.findings : []).map((finding: Record<string, any>) => {
    const marks = Array.isArray(finding?.evidence?.marks) ? finding.evidence.marks : [];
    const hasPlace = Boolean(text(finding?.evidence?.sheet) || text(finding?.evidence?.tile));
    if (finding?.verdict !== "could_not_verify" && !hasPlace) {
      downgraded.push(`${finding?.mark || "a finding"}: no place on a sheet was named`);
      return { ...finding, verdict: "could_not_verify", why: `${finding?.why || ""} (no place on a sheet was named, so this was not accepted as checked)`.trim() };
    }
    if (finding?.kind === "quantity" && finding?.verdict !== "could_not_verify" && marks.length === 0) {
      downgraded.push(`${finding?.mark || "a quantity"}: a count was judged without identifying the marks counted`);
      return { ...finding, verdict: "could_not_verify", why: `${finding?.why || ""} (a sheet reference alone does not establish a count, so this was not accepted as checked)`.trim() };
    }
    return finding;
  });
  return { verdict: { ...verdict, findings }, downgraded };
}

/* WHO IS RECOMMENDED, COUNTED BY THIS APPLICATION.
 *
 * The checker gives its own recommendation. This recounts it from the
 * findings that survived the evidence rule, so a recommendation can never
 * rest on findings the application itself refused to accept — and so nobody
 * wins for writing more rows. */
export function tallyFindings(verdict: Record<string, any>, blinds: string[]) {
  const tally: Record<string, { verified: number; wrong: number; could_not_verify: number }> = {};
  for (const blind of blinds) tally[blind] = { verified: 0, wrong: 0, could_not_verify: 0 };
  for (const finding of (Array.isArray(verdict?.findings) ? verdict.findings : [])) {
    const reader = text(finding?.reader);
    const bucket = tally[reader];
    if (!bucket) continue;
    if (finding.verdict === "verified") bucket.verified += 1;
    else if (finding.verdict === "wrong") bucket.wrong += 1;
    else bucket.could_not_verify += 1;
  }
  const scored = blinds.map((blind) => ({ blind, ...tally[blind], net: tally[blind].verified - tally[blind].wrong }));
  const ranked = [...scored].sort((a, b) => b.net - a.net);
  const decided = ranked.length > 1 && ranked[0].net > ranked[1].net
    && (ranked[0].verified + ranked[0].wrong) > 0;
  return {
    per_reader: tally,
    /* No winner is a real result. It is given whenever the checked findings
       do not separate the readers, whatever the checker itself concluded. */
    leader: decided ? ranked[0].blind : null,
    reason: decided
      ? "counted from the findings that named a place on a sheet, and — for quantities — the marks counted"
      : "the checked findings do not separate the readers",
  };
}
