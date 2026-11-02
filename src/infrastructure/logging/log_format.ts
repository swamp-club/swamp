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

// leaf module, the single source of the log timestamp format; it imports
// neither logger.ts nor run_file_sink.ts, so there is no import cycle

/**
 * full UTC ISO-8601 instant with a Z marker, so lines are unambiguous about
 * timezone and carry a date for daemons whose logs span days
 */
export const TIMESTAMP_FORMAT = "rfc3339" as const;

/**
 * the default layout renders values without ANSI colour, so piped or redirected
 * output stays clean; colour is the pretty sink's job
 */
export function textFormatter(): TextFormatter {
  return getTextFormatter({ timestamp: TIMESTAMP_FORMAT });
}

/**
 * takes a width getter so logger.ts owns the mutable width state and this
 * module stays a leaf
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

const INFO_INDENT = " ".repeat(GUTTER_WIDTH - 1 - "Warning".length);

/**
 * info has no label since it is the ordinary case and carries command results,
 * so it reads as plain text starting where Warning starts
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
  showCategory: boolean;
  showProperties: boolean;
  getPipeWidth: () => number | undefined;
}

/**
 * interpolated values can carry text from outside swamp, and a raw escape
 * sequence would drive the terminal, so control characters but newline and tab
 * print as visible escapes
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
 * an error prints as its message with stack frames dimmed below, since the
 * gutter already says it is an error
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
 * interpolated strings print unquoted so paths can be copied; lines are not
 * wrapped; colours come from @std/fmt/colors so the CLI colour policy applies
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
