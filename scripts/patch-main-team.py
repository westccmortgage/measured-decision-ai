#!/usr/bin/env python3
from pathlib import Path
import re

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
      </section>'''

pattern = re.compile(
    r'      <section class="section company-section v3-company-section" id="company">.*?      </section>\n\n(?=      <section class="contact-section)',
    re.S,
)
html, count = pattern.subn(replacement + "\n\n", html, count=1)
if count != 1 and 'href="/team/">Meet the team' not in html:
    raise SystemExit("Could not replace the main-page team section")

footer_old = '<a href="#responsible">Responsible AI</a><a href="#films">Films</a><a href="/investors/">Investors</a>'
footer_new = '<a href="#responsible">Responsible AI</a><a href="#films">Films</a><a href="/team/">Our Team</a><a href="/investors/">Investors</a>'
html = html.replace(footer_old, footer_new)
index_path.write_text(html, encoding="utf-8")

investor_path = root / "investors" / "index.html"
if investor_path.exists():
    investor = investor_path.read_text(encoding="utf-8")
    investor = investor.replace('<a href="#validation">Validation</a>', '<a href="#validation">Validation</a>\n        <a href="/team/">Team</a>')
    investor = investor.replace('<a href="/">Main site</a>', '<a href="/">Main site</a><a href="/team/">Our Team</a>')
    investor_path.write_text(investor, encoding="utf-8")
