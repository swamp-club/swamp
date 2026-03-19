#!/bin/bash
# Stop hook: run project-wide verification before Claude can finish
# Blocks completion if any check fails

set -euo pipefail

cd "$CLAUDE_PROJECT_DIR"

ERRORS=""

if ! deno task check 2>&1; then
  ERRORS="${ERRORS}deno check failed\n"
fi

if ! deno lint 2>&1; then
  ERRORS="${ERRORS}deno lint failed\n"
fi

if ! deno task test 2>&1; then
  ERRORS="${ERRORS}deno test failed\n"
fi

if [ -n "$ERRORS" ]; then
  echo -e "Verification failed. Fix these before finishing:\n${ERRORS}" >&2
  exit 2
fi

exit 0
