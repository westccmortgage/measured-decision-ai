#!/usr/bin/env python3
"""Stands in for ffmpeg: records the cut it was asked for and writes the output."""
import json, os, pathlib, sys
args = sys.argv[1:]
cut = {"stream_copy": "-c" in args and args[args.index("-c") + 1] == "copy"}
for flag, key in (("-ss", "start_seconds"), ("-t", "duration_seconds")):
    if flag in args:
        cut[key] = float(args[args.index(flag) + 1])
pathlib.Path(args[-1]).write_bytes(b"\x00" * 2048)
log = os.getenv("STUB_FFMPEG_LOG")
if log:
    pathlib.Path(log).write_text(json.dumps(cut))
sys.exit(0)
