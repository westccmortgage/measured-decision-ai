# Real files, committed on purpose

These are not stand-ins. The acceptance test opens these exact bytes in a real
browser, renders the pages and decodes the frames out of them, and hands what
comes out to the engine. A test that agreed with itself about a fixture id
would prove nothing, which is why there is no such path.

| file | what it is | why it is here |
| --- | --- | --- |
| `plan-set.pdf` | three vector sheets, real text layer | pages, page text, and one deliberate disagreement: `CEILING HEIGHT 2700` on A-101 and A-102, `CEILING HEIGHT 2400` on A-501 |
| `scan-set.pdf` | two pages that are images only | the scan case: `pdftotext` gets nothing out of it, so the page image is the whole of the material and a reader has to say so |
| `walkthrough.webm` | 8 s, 640×360, VP9 | frames at exact times. An orange marker moves every frame; a red **EXTINGUISHER** panel exists **only between 4.0 s and 5.0 s**, so a sampled reading that misses it proves the point the product has to make out loud: absent from the samples is not absent from the clip |
| `pano-360.webm` | 6 s, 1024×512 (2:1), VP9 | the equirectangular case, with NORTH / EAST / SOUTH / WEST panels at known longitudes |
| `walkthrough.mp4`, `pano-360.mp4` | the same two clips in H.264 | the refusal case. The browser Playwright ships is built without proprietary codecs, so it genuinely cannot decode these — which is exactly the file a person turns up with, and the test asserts the refusal names the codec instead of saying "unsupported file" |

Regenerated with `reportlab`, `Pillow` and `ffmpeg`; the recipe is in
`studio/tests/analysis-material.mjs`. They are committed rather than generated
at test time so the suite needs none of those three.
