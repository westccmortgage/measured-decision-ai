#!/usr/bin/env bash
set -euo pipefail

parts_root="assets/video-parts"
output_root="assets/video"

mkdir -p "$output_root"

for video_dir in "$parts_root"/*; do
  [ -d "$video_dir" ] || continue
  output_name="$(basename "$video_dir")"
  cat "$video_dir"/part-* > "$output_root/$output_name"
done

rm -rf "$parts_root"
