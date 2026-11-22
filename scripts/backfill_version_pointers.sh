#!/bin/bash

set -euo pipefail

# Upload the bare-version pointer for every published GitHub release.
# Usage: bash scripts/backfill_version_pointers.sh
# Requires gh and the same gcloud access as upload_release_artifacts.sh; DRY_RUN=true makes no GCS calls.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY="${REPOSITORY:-swamp-club/swamp}"

tags=$(gh release list --repo "$REPOSITORY" --limit 10000 --json tagName --jq '.[].tagName')

published=0
skipped=0
failed=0
for tag in $tags; do
    version="${tag#v}"
    if [[ ! "$version" =~ ^[0-9]{8}\.[0-9]{6}\.[0-9]+-sha\.[0-9a-f]{8,40}$ ]]; then
        echo "Skipped $tag: not a release version"
        skipped=$((skipped + 1))
        continue
    fi
    status=0
    POINTER_ONLY=true bash "$SCRIPT_DIR/upload_release_artifacts.sh" "$version" || status=$?
    case "$status" in
        0) published=$((published + 1)) ;;
        # The release predates the GCS artifact store, so no installer can fetch it.
        3) echo "Skipped $version: no versioned artifacts"; skipped=$((skipped + 1)) ;;
        *) echo "Failed $version (exit $status)"; failed=$((failed + 1)) ;;
    esac
done

echo "Pointers published: $published, skipped: $skipped, failed: $failed"
[[ "$failed" -eq 0 ]]
