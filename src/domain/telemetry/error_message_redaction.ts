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

// unlike sanitizeErrorForClient, which replaces the whole message, telemetry
// preserves diagnostic structure by normalizing in place

/**
 * marked paths in knownValues go first; patterns are the fallback and replace a
 * whole path since paths can name people; a final unseparated word has no
 * reliable end and is kept
 */
const PATH_CHARS = "[^\\s\"'`<>|,;()\\[\\]{}]";
/**
 * ' and , continue a path only when another path character follows, so sentence
 * punctuation after a path is left alone
 */
const PATH_BODY = `(?:${PATH_CHARS}|[',](?=${PATH_CHARS}))`;
/**
 * the word's first separator is fixed by excluding separators before it, so the
 * pattern is unambiguous and cannot backtrack
 */
const SPACED_SEGMENT =
  `(?: [^\\s\"'\`<>|,;()\\[\\]{}\\\\/]*[\\\\/]${PATH_BODY}*)*`;
const PATH_RE = new RegExp(
  [
    `\\\\\\\\${PATH_BODY}+`,
    `\\b[A-Za-z]:[\\\\/]${PATH_BODY}*`,
    `(?<![\\w:/.@~-])~[\\\\/]${PATH_BODY}*`,
    `(?<![\\w:/.@~-])/${PATH_BODY}+`,
    `(?<=:)/(?!/)${PATH_BODY}+`, // POSIX absolute glued to a colon (path:/x)
  ].map((root) => `${root}${SPACED_SEGMENT}`).join("|"),
  "g",
);

/**
 * where the whole-path rule does not fire (a relative path through a home
 * directory, a non-file URL) the home username is still replaced
 */
const HOME_USER_RE = /(\/Users\/|\/home\/|[A-Za-z]:[\\/]Users[\\/])[^\s/\\]+/g;

/**
 * a file: URL names the user and project and Deno module errors carry them;
 * other URL schemes are kept
 */
const FILE_URL_RE = /(["'`])file:\/\/[^"'`\n]*\1|\bfile:\/\/[^\s"'`<>]*/g;

const QUOTED_PATH_RE = /(["'`])((?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\/)[^"'`\n]*)\1/g;

/**
 * unambiguous, with no repeated alternation, so a long run of :N segments
 * cannot backtrack exponentially
 */
const TRAILING_RE = /(?::\d+(?::\d+)?)?[.:]?$/;

const INTERNAL_HOST_RE =
  /\b[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.(?:internal|local|lan|corp|intranet|private|home)\b/g;

export function isPathLike(value: string): boolean {
  return /[\\/]/.test(value) || value.startsWith("~");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** without this a known /home/al would cut /home/alice in two */
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
 * exact known values need no guess where a path ends; longest go first so a
 * value is never split by one of its own prefixes
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
 * runs after the path patterns so a value inside a path cannot split it and let
 * the rest through
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

/** knownValues are used for this call only; the caller must never persist them */
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
