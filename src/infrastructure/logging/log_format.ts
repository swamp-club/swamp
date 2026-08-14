// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

import { getTextFormatter, type TextFormatter } from "@logtape/logtape";

// Leaf module: the single source of truth for swamp's log-line timestamp
// format. Imported by both logger.ts (console/stderr sinks) and
// run_file_sink.ts (persisted per-run logs). It imports neither of them, so
// there is no import cycle — logger.ts already imports run_file_sink.ts.

/**
 * Timestamp format for every swamp log line. `"rfc3339"` renders a full
 * ISO-8601 UTC instant with a `Z` marker (e.g. `2026-07-15T09:48:19.080Z`),
 * so log lines are unambiguous about timezone and carry a date for
 * long-running daemons whose logs span multiple days.
 */
export const TIMESTAMP_FORMAT = "rfc3339" as const;

/**
 * Plain-text formatter sharing the RFC3339 timestamp. Used by every
 * non-interactive text sink: the console sink (non-TTY / `--no-color`), the
 * stderr-only sink (worker dispatch), and the persisted run-file sink.
 *
 * `getTextFormatter`'s default layout is already
 * `<timestamp> [<LEVEL>] <category>: <message>` and renders interpolated
 * values without ANSI color, so non-interactive output stays clean when piped
 * or redirected. Colored output is the pretty sink's job (TTY only).
 */
export function textFormatter(): TextFormatter {
  return getTextFormatter({ timestamp: TIMESTAMP_FORMAT });
}

/**
 * Serve-mode formatter: renders log records as `" system │ message"`,
 * matching the pipe-prefix style used by workflow and model-method runs.
 * No timestamp, level, or category — just the message with a fixed
 * "system" prefix padded to the current pipe width.
 *
 * Accepts a width getter so the caller (logger.ts) owns the mutable
 * width state and this module stays a leaf.
 */
export function serveTextFormatter(
  getWidth: () => number,
): TextFormatter {
  return getTextFormatter({
    timestamp: "none",
    format: (values) => {
      const padded = "system".padStart(getWidth() + 1);
      return `${padded} │ ${values.message}`;
    },
  });
}
