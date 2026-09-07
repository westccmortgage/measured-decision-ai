# Control tasks

The kit is the same for every provider: S-2 (page 24, foundation), S-3 (page 25,
first-floor walls and second-floor framing), S-4 (page 26, second-floor walls
and roof), the general notes and schedules on those sheets, plus the
architectural pages a task names. Every task is answered in the one result
format (`result-schema.json`). An unknown quantity is an empty field, never 0.

## A — Beam and header types

Extract every FB1–FB11 and HDR1–HDR4 row: mark, material, section, make-up
(single, or how many plies of what), and every detail reference the schedule
prints. Source: the schedules on S-3 (page 25) and any detail sheet they cite.

Correct answer contains: 15 rows, each `method: printed`, each with sheet and
schedule location. HDR4 is present (PSL 2.0E 3½ × 18) even if no instance is
found on the plans. A row with an uncertain ply count says so in `unresolved`.

## B — Count members on the marked areas of S-3

For the areas named in `ground-truth.json` (task B), count the individual
members of each mark. Every counted member is placed on the plan: the answer
gives, per member, the enlargement name and the pixel position of the label
(from the kit's coordinate frame) so misses and double counts can be checked
one by one.

Correct answer contains: per mark, `counted: member`, one placed entry per
member, and `unresolved` naming labels the model could not place. The count
is compared with the marked-up ground truth; a count without placements
scores as unverifiable.

## C — Roof of S-4

Ridge beams, hip beams, roof headers (RHDR), rafters. For each: the number
of places it is applied, the number of assemblies, and the number of
constituent pieces where the schedule prints the make-up. R.R.1 is a zone
(2×10 #2 @ 16" O.C.); the number of R.R.1 zones is not a number of rafters.
RIDGE BM2 is an assembly, (2)-2×10 #2, and its plan callouts are read with
the detail they cite.

Correct answer contains: separate numbers for places, assemblies, pieces;
`counted` says which; an unnumbered RHDR label is not assigned to RHDR1
without a printed rule that says so.

## D — Footings F1–F4

Extract the footing schedule (size, depth, reinforcement) from S-2, then check
each type's placement on the foundation plan. A schedule row is not evidence
that the type exists on the plan: a type with no placement found is reported
with an empty quantity and `unresolved: "no instance placed"`.

Correct answer contains: 4 schedule rows with reinforcement verbatim, per
type a placed count or an explicit empty.

## E — Material requirements from the notes

From the general notes on S-3/S-4 (and S-1 where they cite it): studs,
sheathing (floor, roof, exterior wall), blocking, connectors and fasteners,
double joists under parallel walls. Each requirement is a row with its
exception clause (U.N.O., "see plan") verbatim, and an empty quantity where
none is printed.

Correct answer contains: the rows in `ground-truth.json` task E, each
`method: printed`, with sheet and note number; no invented quantities.

## Rules that apply to every task

- Difficulty reading the image is an internal check (`unresolved`), never an
  RFI. An RFI is proposed only where the design itself is ambiguous.
- Purchase lengths, waste and packaging are separate from project quantity
  and are not asked for here.
- A general HDR/RHDR label is never turned into a numbered mark without a
  printed basis.
