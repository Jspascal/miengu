#!/usr/bin/env sh
set -eu

REPOSITORY="__MIENGU_REPOSITORY__"
PREFIX="${MIENGU_INSTALL_DIR:-$HOME/.local}"
VERSION="${MIENGU_VERSION:-latest}"

if [ -n "${MIENGU_RELEASE_BASE_URL:-}" ]; then
  BASE_URL="$MIENGU_RELEASE_BASE_URL"
else
  case "$VERSION" in
    latest) BASE_URL="https://github.com/$REPOSITORY/releases/latest/download" ;;
    v*) BASE_URL="https://github.com/$REPOSITORY/releases/download/$VERSION" ;;
    *) BASE_URL="https://github.com/$REPOSITORY/releases/download/v$VERSION" ;;
  esac
fi

download() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -q "$1" -O "$2"
  else echo "miengu installer requires curl or wget" >&2; exit 1
  fi
}

TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/miengu-install.XXXXXX")
cleanup() { rm -rf "$TEMP_DIR"; }
trap cleanup EXIT INT TERM

download "$BASE_URL/miengu.tar.gz" "$TEMP_DIR/miengu.tar.gz"
download "$BASE_URL/SHA256SUMS" "$TEMP_DIR/SHA256SUMS"
grep '  miengu.tar.gz$' "$TEMP_DIR/SHA256SUMS" >"$TEMP_DIR/miengu.sha256"
if command -v shasum >/dev/null 2>&1; then
  (cd "$TEMP_DIR" && shasum -a 256 -c miengu.sha256)
elif command -v sha256sum >/dev/null 2>&1; then
  (cd "$TEMP_DIR" && sha256sum -c miengu.sha256)
else
  echo "miengu installer requires shasum or sha256sum" >&2
  exit 1
fi

mkdir -p "$PREFIX/lib" "$PREFIX/bin"
tar -xzf "$TEMP_DIR/miengu.tar.gz" -C "$TEMP_DIR"
BUNDLE=$(find "$TEMP_DIR" -maxdepth 1 -type d -name 'miengu-v*' | head -n 1)
test -n "$BUNDLE"
rm -rf "$PREFIX/lib/miengu"
mv "$BUNDLE" "$PREFIX/lib/miengu"
# Link directly to the compiled entrypoint: a symlink to bin/miengu would make the shell launcher
# resolve its root relative to the user-facing symlink rather than the installed bundle.
chmod 755 "$PREFIX/lib/miengu/dist/cli/index.js"
ln -sfn "$PREFIX/lib/miengu/dist/cli/index.js" "$PREFIX/bin/miengu"

printf '%s\n' "Installed miengu to $PREFIX/bin/miengu"
printf '%s\n' "Ensure $PREFIX/bin is on your PATH, then run: miengu --help"
