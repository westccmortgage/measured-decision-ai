#!/usr/bin/env python3
"""Stands in for the licensed stitcher: same arguments, same progress protocol."""
import sys, json
args = sys.argv[1:]
out = None; inputs = []
for i, a in enumerate(args):
    if a == "--output": out = args[i + 1]
    if a == "--input": inputs.append(args[i + 1])
assert len(inputs) == 2, f"expected two lens files, got {inputs}"
for p in (0, 35, 70, 100):
    print(json.dumps({"progress": p, "sdk_error": 0}), flush=True)
open(out, "wb").write(b"\x00" * 4096)
