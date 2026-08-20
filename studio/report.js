/* Measured Decision · client report.

   The report is the product. A client does not open the Studio, does not click
   through spaces, and does not know which sentence came from a model and which
   from a person — so the document has to carry that distinction on its face,
   and answer the five questions in the order a reader asks them: what is on
   record, what each space actually shows, what changed, and what decision is
   waiting.

   It opens as its own page so it can be printed or saved as PDF and sent on.
   Nothing here invents content: every line comes from the record, and a space
   with no interpretation says exactly that.

   window.MDAIReport.open(model)
*/
(() => {
  const STATUS = {
    confirmed: { label: "Confirmed by a person", tone: "ok" },
    review: { label: "AI suggestion · not verified", tone: "review" },
    not_interpreted: { label: "Not interpreted", tone: "wait" },
  };

  function escapeText(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function list(items, empty) {
    if (!items?.length) return `<p class="muted">${escapeText(empty)}</p>`;
    return `<ul>${items.map((text) => `<li>${escapeText(text)}</li>`).join("")}</ul>`;
  }

  const STYLE = `
    :root{color-scheme:light}
    *{box-sizing:border-box}
    body{margin:0;padding:48px 24px 72px;background:#f4f6f8;color:#12212f;
      font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Arial,sans-serif}
    .sheet{max-width:840px;margin:0 auto;background:#fff;padding:56px;border-radius:14px;
      box-shadow:0 18px 48px rgba(16,32,48,.12)}
    header.doc{border-bottom:2px solid #12212f;padding-bottom:24px;margin-bottom:32px}
    .brand{display:flex;align-items:center;gap:10px;color:#0f7d8c;font-weight:700;letter-spacing:.14em;
      text-transform:uppercase;font-size:11px}
    .brand i{width:11px;height:11px;border-radius:50%;background:#0f7d8c;display:inline-block}
    h1{margin:14px 0 6px;font-size:34px;line-height:1.15}
    .subtitle{margin:0;color:#4a6076;font-size:15px}
    .meta{margin-top:18px;display:flex;flex-wrap:wrap;gap:8px 28px;color:#4a6076;font-size:13px}
    h2{margin:40px 0 14px;font-size:20px;border-bottom:1px solid #d9e2ea;padding-bottom:8px}
    h3{margin:0 0 4px;font-size:17px}
    p{margin:0 0 10px}
    ul{margin:6px 0 12px;padding-left:20px}
    li{margin:3px 0}
    .muted{color:#68809a;font-size:14px}
    .note{border-left:3px solid #0f7d8c;background:#eef7f9;padding:14px 18px;border-radius:0 8px 8px 0;
      font-size:14px;color:#28414f}
    .metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0 8px}
    .metrics article{border:1px solid #d9e2ea;border-radius:10px;padding:14px}
    table.ledger{width:100%;border-collapse:collapse;margin:8px 0 10px;font-size:13px}
    table.ledger td{border-bottom:1px solid #e6edf2;padding:7px 8px;vertical-align:top}
    table.ledger td.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
    table.ledger td b{color:#8a5a10}
    .metrics strong{display:block;font-size:26px;line-height:1.1}
    .metrics small{display:block;margin-top:4px;color:#4a6076;font-size:12px}
    .space{border:1px solid #d9e2ea;border-radius:12px;padding:20px 22px;margin:14px 0;break-inside:avoid}
    .space header{display:flex;justify-content:space-between;align-items:baseline;gap:16px;margin-bottom:10px}
    .chip{white-space:nowrap;font-size:12px;font-weight:600;padding:4px 10px;border-radius:999px;border:1px solid}
    .chip.ok{color:#0d6b4f;border-color:#9fd7c2;background:#eaf7f1}
    .chip.review{color:#8a5a10;border-color:#f0cf9a;background:#fdf5e7}
    .chip.wait{color:#54687d;border-color:#d3dde6;background:#f2f5f8}
    .space .where{color:#68809a;font-size:13px;margin:-6px 0 10px}
    .group{margin-top:12px}
    .group h4{margin:0 0 4px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#4a6076}
    .thumbs{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
    .thumbs img{width:104px;height:74px;object-fit:cover;border-radius:6px;border:1px solid #d9e2ea}
    .entry{border:1px solid #d9e2ea;border-radius:10px;padding:14px 16px;margin:10px 0;break-inside:avoid}
    .entry h3{font-size:15px}
    .decision{border:2px solid #0f7d8c;border-radius:12px;padding:22px 24px;margin:16px 0}
    .decision .eyebrow{margin:0 0 6px;color:#0f7d8c;font-size:11px;letter-spacing:.14em;text-transform:uppercase;font-weight:700}
    a{color:#0f7d8c}
    footer.doc{margin-top:44px;padding-top:18px;border-top:1px solid #d9e2ea;color:#68809a;font-size:12px}
    .print{position:fixed;right:24px;top:24px;padding:12px 20px;border:0;border-radius:10px;background:#12212f;
      color:#fff;font:inherit;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 8px 20px rgba(16,32,48,.25)}
    @media(max-width:720px){
      body{padding:16px 10px 40px}
      .sheet{padding:24px 18px}
      h1{font-size:26px}
      .metrics{grid-template-columns:repeat(2,1fr)}
      .print{position:static;width:100%;margin-bottom:16px}
    }
    @media print{
      @page{margin:14mm}
      body{padding:0;background:#fff}
      .sheet{box-shadow:none;padding:0;max-width:none}
      .print{display:none}
      a{text-decoration:none}
    }
  `;

  function spaceBlock(space) {
    const status = STATUS[space.status] || STATUS.not_interpreted;
    const captures = (space.capture_requests || []).map((entry) =>
      entry.reason ? `${entry.request} — ${entry.reason}` : entry.request,
    );
    return `
      <article class="space">
        <header>
          <h3>${escapeText(space.name)}</h3>
          <span class="chip ${status.tone}">${escapeText(status.label)}</span>
        </header>
        ${space.location ? `<p class="where">${escapeText(space.location)}</p>` : ""}
        <p>${escapeText(space.summary)}</p>
        ${space.status === "not_interpreted" ? "" : `
          <div class="group"><h4>Visible in the evidence</h4>${list(space.visible, "Nothing was recorded as visible.")}</div>
          <div class="group"><h4>Not established</h4>${list(space.unknown, "No open questions were recorded.")}</div>`}
        ${captures.length ? `<div class="group"><h4>Capture requested</h4>${list(captures, "")}</div>` : ""}
        ${space.change
          ? `<div class="group"><h4>Compared with ${escapeText(space.change.earlier_label)}</h4>
              <p>${escapeText(space.change.headline)} — AI suggestion, not verified.</p>
              ${list(space.change.appeared.map((entry) => entry.text), "Nothing new is visible in the later capture.")}
              ${space.change.gone.length
                ? `<h4>No longer in view</h4>${list(space.change.gone.map((entry) => entry.text), "")}<p class="muted">A thing can leave the frame without leaving the room. These are questions, not removals.</p>`
                : ""}
              ${space.change.reliability_note ? `<p class="muted">${escapeText(space.change.reliability_note)}</p>` : ""}
             </div>`
          : ""}
        ${space.markers?.length
          ? `<div class="group"><h4>Marked in the 360 record</h4>${list(
              space.markers.map((marker) =>
                [marker.label, marker.at ? `at ${marker.at}` : "", `— ${marker.state}`].filter(Boolean).join(" "),
              ),
              "",
            )}</div>`
          : ""}
        ${space.document_requests?.length
          ? `<div class="group"><h4>Waiting on a document</h4>${list(space.document_requests, "")}</div>`
          : ""}
        ${space.note ? `<div class="group"><h4>Verified by a person</h4><p>${escapeText(space.note)}</p></div>` : ""}
        <p class="muted">${escapeText(space.files_line)}${space.trim_note ? ` · ${escapeText(space.trim_note)}` : ""}</p>
        ${space.spatial_link ? `<p><a href="${escapeText(space.spatial_link)}">Open the 360 record of this space &rarr;</a></p>` : ""}
        ${space.thumbnails?.length
          ? `<div class="thumbs">${space.thumbnails.map((src) => `<img src="${escapeText(src)}" alt="">`).join("")}</div>`
          : ""}
      </article>`;
  }

  function documentHtml(model) {
    const metrics = [
      { value: model.summary.originals, label: "Original files preserved" },
      { value: model.summary.spaces, label: "Spaces with evidence" },
      { value: model.summary.interpreted, label: "Interpreted by AI" },
      { value: model.summary.confirmed, label: "Confirmed by a person" },
    ];
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeText(model.project.name)} · evidence report</title>
<style>${STYLE}</style></head>
<body>
<button class="print" type="button" onclick="window.print()">Print or save as PDF</button>
<div class="sheet">
  <header class="doc">
    <div class="brand"><i></i> Measured Decision · evidence report</div>
    <h1>${escapeText(model.project.name)}</h1>
    <p class="subtitle">${escapeText(model.headline)}</p>
    <div class="meta">
      <span>Prepared ${escapeText(model.project.prepared_at)}</span>
      ${model.project.prepared_by ? `<span>By ${escapeText(model.project.prepared_by)}</span>` : ""}
      <span>Last evidence ${escapeText(model.project.last_evidence)}</span>
    </div>
  </header>

  <p class="note"><strong>How to read this.</strong> A line marked <em>AI suggestion</em> is what a model saw in the
  supplied files — it is not a fact and no decision should rest on it alone. A space marked <em>confirmed</em> was
  reviewed by a person, and that is what counts as record. Original files are never altered or re-encoded; where a
  360 capture is shown, the first and last seconds are hidden because they record the operator entering and leaving,
  not the space.</p>

  <h2>What is on record</h2>
  <div class="metrics">
    ${metrics.map((metric) => `<article><strong>${escapeText(metric.value)}</strong><small>${escapeText(metric.label)}</small></article>`).join("")}
  </div>
  ${model.vr.count
    ? `<p>${escapeText(model.vr.count)} capture${model.vr.count === 1 ? " is" : "s are"} playable as a full sphere${model.vr.link ? ` — <a href="${escapeText(model.vr.link)}">open the spatial record</a>` : ""}. The same link opens in a headset.</p>`
    : `<p class="muted">This project holds no 360 capture that a browser or headset can play yet.</p>`}

  <h2>What each space shows</h2>
  ${model.spaces.length ? model.spaces.map(spaceBlock).join("") : `<p class="muted">No space holds evidence yet.</p>`}

  <h2>What changed</h2>
  ${model.changed.length
    ? model.changed.map((entry) => `<article class="entry"><h3>${escapeText(entry.title)}</h3><p>${escapeText(entry.copy)}</p></article>`).join("")
    : `<p class="muted">Nothing has changed since the previous round.</p>`}

  ${model.money?.trades?.length
    ? `<h2>Work and money</h2>
       <p>${escapeText(model.money.headline)}</p>
       <table class="ledger"><tbody>${model.money.trades
         .filter((trade) => trade.billable || trade.has_amount)
         .map(
           (trade) => `<tr>
             <td>${escapeText(trade.label)}<br><span class="muted">${
               trade.evidence_count
                 ? `${trade.evidence_count} seen in ${escapeText(trade.spaces.join(", "))}`
                 : "nothing in the capture record shows this work"
             }</span></td>
             <td class="num">${
               trade.state === "no_evidence"
                 ? `${escapeText(trade.amount_label)}<br><b>not visible</b>`
                 : trade.has_amount
                   ? escapeText(trade.amount_label)
                   : "<span class='muted'>no cost recorded</span>"
             }</td>
           </tr>`,
         )
         .join("")}</tbody></table>
       <p class="muted">Money is entered by a person. The AI never reads an amount and never decides which invoice belongs to which work. An empty cost is a question the project is still asking, not a zero.</p>`
    : ""}

  <h2>What needs a decision</h2>
  <div class="decision">
    <p class="eyebrow">Next action</p>
    <h3>${escapeText(model.next.title)}</h3>
    <p>${escapeText(model.next.copy)}</p>
    ${model.next.owner ? `<p class="muted">Who does it: ${escapeText(model.next.owner)}</p>` : ""}
  </div>
  <div class="group"><h4>Open questions the evidence does not answer</h4>
    ${list(model.open_questions, "The record leaves no question open.")}</div>
  <div class="group"><h4>Captures requested</h4>
    ${list(model.capture_requests, "No further capture has been requested.")}</div>
  <div class="group"><h4>Documents requested</h4>
    ${list(
      model.document_requests || [],
      "Every marked installation is either covered by a document or has not been checked against one yet.",
    )}</div>

  <footer class="doc">
    Every statement above is traceable to a file in this project. Links to individual files expire for security; the
    project itself stays available at ${escapeText(model.project.studio_url)}.
  </footer>
</div>
</body></html>`;
  }

  function open(model) {
    const page = window.open("", "_blank");
    if (!page) return false;
    page.document.write(documentHtml(model));
    page.document.close();
    page.document.title = `${model.project.name} · evidence report`;
    return true;
  }

  window.MDAIReport = { open, documentHtml };
})();
