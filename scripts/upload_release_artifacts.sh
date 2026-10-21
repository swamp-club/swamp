#!/bin/bash

set -euo pipefail

# Upload versioned artifacts only. Stable promotion belongs to the UAT publisher.
# Usage: bash scripts/upload_release_artifacts.sh <version>
# Requires authenticated gcloud; GCS_BUCKET and BINARIES_DIR are optional.
VERSION="${1:-}"
VERSION="${VERSION#v}"
if [[ ! "$VERSION" =~ ^[0-9]{8}\.[0-9]{6}\.[0-9]+-sha\.[0-9a-f]{8,40}$ ]]; then
    echo "Error: A release version is required (YYYYMMDD.HHMMSS.0-sha.COMMIT)"
    exit 1
fi

GCS_BUCKET="${GCS_BUCKET:-swamp-club-artifacts}"
BINARIES_DIR="${BINARIES_DIR:-./dist}"
REVISION=$(git rev-parse HEAD)
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

BINARIES="swamp-darwin-aarch64:darwin/aarch64 swamp-darwin-x86_64:darwin/x86_64 swamp-linux-x86_64:linux/x86_64 swamp-linux-aarch64:linux/aarch64 swamp-windows-x86_64.zip:windows/x86_64"

# Verify the whole release before uploading any part of it.
for mapping in $BINARIES; do
    binary="${mapping%%:*}"
    expected=$(awk -v f="$binary" '$2==f{print $1}' "$BINARIES_DIR/checksums.txt")
    actual=$(sha256sum "$BINARIES_DIR/$binary" | awk '{print $1}')
    if [[ -z "$expected" || "$expected" != "$actual" ]]; then
        echo "Error: Missing or mismatched checksum for $binary"
        exit 1
    fi
done

upload_immutable() {
    local source="$1" destination="$2" content_type="$3" expected actual
    expected=$(sha256sum "$source" | awk '{print $1}')
    if ! gcloud storage cp "$source" "$destination" \
        --if-generation-match=0 --content-type="$content_type" \
        --custom-metadata="version=$VERSION,revision=$REVISION,sha256=$expected"; then
        actual=$(gcloud storage cat "$destination" | sha256sum | awk '{print $1}')
        if [[ "$actual" != "$expected" ]]; then
            echo "Error: Existing artifact differs: $destination"
            exit 1
        fi
    fi
}

for mapping in $BINARIES; do
    binary="${mapping%%:*}"
    platform="${mapping#*:}"
    os="${platform%/*}"
    arch="${platform#*/}"
    ext="tar.gz"
    content_type="application/gzip"
    if [[ "$binary" == *.zip ]]; then
        ext="zip"
        content_type="application/zip"
    fi
    archive="swamp-${VERSION}-binary-${os}-${arch}.${ext}"
    if [[ "$ext" == "zip" ]]; then
        cp "$BINARIES_DIR/$binary" "$TEMP_DIR/$archive"
    else
        # Keep this packaging identical to swamp-uat/scripts/upload_binaries.sh.
        cp "$BINARIES_DIR/$binary" "$TEMP_DIR/swamp"
        chmod +x "$TEMP_DIR/swamp"
        TZ=UTC touch -t 197001010000 "$TEMP_DIR/swamp"
        (cd "$TEMP_DIR" && tar --format=ustar -cf - swamp | gzip -n > "$archive")
    fi
    checksum=$(sha256sum "$TEMP_DIR/$archive" | awk '{print $1}')
    echo "$checksum  $archive" > "$TEMP_DIR/$archive.sha256"
    destination="gs://$GCS_BUCKET/swamp/$VERSION/binary/$platform/$archive"
    upload_immutable "$TEMP_DIR/$archive" "$destination" "$content_type"
    upload_immutable "$TEMP_DIR/$archive.sha256" "$destination.sha256" "text/plain"
done

echo "Uploaded versioned release $VERSION to gs://$GCS_BUCKET"
