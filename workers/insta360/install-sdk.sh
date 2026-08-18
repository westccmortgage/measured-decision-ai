#!/bin/sh
# Install the licensed Insta360 MediaSDK from whatever form the vendor portal
# handed over. The download has appeared as a .deb, as a .tar.xz wrapping that
# .deb, and as a plain tree of lib/ and include/ — so the build accepts all
# three rather than making the operator repackage it by hand.
#
#   install-sdk.sh <archive-or-package> [prefix]
#
# The SDK itself is never copied into this repository or into any image layer
# that gets published; it arrives as a BuildKit secret and stays in the build.
set -eu

SOURCE=${1:?usage: install-sdk.sh <archive-or-package> [prefix]}
PREFIX=${2:-/usr/local}
MODELS_DIR=${MODELS_DIR:-$PREFIX/share/insta360/models}
SYSTEM_INSTALL=0
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

install_deb() {
  echo "Insta360 SDK: installing Debian package $(basename "$1")"
  if [ "$PREFIX" = "/usr/local" ] && [ "$(id -u)" = "0" ]; then
    apt-get update
    apt-get install -y "$1"
    rm -f "$1"
    SYSTEM_INSTALL=1
  else
    # Used by the test: unpack without touching the host package database.
    dpkg-deb -x "$1" "$PREFIX/.deb-root"
    copy_tree "$PREFIX/.deb-root"
    rm -rf "$PREFIX/.deb-root"
  fi
}

# The stitcher's AI passes load weights from files that ship beside the package
# rather than inside it: ai_stitcher_v*.ins, colorplus, deflicker, defringe,
# denoise and the coolingshell profiles. A build that installs only the .deb
# leaves them behind and the AI stitch fails at runtime, not at build time.
copy_models() {
  root=$1
  models=$(find "$root" -type d -name models -print -quit)
  [ -n "$models" ] || return 0
  mkdir -p "$MODELS_DIR"
  cp -a "$models/." "$MODELS_DIR/"
  echo "Insta360 SDK: installed $(find "$MODELS_DIR" -type f | wc -l | tr -d ' ') model files into $MODELS_DIR"
}

copy_tree() {
  root=$1
  found_lib=$(find "$root" -name 'libMediaSDK*.so*' -print -quit)
  if [ -z "$found_lib" ]; then
    echo "Insta360 SDK: no libMediaSDK shared library found in the supplied package" >&2
    exit 3
  fi
  mkdir -p "$PREFIX/lib" "$PREFIX/include"
  find "$root" -name 'libMediaSDK*.so*' -exec cp -a {} "$PREFIX/lib/" \;
  # Headers can sit in include/ or usr/include/; take whichever exists.
  for dir in $(find "$root" -type d -name include); do
    cp -a "$dir/." "$PREFIX/include/"
  done
  if [ ! -f "$PREFIX/include/ins_stitcher.h" ]; then
    echo "Insta360 SDK: ins_stitcher.h is missing — this looks like the CameraSDK, not the MediaSDK" >&2
    exit 4
  fi
  echo "Insta360 SDK: installed into $PREFIX"
}

if dpkg-deb --info "$SOURCE" >/dev/null 2>&1; then
  install_deb "$SOURCE"
  # A bare .deb carries no models; they live beside it in the vendor folder.
  copy_models "$(dirname "$SOURCE")"
elif [ -d "$SOURCE" ]; then
  echo "Insta360 SDK: using the already extracted tree"
  inner_deb=$(find "$SOURCE" -name '*.deb' -print -quit)
  if [ -n "$inner_deb" ]; then
    install_deb "$inner_deb"
  else
    copy_tree "$SOURCE"
  fi
  copy_models "$SOURCE"
else
  echo "Insta360 SDK: expanding $(basename "$SOURCE")"
  tar -xf "$SOURCE" -C "$WORK"
  inner_deb=$(find "$WORK" -name '*.deb' -print -quit)
  if [ -n "$inner_deb" ]; then
    install_deb "$inner_deb"
  else
    copy_tree "$WORK"
  fi
  copy_models "$WORK"
fi

# Only meaningful for a real system install; a test prefix is not on the
# loader path by design.
if [ "$SYSTEM_INSTALL" = "1" ] && command -v ldconfig >/dev/null 2>&1; then
  ldconfig
  # Fail here rather than at the link step, with a message that names the cause.
  if ! ldconfig -p | grep -q MediaSDK; then
    echo "Insta360 SDK: libMediaSDK is not on the loader path after install" >&2
    exit 5
  fi
  if command -v stitcherSDKTest >/dev/null 2>&1; then
    echo "Insta360 SDK: stitcherSDKTest is present, the package installed correctly"
  fi
fi
