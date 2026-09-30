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
 * (`'C:\Users\John Smith\x'`). An unquoted path continues across a single
 * space while the next word contains a path separator, so
 * `/Users/jane/Application Support/acme/x` and
 * `C:\Users\John Smith\Acme Corp\x.yaml` are replaced whole. A final word
 * with no separator after it (`C:\Users\John Smith`) has no reliable end and
 * is kept.
 *
 * Matched forms: POSIX absolute (`/opt/x`), home-relative (`~/x`), Windows
 * drive with either slash (`C:\x`, `C:/x`) and UNC (`\\host\share`). A POSIX
 * path must not follow a word character, `:`, `/`, `.`, `@` or `-`, so type
 * names, relative paths and URLs (`https://host/path`) are left alone; a `/`
 * directly after a single `:` (`path:/srv/x`) still starts a path.
 */
const PATH_CHARS = "[^\\s\"'`<>|,;()\\[\\]{}]";
/**
 * One character of a path. `'` and `,` continue it only when another path
 * character follows (`/Users/o'brien/x`, `/srv/acme,corp/x`), so sentence
 * punctuation after a path is left alone. The two alternatives are disjoint.
 */
const PATH_BODY = `(?:${PATH_CHARS}|[',](?=${PATH_CHARS}))`;
/**
 * A space followed by a word that contains a path separator: the next
 * segment of a path with a space in it. The word's first separator is fixed
 * by excluding separators before it, so the pattern is unambiguous and cannot
 * backtrack.
 */
const SPACED_SEGMENT =
  `(?: [^\\s\"'\`<>|,;()\\[\\]{}\\\\/]*[\\\\/]${PATH_BODY}*)*`;
const PATH_RE = new RegExp(
  [
    `\\\\\\\\${PATH_BODY}+`, // UNC
    `\\b[A-Za-z]:[\\\\/]${PATH_BODY}*`, // Windows drive
    `(?<![\\w:/.@~-])~[\\\\/]${PATH_BODY}*`, // home-relative
    `(?<![\\w:/.@~-])/${PATH_BODY}+`, // POSIX absolute
    `(?<=:)/(?!/)${PATH_BODY}+`, // POSIX absolute glued to a colon (path:/x)
  ].map((root) => `${root}${SPACED_SEGMENT}`).join("|"),
  "g",
);

/**
 * Where the whole-path rule does not fire — a relative path through a home
 * directory (`../../Users/alice/x`) or a non-`file:` URL (`ssh://h/home/bob`)
 * — the home username is still replaced.
 */
const HOME_USER_RE = /(\/Users\/|\/home\/|[A-Za-z]:[\\/]Users[\\/])[^\s/\\]+/g;

/**
 * A `file:` URL is a path: `file:///home/alice/acme/x.ts` names the user and
 * the project. Deno module-loading errors carry these. Other URL schemes are
 * kept. A quoted one is redacted up to its closing quote.
 */
const FILE_URL_RE = /(["'`])file:\/\/[^"'`\n]*\1|\bfile:\/\/[^\s"'`<>]*/g;

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

/** A value that names a location rather than being an opaque input. */
function isPathLike(value: string): boolean {
  return /[\\/]/.test(value) || value.startsWith("~");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Where a known path value may end: at a separator, at a character that
 * cannot be part of a path, at sentence punctuation or a `:line` suffix, or
 * at the end. Without this a known `/home/al` would cut `/home/alice` in two.
 */
const KNOWN_PATH_END = `(?=$|[\\\\/\\s"'\`<>|,;()\\[\\]{}]|[.:](?:[\\s\\d]|$))`;

function selectKnownValues(
  values: readonly string[],
  pathLike: boolean,
): string[] {
  return [...new Set(values)]
    .filter((v) => v.length >= 3 && isPathLike(v) === pathLike)
    .sort((a, b) => b.length - a.length);
}

/**
 * Replaces exact occurrences of known path values — typed paths and machine
 * locations such as the working and home directories — before any pattern
 * runs. Unlike the patterns this does not have to guess where a path ends, so
 * `/opt/acme/final report.yaml` is removed whole. A path value also takes the
 * path segments that follow it (a file under the home directory). Longest
 * values go first so a value is never split by one of its own prefixes.
 */
function redactKnownPaths(
  message: string,
  values: readonly string[],
): string {
  let result = message;
  for (const value of selectKnownValues(values, true)) {
    const pattern = `${escapeRegExp(value)}${KNOWN_PATH_END}` +
      `(?:[\\\\/]${PATH_BODY}*${SPACED_SEGMENT})?`;
    result = result.replace(new RegExp(pattern, "g"), "<PATH>");
  }
  return result;
}

/**
 * Replaces known values that are not paths — a secret echoed back in an
 * error, say — as whole words. Runs after the path patterns, so a value that
 * appears inside a path can never split it and let the rest through.
 */
function redactKnownWords(
  message: string,
  values: readonly string[],
): string {
  let result = message;
  for (const value of selectKnownValues(values, false)) {
    const pattern = `(?<![A-Za-z0-9_])${escapeRegExp(value)}(?![A-Za-z0-9_])`;
    result = result.replace(new RegExp(pattern, "g"), "<REDACTED>");
  }
  return result;
}

/**
 * Redacts an error message for telemetry.
 *
 * @param message - The error text
 * @param knownValues - Values known to be sensitive for this invocation,
 *   removed exactly before any pattern runs. Used only for this call; the
 *   caller must never persist them.
 */
export function redactErrorMessage(
  message: string,
  knownValues: readonly string[] = [],
): string {
  let result = redactKnownPaths(message, knownValues);
  result = result.replace(
    FILE_URL_RE,
    (match, quote: string | undefined) => {
      if (quote) return `${quote}<PATH>${quote}`;
      const trailing = match.match(TRAILING_RE)?.[0] ?? "";
      return `<PATH>${trailing}`;
    },
  );
  result = result.replace(
    QUOTED_PATH_RE,
    (_match, quote: string) => `${quote}<PATH>${quote}`,
  );
  result = result.replace(PATH_RE, (match) => {
    const trailing = match.match(TRAILING_RE)?.[0] ?? "";
    return `<PATH>${trailing}`;
  });

  result = redactKnownWords(result, knownValues);
  result = result.replace(
    HOME_USER_RE,
    (_match, prefix: string) => `${prefix}<REDACTED>`,
  );
  result = result.replace(INTERNAL_HOST_RE, "<REDACTED-HOST>");
  // A known prefix followed by a pattern match leaves adjacent markers.
  result = result.replace(/<PATH>(?:<PATH>)+/g, "<PATH>");

  return result;
}
