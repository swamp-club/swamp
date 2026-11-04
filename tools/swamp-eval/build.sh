#!/bin/sh
# Checks and builds .bin/swamp-eval. The one build path for local runs,
# verify-skills and CI, so every run uses the same compiler and flags.
set -eu

root=$(git rev-parse --show-toplevel)
cd "$root"

version=$(awk '$1 == "golang" { print $2 }' .tool-versions)
if [ -z "$version" ]; then
  echo "build.sh: .tool-versions has no golang pin" >&2
  exit 1
fi
# An exact toolchain, fetched and checksum-verified by Go when the local one
# differs, so everyone compiles with the pinned compiler.
export GOTOOLCHAIN="go$version" CGO_ENABLED=0

unformatted=$("$(go env GOROOT)/bin/gofmt" -l tools/swamp-eval)
if [ -n "$unformatted" ]; then
  echo "build.sh: not gofmt-formatted (run gofmt -w tools/swamp-eval):" >&2
  echo "$unformatted" >&2
  exit 1
fi
go -C tools/swamp-eval vet ./...
go -C tools/swamp-eval test ./...

source_tree=$(git rev-parse --verify --quiet HEAD:tools/swamp-eval || echo uncommitted)
if [ -n "$(git status --porcelain -- tools/swamp-eval)" ]; then
  source_tree="$source_tree+dirty"
fi
go -C tools/swamp-eval build -trimpath -buildvcs=false \
  -ldflags "-X main.sourceTree=$source_tree" \
  -o "$root/.bin/swamp-eval" ./cmd/swamp-eval
echo "built .bin/swamp-eval (go$version, source $source_tree)"
