#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parents[1]
index_path = root / "index.html"
html = index_path.read_text(encoding="utf-8")

html = html.replace('<a href="#company">Company</a>', '<a href="/team/">Our Team</a>')

replacement = '''      <section class="section company-section v3-company-section" id="company">
        <div class="company-statement">
          <p class="eyebrow">Our Team</p>
          <h2>Domain experience inside the problem.</h2>
        </div>
        <div class="company-copy">
          <p>Measured Decision AI brings together practical experience across mortgage finance, real estate, construction, legal, and digital strategy.</p>
          <p>The full team page includes the founder introduction and the independent specialist network contributing domain perspective to the company.</p>
          <a class="button button-secondary" href="/team/">Meet the team <span>→</span></a>
        </div>
      </section>

'''

if 'href="/team/">Meet the team' not in html:
    start_marker = '<section class="section company-section v3-company-section" id="company">'
    end_marker = '<section class="contact-section v3-contact-section" id="contact">'
    start = html.find(start_marker)
    end = html.find(end_marker, start)
    if start == -1 or end == -1:
        raise SystemExit("Could not locate the main-page team section")
    line_start = html.rfind("\n", 0, start) + 1
    html = html[:line_start] + replacement + html[end - 6:]

footer_old = '<a href="#responsible">Responsible AI</a><a href="#films">Films</a><a href="/investors/">Investors</a>'
footer_new = '<a href="#responsible">Responsible AI</a><a href="#films">Films</a><a href="/team/">Our Team</a><a href="/investors/">Investors</a>'
if footer_old in html:
    html = html.replace(footer_old, footer_new)
index_path.write_text(html, encoding="utf-8")

investor_path = root / "investors" / "index.html"
if investor_path.exists():
    investor = investor_path.read_text(encoding="utf-8")
    if '<a href="/team/">Team</a>' not in investor:
        investor = investor.replace('<a href="#validation">Validation</a>', '<a href="#validation">Validation</a>\n        <a href="/team/">Team</a>')
    if '<a href="/team/">Our Team</a>' not in investor:
        investor = investor.replace('<a href="/">Company Site</a>', '<a href="/">Company Site</a><a href="/team/">Our Team</a>')
    investor_path.write_text(investor, encoding="utf-8")
