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

import {
  getTextFormatter,
  type LogLevel,
  type LogRecord,
  type TextFormatter,
} from "@logtape/logtape";
import { bold, dim, getColorEnabled, red, yellow } from "@std/fmt/colors";
import { mapControlCharacters } from "../../domain/control_characters.ts";

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

/**
 * Width of the status gutter. Matches `gutterLine` in
 * src/presentation/output/console_writer.ts, which this layer cannot import;
 * console_writer_test.ts pins the two together.
 */
const GUTTER_WIDTH = 12;

/** Info lines start in the column of the widest label, `Warning`. */
const INFO_INDENT = " ".repeat(GUTTER_WIDTH - 1 - "Warning".length);

/**
 * The gutter label and colour for each level, in `STATUS_COLORS` style.
 * Info has no label: it is the ordinary case, and many commands print their
 * result through it, so it reads as plain text starting where `Warning`
 * starts (see INFO_INDENT).
 */
const LEVEL_STATUS: Record<
  LogLevel,
  { label: string; color: (s: string) => string }
> = {
  trace: { label: "Trace", color: (s) => bold(dim(s)) },
  debug: { label: "Debug", color: (s) => bold(dim(s)) },
  info: { label: "", color: (s) => s },
  warning: { label: "Warning", color: (s) => bold(yellow(s)) },
  error: { label: "Error", color: (s) => bold(red(s)) },
  fatal: { label: "Error", color: (s) => bold(red(s)) },
};

export interface InteractiveFormatterOptions {
  /** Append the record's category, e.g. ` · model.loader`. */
  showCategory: boolean;
  /** Add one `key: value` line per record property. */
  showProperties: boolean;
  /**
   * The width of the `name │` column while a workflow run's pipe display is
   * on screen, or `undefined` when none is.
   */
  getPipeWidth: () => number | undefined;
}

/**
 * `text` with every control character but newline and tab written as a
 * visible `\xNN` escape. Interpolated values can carry text from outside
 * swamp (a remote error, a pulled extension's path), and printed raw an
 * escape sequence in one would drive the terminal.
 */
function printable(text: string): string {
  return mapControlCharacters(
    text,
    (c) =>
      c === "\n" || c === "\t"
        ? c
        : `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}

/**
 * A string as it is; an error as its message with its stack frames dimmed
 * below, since the gutter already says it is an error; anything else as
 * `Deno.inspect` shows it. Strings are made printable first.
 */
function renderValue(value: unknown): string {
  if (typeof value === "string") return printable(value);
  if (value instanceof Error) {
    const frames = (value.stack ?? "").split("\n")
      .filter((line) => /^\s+at /.test(line))
      .map((line) => dim(printable(line.trim())));
    const cause = value.cause instanceof Error
      ? [dim(`caused by: ${printable(value.cause.message)}`)]
      : [];
    return [printable(value.message || value.name), ...frames, ...cause]
      .join("\n");
  }
  return Deno.inspect(value, { colors: getColorEnabled() });
}

/**
 * Formatter for log records shown in a terminal, in the layout the
 * `model method run` and `workflow run` renderers use: a Cargo-style status
 * gutter (`    Warning   message`), or a `system │` pipe line while a
 * workflow run's pipe display is active. No timestamp, and interpolated
 * strings print without quotes, so paths can be copied as they are. Lines
 * are not wrapped; the terminal wraps them.
 *
 * Colours come from `@std/fmt/colors`, so the CLI's colour policy
 * (`--no-color`, `NO_COLOR`, a non-terminal stdout) applies to log records
 * as it does to renderer output.
 */
export function interactiveFormatter(
  options: InteractiveFormatterOptions,
): TextFormatter {
  return (record: LogRecord) => {
    const { label, color } = LEVEL_STATUS[record.level];
    const lines = record.message
      .map((part, index) => index % 2 === 0 ? String(part) : renderValue(part))
      .join("")
      .split("\n");
    if (options.showCategory) {
      lines[0] += dim(` · ${record.category.join(".")}`);
    }
    if (options.showProperties) {
      for (const [key, value] of Object.entries(record.properties)) {
        lines.push(dim(`${key}: ${renderValue(value)}`));
      }
    }
    const pipeWidth = options.getPipeWidth();
    if (pipeWidth !== undefined) {
      const prefix = dim(`${"system".padStart(pipeWidth + 1)} │`);
      return lines.map((line, index) =>
        index === 0
          ? `${prefix} ${label ? `${color(label)} ` : ""}${line}`
          : `${prefix} ${line}`
      ).join("\n") + "\n";
    }
    if (!label) {
      return lines.map((line) => `${INFO_INDENT}${line}`).join("\n") + "\n";
    }
    const indent = " ".repeat(GUTTER_WIDTH + 2);
    return lines.map((line, index) =>
      index === 0
        ? `${color(label.padStart(GUTTER_WIDTH - 1))}   ${line}`
        : `${indent}${line}`
    ).join("\n") + "\n";
  };
}
