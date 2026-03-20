#!/bin/bash
# Post-edit hook: auto-fix license headers, formatting, and linting
# Runs after Edit or Write tool use — only does auto-fixable operations

set -euo pipefail

# Skip in CI — reviews don't need formatting hooks
if [ "${CI:-}" = "true" ]; then
  exit 0
fi

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Auto-fix TypeScript/TSX files
if [[ "$FILE_PATH" == *.ts || "$FILE_PATH" == *.tsx ]]; then
  cd "$CLAUDE_PROJECT_DIR"
  deno run license-headers
  deno fmt "$FILE_PATH"
  deno lint --fix "$FILE_PATH"
# Format Markdown files
elif [[ "$FILE_PATH" == *.md ]]; then
  cd "$CLAUDE_PROJECT_DIR"
  deno fmt "$FILE_PATH"
fi

exit 0
