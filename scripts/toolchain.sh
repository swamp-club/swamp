#!/usr/bin/env sh
# Swamp, an Automation Framework
# Copyright (C) 2026 Elder Swamp Club, Inc.
# Licensed under the GNU Affero General Public License version 3, with the
# Swamp Extension and Definition Exception (see COPYING-EXCEPTION).
#
# Run a command with the repository's pinned toolchain.
#
# Verification steps inherit whatever environment launched them. A launcher
# whose PATH lacks `deno` — an agent shell, cron, a detached worker, anything
# that sources no interactive profile — made every shell step exit 127, which
# reads as a broken workflow rather than a missing tool. Worse in principle: a
# launcher carrying a *different* deno would verify the repository against an
# unpinned toolchain and the attestation would record that version as though
# it were intended.
#
# `mise exec` resolves the version named in .tool-versions, so routing through
# it here makes both problems go away at once and keeps the launcher
# irrelevant. Where mise is absent the command runs as before, so this is a
# strict improvement rather than a new requirement.
set -e

if command -v mise >/dev/null 2>&1; then
  exec mise exec -- "$@"
fi

exec "$@"
