#!/usr/bin/env python3
"""Stands in for ffprobe: reports the duration the test asks for."""
import os, sys
print(os.getenv("STUB_DURATION_SECONDS", "120"))
sys.exit(0)
