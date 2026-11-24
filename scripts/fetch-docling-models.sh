#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="$repo_root/src-tauri/resources/models"
if [ -f "$dest/layout_heron.onnx" ] && [ -f "$dest/tableformer/encoder.onnx" ] && [ -z "${DOCLING_FORCE_FETCH:-}" ]; then
  echo "Docling models already staged at $dest (set DOCLING_FORCE_FETCH=1 to refetch)"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

url="https://raw.githubusercontent.com/docling-project/docling.rs/master/scripts/install/download_dependencies.sh"
curl -fsSL "$url" -o "$tmp/download_dependencies.sh"

# The installer writes a `.models/` directory under the current directory.
( cd "$tmp" && bash download_dependencies.sh --no-asr --no-chunk )

if [ ! -d "$tmp/.models" ]; then
  echo "download_dependencies.sh did not produce .models" >&2
  exit 1
fi

mkdir -p "$dest"
find "$dest" -mindepth 1 ! -name ".gitkeep" -delete
cp -a "$tmp/.models/." "$dest/"
echo "Docling models staged at $dest"
