#!/bin/bash
# Post-edit hook: apply license headers and format with deno fmt
# Runs after Edit or Write tool use to ensure consistent formatting

set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Format TypeScript/TSX files and apply license headers
if [[ "$FILE_PATH" == *.ts || "$FILE_PATH" == *.tsx ]]; then
  cd "$CLAUDE_PROJECT_DIR"
  deno run license-headers 2>/dev/null
  deno fmt "$FILE_PATH" 2>/dev/null
  deno lint "$FILE_PATH" 2>/dev/null
  deno check "$FILE_PATH" 2>/dev/null
# Format Markdown files
elif [[ "$FILE_PATH" == *.md ]]; then
  cd "$CLAUDE_PROJECT_DIR"
  deno fmt "$FILE_PATH" 2>/dev/null
fi

exit 0
