# Scoring — four results, per task

Results: app v3 (saved reading; the starting point), OpenAI, Claude, Gemini. Each is scored per task A–E on four axes. A model that returns null for every quantity does not win on correctness alone: completeness and verifiability count, and confident-wrong answers are counted separately from misses.

| Axis | What is measured | How |
|---|---|---|
| Correctness | sections, units, mark ↔ size, quantities | per ground-truth fact: correct / wrong / empty; a wrong value stated with `method: printed` or `counted_on_plan` is **confident-wrong** and listed separately |
| Completeness | control items found / missed | count of ground-truth facts present in the result |
| Verifiability | can each row be found and recounted from the source | per row: source location resolves to the sheet and place (yes / no); for B and C, placements present and each placement lands on a label (yes / no) |
| Economics | cost, time, manual fixes | usage-based cost from the run log; wall time; number of rows a person had to correct to make the task usable |

Rules:
- Disputed ground-truth items are excluded from correctness until the owner settles them; they still count for verifiability (did the model place its count?).
- `counted` mismatches are correctness errors: 12 rafters where the truth is 12 zones is confident-wrong, not partially right.
- A quantity of 0 for an unknown is an error (the format says null).
- An `rfi` raised for a reading difficulty is an error; an `unresolved` note is not.

Fill `results/scoring-template.csv`: one line per (result, task, axis) plus the confident-wrong list per result.
