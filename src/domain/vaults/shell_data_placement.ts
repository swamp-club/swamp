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

/**
 * data text spliced into a shell command must reach the shell as one literal
 * word: each data range becomes an env variable reference; where none expands
 * or the shell re-evaluates text, placement is refused
 */

import { scanShellPositions } from "./shell_context_scanner.ts";
import {
  getQuoteContext,
  posixDataReference,
  VaultSecretBag,
} from "./vault_secret_bag.ts";

/** written out here so the vaults context does not depend on expressions */
export type DataRange = readonly [number, number];

export const GENERATED_DATA_ENV_PREFIX = "__SWAMP_IN_";

export type ShellDialect = "posix" | "powershell";

/**
 * undefined for a platform swamp does not know, so a caller refuses rather than
 * guess
 */
export function shellDialectFor(platform: string): ShellDialect | undefined {
  switch (platform) {
    case "windows":
      return "powershell";
    case "linux":
    case "darwin":
    case "freebsd":
    case "netbsd":
    case "openbsd":
    case "aix":
    case "solaris":
    case "illumos":
    case "android":
      return "posix";
    default:
      return undefined;
  }
}

export interface RefusedDataPlacement {
  readonly where: string;
  readonly why: string;
  readonly fix: string;
}

const NO_REFERENCE_EXPANDS =
  "no environment variable reference expands, so it would be pasted into " +
  "the command line";

const QUOTED_HEREDOC_REFUSAL: RefusedDataPlacement = {
  where: "a here-document with a quoted delimiter",
  why: NO_REFERENCE_EXPANDS,
  fix: "use an unquoted here-document delimiter",
};

const POWERSHELL_SINGLE_REFUSAL: RefusedDataPlacement = {
  where: "PowerShell single quotes",
  why: NO_REFERENCE_EXPANDS,
  fix: "use double quotes",
};

// bash evaluates an expanded value inside arithmetic again, array subscripts
// included, so a quoted reference there still runs a command substitution.
const ARITHMETIC_REFUSAL: RefusedDataPlacement = {
  where:
    "shell arithmetic ($(( )), (( )), $[ ], an array subscript or a substring offset)",
  why: "the shell evaluates an expanded value again as code, so a reference " +
    "does not keep it literal",
  fix:
    "pass the value through env and check it is a number before using it in arithmetic",
};

export interface ShellDataPlacement {
  readonly command: string;
  readonly env: Record<string, string>;
  readonly refused?: RefusedDataPlacement;
  /**
   * True when the command is nothing but data, apart from whitespace: as
   * one literal word it can only name a program, never run a script.
   */
  readonly wholeCommandIsData: boolean;
}

function matching(
  text: string,
  from: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      if (depth === 0) return i;
      depth--;
    }
  }
  return text.length;
}

/**
 * read from the text alone regardless of quoting, so it errs toward more spans;
 * covers the arithmetic forms the shell context scanner's grammar does not
 */
function bashArithmeticSpans(command: string): DataRange[] {
  const spans: DataRange[] = [];
  for (const m of command.matchAll(/\(\(/g)) {
    const start = m.index + 2;
    spans.push([start, matching(command, start, "(", ")")]);
  }
  for (const m of command.matchAll(/\$\[/g)) {
    const start = m.index + 2;
    spans.push([start, matching(command, start, "[", "]")]);
  }
  // in ${...} the subscript and an offset (a colon not followed by - = + ?) are
  // arithmetic; ${name:-word} and the pattern operators are not
  for (
    const m of command.matchAll(
      /\$\{[#!]?(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!-])/g,
    )
  ) {
    const close = matching(command, m.index + 2, "{", "}");
    let i = m.index + m[0].length;
    if (command[i] === "[") {
      const end = matching(command, i + 1, "[", "]");
      spans.push([i + 1, end]);
      i = end + 1;
    }
    if (command[i] === ":" && !/[-=+?]/.test(command[i + 1] ?? "")) {
      spans.push([i + 1, close]);
    }
  }
  for (const m of command.matchAll(/[A-Za-z_][A-Za-z0-9_]*\+?=\(/g)) {
    const bodyStart = m.index + m[0].length;
    const bodyEnd = matching(command, bodyStart, "(", ")");
    for (let i = bodyStart; i < bodyEnd; i++) {
      if (command[i] !== "[") continue;
      const end = matching(command, i + 1, "[", "]");
      if (/^\]\+?=/.test(command.slice(end, end + 3))) spans.push([i + 1, end]);
      i = end;
    }
  }
  for (const m of command.matchAll(/[A-Za-z_][A-Za-z0-9_]*\[/g)) {
    const start = m.index + m[0].length;
    const end = matching(command, start, "[", "]");
    if (/^\]\+?=/.test(command.slice(end, end + 3))) spans.push([start, end]);
  }
  return spans;
}

function dataPieces(
  command: string,
  ranges: readonly DataRange[],
): DataRange[] {
  const merged = [...ranges]
    .map(([s, e]): DataRange => [Math.max(0, s), Math.min(command.length, e)])
    .filter(([s, e]) => s < e)
    .sort((a, b) => a[0] - b[0]);
  const joined: [number, number][] = [];
  for (const [s, e] of merged) {
    const last = joined[joined.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else joined.push([s, e]);
  }
  // A sentinel inside data stands for a secret, which the secret placement
  // puts through the environment on its own.
  const sentinels = [...command.matchAll(VaultSecretBag.SENTINEL_PATTERN)]
    .map((m): DataRange => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
  const pieces: DataRange[] = [];
  for (const [s, e] of joined) {
    let from = s;
    for (const [ss, se] of sentinels) {
      if (se <= from || ss >= e) continue;
      if (ss > from) pieces.push([from, ss]);
      from = Math.max(from, se);
    }
    if (from < e) pieces.push([from, e]);
  }
  return pieces;
}

/**
 * each range becomes a reference to a generated variable named so it never
 * equals an authored env key (case-insensitively on PowerShell); equal text
 * shares one variable
 */
export function placeShellData(
  command: string,
  ranges: readonly DataRange[],
  authoredEnvKeys: Iterable<string>,
  dialect: ShellDialect,
): ShellDataPlacement {
  const pieces = dataPieces(command, ranges);
  if (pieces.length === 0) {
    return { command, env: {}, wholeCommandIsData: false };
  }
  const wholeCommandIsData = pieces.length === 1 &&
    command.slice(0, pieces[0][0]).trim() === "" &&
    command.slice(pieces[0][1]).trim() === "";

  // each piece is swapped for an inert word before contexts are read, so quote
  // characters in the data cannot move the context of what follows
  let inert = "";
  const positions: number[] = [];
  let last = 0;
  pieces.forEach(([s, e], i) => {
    inert += command.slice(last, s);
    positions.push(inert.length);
    inert += `__SWAMP_DATA_${i}__`;
    last = e;
  });
  inert += command.slice(last);

  const fold = (name: string) =>
    dialect === "powershell" ? name.toUpperCase() : name;
  const taken = new Set([...authoredEnvKeys].map(fold));
  const names = new Map<string, string>();
  const env: Record<string, string> = {};
  let next = 0;
  const nameFor = (text: string): string => {
    const existing = names.get(text);
    if (existing) return existing;
    let name = `${GENERATED_DATA_ENV_PREFIX}${next++}`;
    while (taken.has(fold(name))) {
      name = `${GENERATED_DATA_ENV_PREFIX}${next++}`;
    }
    names.set(text, name);
    env[name] = text;
    return name;
  };

  const textOf = (i: number) => command.slice(pieces[i][0], pieces[i][1]);
  const arithmeticSpans = dialect === "posix" ? bashArithmeticSpans(inert) : [];
  const inArithmetic = (position: number) =>
    arithmeticSpans.some(([s, e]) => position >= s && position < e);
  const references: (string | RefusedDataPlacement)[] = dialect === "posix"
    ? scanShellPositions(inert, positions).map(({ context, arithmetic }, i) => {
      if (arithmetic || inArithmetic(positions[i])) return ARITHMETIC_REFUSAL;
      return posixDataReference(nameFor(textOf(i)), context) ??
        QUOTED_HEREDOC_REFUSAL;
    })
    : positions.map((position, i) => {
      const quote = getQuoteContext(inert, position);
      if (quote === "single") return POWERSHELL_SINGLE_REFUSAL;
      // Braced inside double quotes, so word characters the author wrote
      // right after the splice are not read as part of the name.
      const name = nameFor(textOf(i));
      return quote === "double" ? `\${env:${name}}` : `"$env:${name}"`;
    });

  const refused = references.find((reference) => typeof reference !== "string");
  if (refused !== undefined) {
    return { command, env: {}, wholeCommandIsData, refused };
  }

  let placed = "";
  last = 0;
  pieces.forEach(([s, e], i) => {
    placed += command.slice(last, s) + references[i];
    last = e;
  });
  placed += command.slice(last);
  return { command: placed, env, wholeCommandIsData };
}
