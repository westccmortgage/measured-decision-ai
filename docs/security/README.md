# Security documentation

Six pages describing what Measured Decision actually does today, and what it
does not do yet. Everything here is written to be read by an engineer joining
the project or a customer's security reviewer asking a direct question.

| Page | Answers |
|---|---|
| [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md) | What the system is made of and where the trust boundaries are |
| [ACCESS_CONTROL.md](ACCESS_CONTROL.md) | Who can reach what, and where that is enforced |
| [EVIDENCE_PROVENANCE.md](EVIDENCE_PROVENANCE.md) | How the chain from camera to decision is kept |
| [DATA_RETENTION.md](DATA_RETENTION.md) | What deletion means, what survives it, and what is backed up |
| [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md) | What to do when something goes wrong |
| [THIRD_PARTY_SERVICES.md](THIRD_PARTY_SERVICES.md) | Which outside services hold customer data |

**Status marks used throughout**

- **Implemented** — in the code today; the file and line are named.
- **Partial** — some of it works; the gap is stated.
- **Planned** — not built. Named so it is not mistaken for something that is.

## One rule about claims

Measured Decision has not completed a SOC 2, ISO 27001, HIPAA or FedRAMP audit.
Nothing in this repository, on the website, or in any customer-facing material
may say or imply otherwise. "Designed with SOC 2 in mind" is true and is the
strongest thing that may be said. Everything else waits for an auditor.

## When a /security page is written

No such page exists yet. The site is static, so adding one is a directory and an
HTML file — there is no architecture to prepare beyond deciding, in advance,
what it is allowed to say. That decision is here so it is not made under
deadline by whoever is writing marketing copy.

**May be said, because each is true and this repository shows where:**

- Security-conscious architecture, built for evidence rather than retrofitted
- Encryption in transit, and at rest where the platform provides it
- Project access controlled server-side, never by the browser
- Evidence provenance: who, when, which project, which original, what changed
- An append-only audit trail that no one can edit, including us
- Every AI conclusion traceable to the files and the model run that produced it
- A human decision is always separate from an AI interpretation
- Enterprise security roadmap, with named gaps

**May not be said, under any wording:**

- SOC 2 compliant · SOC 2 certified · SOC 2 Type I or Type II
- ISO 27001 certified · HIPAA compliant · FedRAMP · PCI DSS
- "Bank-grade" or "military-grade" anything
- Any statement that a control is in place when this documentation marks it
  *Planned*

If a claim on that page cannot be traced to a file in this repository, it does
not go on the page.
