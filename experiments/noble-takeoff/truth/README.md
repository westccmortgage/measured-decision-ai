# Marked labels — page coordinates at 200 dpi (7197×4795 px per sheet)

One row per printed label, placed by hand on the enlargements. Counts are counts of labels; where one member carries two labels or one label covers several members, `ground-truth.json` lists the item as disputed.

- `p25-labels.csv` — S-3 (page 25): FB1–FB11, HDR1–HDR4, general HDR. 55 labels.
- `p26-labels.csv` — S-4 (page 26): HIP BM, RIDGE BM, RB, RHDR1/2, general RHDR, R.R.1 zones. 63 labels.
- `p24-labels.csv` — S-2 (page 24): F1–F4 footing tags. 20 labels.
- `p25-area-B1.csv` — the sample area (tile p25-r1c1, x 1350–2549, y 1050–2548), 11 labels with notes.

The marked-up sheets themselves (`kit/out/marked/*.png`) are not committed; rebuild the kit and re-run the marking script to regenerate them.
