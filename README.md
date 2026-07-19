# Measured Decision AI

Official static website for [MeasuredDecision.com](https://measureddecision.com).

## Current product foundations

- [WalletWCCM](https://walletwccm.com) — closing-cost and cash-to-close clarity
- [GRCRM](https://grcrm.com) — lead and workflow continuity

## The Living Property

The homepage hero presents the company's spatial-intelligence direction: physical property → evidence → context → human decision. The lightweight muted video uses blended scene transitions and a seamless loop inside the integrated diagonal hero composition, with a pause/play control.

## Film Center

The compact Film Center restores four avatar-led films in one selectable player:

1. The Measured Decision Vision
2. Every Dollar Should Have an Evidence Path
3. Every Property Should Have a Living Record
4. From Documents to Spatial Intelligence

Each film includes an optional English CC track that is off by default.

## Method

Mortgage data → deterministic calculations → AI-assisted explanation → human review.

## Vision chapters

The site includes four illustrated chapters explaining the company's direction:

1. Our Vision
2. Financial Intelligence
3. Property & Spatial Intelligence
4. Technology & Human Review

Spatial imagery is explicitly presented as concept exploration, not released product functionality.

## Local preview

Run a static server from the repository root, for example:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Netlify media assembly

When deploying from GitHub, Netlify runs `scripts/assemble-media.sh` to reconstruct
the original MP4 files from repository-safe binary parts before publishing. This
keeps the full-quality media in source control without relying on Git LFS.
