#!/bin/bash

set -euo pipefail

# Download a versioned GCS artifact through the public edge and verify its
# checksum before use. No cloud credentials are needed by download-only jobs.
# Usage: bash scripts/download_release_artifact.sh <version> <os/arch> <directory>
# Unix archives are extracted as swamp; Windows keeps swamp-windows-x86_64.zip.
VERSION="${1:-}"
VERSION="${VERSION#v}"
PLATFORM="${2:-}"
DESTINATION="${3:?Destination directory is required}"
if [[ ! "$VERSION" =~ ^[0-9]{8}\.[0-9]{6}\.[0-9]+-sha\.[0-9a-f]{8,40}$ ]]; then
    echo "Error: Invalid release version"
    exit 1
fi
case "$PLATFORM" in
    darwin/aarch64|darwin/x86_64|linux/aarch64|linux/x86_64) EXT="tar.gz" ;;
    windows/x86_64) EXT="zip" ;;
    *) echo "Error: Unsupported platform: $PLATFORM"; exit 1 ;;
esac

TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT
ARCHIVE="swamp-${VERSION}-binary-${PLATFORM%/*}-${PLATFORM#*/}.${EXT}"
URL="https://artifacts.swamp-club.com/swamp/$VERSION/binary/$PLATFORM/$ARCHIVE"
curl --fail --silent --show-error --location --retry 3 "$URL" -o "$TEMP_DIR/$ARCHIVE"
curl --fail --silent --show-error --location --retry 3 "$URL.sha256" -o "$TEMP_DIR/$ARCHIVE.sha256"
expected=$(awk -v f="$ARCHIVE" '$2==f{print $1}' "$TEMP_DIR/$ARCHIVE.sha256")
actual=$(sha256sum "$TEMP_DIR/$ARCHIVE" | awk '{print $1}')
if [[ -z "$expected" || "$expected" != "$actual" ]]; then
    echo "Error: Missing or mismatched checksum for $ARCHIVE"
    exit 1
fi

mkdir -p "$DESTINATION"
if [[ "$EXT" == "zip" ]]; then
    cp "$TEMP_DIR/$ARCHIVE" "$DESTINATION/swamp-windows-x86_64.zip"
else
    tar -xzf "$TEMP_DIR/$ARCHIVE" -C "$DESTINATION" swamp
    chmod 755 "$DESTINATION/swamp"
fi
