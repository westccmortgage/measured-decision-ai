/* Measured Decision · what work is this, in the units money arrives in.

   A ledger with one line per outlet is a ledger nobody can pay from. Invoices
   are not written that way: one covers the rough electrical for a whole house,
   another covers every window in it. Asking "how much was this outlet" has no
   answer anywhere in the world.

   So money attaches to the trade, and evidence attaches to the thing. An outlet
   is not a line item — it is proof that rough electrical progressed. This file
   is the join between the two, and it is deliberately a dictionary rather than
   a model: a person can read why a line landed where it did, and move it. An
   AI guess about which trade owes money is not something anyone should have to
   argue with.

   window.MDAITrades360.classify(text) -> { trade, confidence, matched }
   window.MDAITrades360.TRADES -> the buckets, in the order work happens
*/
(() => {
  /* Ordered the way a building actually goes up, so the list on screen reads
     like the job rather than like an alphabet. */
  const TRADES = [
    { key: "sitework", label: "Site work and excavation", words: ["excavat", "grading", "trench", "backfill", "site prep", "earthwork", "shoring"] },
    { key: "foundation", label: "Foundation and concrete", words: ["foundation", "footing", "slab", "concrete", "rebar", "stem wall", "pour", "form work", "formwork"] },
    { key: "framing", label: "Framing", words: ["framing", "framed", "stud", "joist", "rafter", "truss", "sheathing", "header", "beam", "post", "subfloor", "lumber"] },
    { key: "roofing", label: "Roofing", words: ["roof", "shingle", "underlayment", "flashing", "gutter", "downspout", "ridge", "eave", "fascia", "soffit"] },
    { key: "windows_doors", label: "Windows and exterior doors", words: ["window", "glazing", "glazed", "sliding door", "exterior door", "patio door", "skylight", "sill", "jamb"] },
    { key: "rough_electrical", label: "Rough electrical", words: ["electrical", "wiring", "wire", "conduit", "romex", "outlet", "receptacle", "switch box", "junction box", "panel", "subpanel", "breaker", "enclosure", "cable run", "low voltage", "recessed can"] },
    { key: "rough_plumbing", label: "Rough plumbing", words: ["plumbing", "pipe", "piping", "pex", "abs", "drain", "waste", "vent", "supply line", "water heater", "valve", "hose bib", "trap", "cleanout"] },
    { key: "hvac", label: "HVAC", words: ["hvac", "duct", "ductwork", "register", "air handler", "furnace", "condenser", "mini split", "mini-split", "return air", "flue", "thermostat", "air conditioning"] },
    { key: "insulation", label: "Insulation", words: ["insulation", "insulated", "batt", "blown-in", "spray foam", "vapor barrier", "vapour barrier", "air seal"] },
    { key: "drywall", label: "Drywall and plaster", words: ["drywall", "sheetrock", "gypsum", "taping", "mud", "plaster", "skim coat", "corner bead"] },
    { key: "interior_finish", label: "Interior finish carpentry", words: ["trim", "baseboard", "casing", "crown", "interior door", "closet shelving", "stair", "handrail", "railing", "millwork"] },
    { key: "flooring", label: "Flooring", words: ["flooring", "floor finish", "tile", "hardwood", "laminate", "vinyl plank", "carpet", "underlayment floor", "grout"] },
    { key: "cabinets", label: "Cabinets and countertops", words: ["cabinet", "countertop", "counter top", "vanity", "backsplash", "island"] },
    { key: "painting", label: "Painting and coatings", words: ["paint", "painted", "primer", "primed", "sealer", "stain", "coating"] },
    { key: "exterior_finish", label: "Exterior finish", words: ["siding", "stucco", "render", "brick", "masonry", "cladding", "deck", "porch", "railing exterior"] },
    { key: "fixtures", label: "Fixtures and appliances", words: ["fixture", "light fixture", "sink", "faucet", "toilet", "tub", "shower", "appliance", "range", "dishwasher", "ceiling fan"] },
    { key: "site_finish", label: "Landscaping and site finish", words: ["landscap", "paving", "driveway", "walkway", "fence", "irrigation", "planting"] },
    { key: "condition", label: "Site condition, not billable work", words: ["debris", "loose material", "stored material", "clutter", "dust", "water stain", "damage", "unfinished"] },
  ];

  const BY_KEY = new Map(TRADES.map((trade) => [trade.key, trade]));
  const UNASSIGNED = { key: "unassigned", label: "Not assigned to a trade" };

  function label(key) {
    return (BY_KEY.get(key) || UNASSIGNED).label;
  }

  /* Longest phrase wins, because "exterior door" is a window-and-door line and
     "door" alone could be interior trim. Two trades matching equally means the
     line is ambiguous and says so rather than picking one. */
  function classify(text) {
    const haystack = ` ${String(text || "").toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ")} `;
    const hits = [];
    TRADES.forEach((trade) => {
      let best = "";
      trade.words.forEach((word) => {
        if (haystack.includes(` ${word}`) && word.length > best.length) best = word;
      });
      if (best) hits.push({ trade, word: best });
    });
    if (!hits.length) return { trade: UNASSIGNED.key, label: UNASSIGNED.label, confidence: 0, matched: "" };
    hits.sort((a, b) => b.word.length - a.word.length);
    const top = hits[0];
    const tie = hits[1] && hits[1].word.length === top.word.length;
    return {
      trade: top.trade.key,
      label: top.trade.label,
      /* A long, specific phrase is a strong signal; a single common word is a
         suggestion. Either way a person can move the line. */
      confidence: tie ? 0.4 : Math.min(1, 0.45 + top.word.length / 22),
      matched: top.word,
      alternatives: hits.slice(1, 3).map((hit) => hit.trade.key),
    };
  }

  /* Work that is not work: debris and unfinished surfaces are evidence about
     the state of the site, and nobody invoices for them. Keeping them out of
     the money questions is what keeps the list of questions short. */
  function billable(key) {
    return key !== "condition" && key !== UNASSIGNED.key;
  }

  window.MDAITrades360 = { TRADES, UNASSIGNED, classify, label, billable };
})();
