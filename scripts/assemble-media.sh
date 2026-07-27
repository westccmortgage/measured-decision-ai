#!/usr/bin/env bash
set -euo pipefail

parts_root="assets/video-parts"
encoded_root="assets/media-b64"
output_root="assets/video"

mkdir -p "$output_root"

for video_dir in "$parts_root"/*; do
  [ -d "$video_dir" ] || continue
  output_name="$(basename "$video_dir")"
  cat "$video_dir"/part-* > "$output_root/$output_name"
done

for encoded_dir in "$encoded_root"/*; do
  [ -d "$encoded_dir" ] || continue
  output_name="$(basename "$encoded_dir")"
  : > "$output_root/$output_name"
  for encoded_part in "$encoded_dir"/part-*; do
    base64 --decode "$encoded_part" >> "$output_root/$output_name"
  done
done

python3 scripts/patch-main-team.py

rm -rf "$parts_root" "$encoded_root"
