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

// See also: sanitizeErrorForClient in src/serve/handlers/shared.ts, which
// solves the same class of problem for WebSocket error frames with a
// destructive strategy (replaces the entire message). Telemetry preserves
// diagnostic structure by normalizing in-place instead.

/**
 * Filesystem paths are user-chosen and can name customers, projects and
 * people, so a path is replaced whole (swamp-club#2817) — not just its home
 * username segment, which left everything below it and every path outside a
 * home directory intact. Names that are not paths (`Model not found: foo`,
 * `command/shell`, `@swamp/aws/ec2`) are not sensitive and are kept.
 *
 * A quoted path is replaced up to its closing quote, spaces included
 * (`'C:\Users\John Smith\x'`). An unquoted path ends at the first whitespace,
 * so the remainder of an unquoted path containing a space is not redacted —
 * there is no reliable end to it.
 *
 * Matched forms: POSIX absolute (`/opt/x`), home-relative (`~/x`), Windows
 * drive with either slash (`C:\x`, `C:/x`) and UNC (`\\host\share`). A POSIX
 * path must not follow a word character, `:`, `/`, `.`, `@` or `-`, so type
 * names, relative paths and URLs (`https://host/path`) are left alone.
 */
const PATH_CHARS = "[^\\s\"'`<>|,;()\\[\\]{}]";
const PATH_RE = new RegExp(
  [
    `\\\\\\\\${PATH_CHARS}+`, // UNC
    `\\b[A-Za-z]:[\\\\/]${PATH_CHARS}*`, // Windows drive
    `(?<![\\w:/.@~-])~[\\\\/]${PATH_CHARS}*`, // home-relative
    `(?<![\\w:/.@~-])/${PATH_CHARS}+`, // POSIX absolute
  ].join("|"),
  "g",
);

/** A quoted string that starts with a path root: redacted whole, spaces included. */
const QUOTED_PATH_RE = /(["'`])((?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\/)[^"'`\n]*)\1/g;

/**
 * A `:line[:col]` suffix and one trailing `.` or `:`, kept outside the
 * redaction. Deliberately unambiguous — no repeated alternation — so a long
 * run of `:N` segments cannot backtrack exponentially (swamp-club#2817).
 */
const TRAILING_RE = /(?::\d+(?::\d+)?)?[.:]?$/;

const INTERNAL_HOST_RE =
  /\b[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.(?:internal|local|lan|corp|intranet|private|home)\b/g;

export function redactErrorMessage(message: string): string {
  let result = message.replace(
    QUOTED_PATH_RE,
    (_match, quote: string) => `${quote}<PATH>${quote}`,
  );
  result = result.replace(PATH_RE, (match) => {
    const trailing = match.match(TRAILING_RE)?.[0] ?? "";
    return `<PATH>${trailing}`;
  });

  result = result.replace(INTERNAL_HOST_RE, "<REDACTED-HOST>");

  return result;
}
