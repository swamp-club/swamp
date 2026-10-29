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
 * Placement of data-origin text in a shell command (swamp-club#3868).
 *
 * A value that came from data (a caller's or a webhook's input, a data read,
 * a step output, an environment variable) and was spliced into a shell
 * command must reach the shell as one literal word, never as syntax. Each
 * data range of the command becomes a reference to a generated environment
 * variable that holds the text, with the same context-aware references a
 * secret read through data gets (design/enablers/expressions.md, Shell
 * Safety). Shell variable expansion happens after the command is parsed, so
 * metacharacters in the text stay literal. Where no reference expands (a
 * here-document with a quoted delimiter on POSIX, single quotes on
 * PowerShell), or where the shell evaluates the expanded text again (POSIX
 * arithmetic), placement is refused rather than pasting the text in.
 */

import { scanShellPositions } from "./shell_context_scanner.ts";
import {
  getQuoteContext,
  posixDataReference,
  VaultSecretBag,
} from "./vault_secret_bag.ts";

/**
 * A `[start, end)` range of a command that holds data text, as provenance
 * records it (written out here so the vaults context does not depend on
 * expressions).
 */
export type DataRange = readonly [number, number];

/** The prefix of every environment variable that carries data text. */
export const GENERATED_DATA_ENV_PREFIX = "__SWAMP_IN_";

/** The shell grammar a command is placed for. */
export type ShellDialect = "posix" | "powershell";

/**
 * The dialect of the shell `command/shell` runs on a host whose OS is
 * `platform` (`Deno.build.os`, also what a worker enrolls with), as
 * `selectShellStrategy` chooses it. Undefined for a platform swamp does not
 * know, so a caller refuses rather than guess.
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

/** A data range of a command that no environment reference expands at. */
export interface RefusedDataPlacement {
  /** The position as a user reads it. */
  readonly where: string;
  /** Why data text cannot be passed safely there, read after "where". */
  readonly why: string;
  /** What to write instead. */
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

/** A command with its data text placed through the environment. */
export interface ShellDataPlacement {
  /** The command with every data range replaced by its reference. */
  readonly command: string;
  /** The generated variables and the data text each carries. */
  readonly env: Record<string, string>;
  /** Set when a data range sits where no reference expands. */
  readonly refused?: RefusedDataPlacement;
  /**
   * True when the command is nothing but data, apart from whitespace: as
   * one literal word it can only name a program, never run a script.
   */
  readonly wholeCommandIsData: boolean;
}

/** The index of the `close` matching the `open` before `from`, or the end. */
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
 * Spans of `command` that bash evaluates as an arithmetic expression after
 * expansion, read from the text alone and regardless of quoting, so it errs
 * toward more spans: `((...))` wherever it is written (`for((`, `while((`),
 * `$[...]`, a subscript or substring offset inside `${...}`, and an array
 * element assignment's subscript. The shell context scanner finds the
 * plain `$(( ))` and `(( ))` forms too; this pass covers what its grammar
 * does not.
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
  // ${name[subscript]} and ${name:offset:length}, but not ${name:-word}.
  for (
    const m of command.matchAll(
      /\$\{[#!]?[A-Za-z_][A-Za-z0-9_]*(\[|:(?![-=+?]))/g,
    )
  ) {
    const start = m.index + m[0].length;
    spans.push([
      start,
      m[1] === "["
        ? matching(command, start, "[", "]")
        : matching(command, start, "{", "}"),
    ]);
  }
  // name[subscript]= and name[subscript]+=, including after declare/local.
  for (const m of command.matchAll(/[A-Za-z_][A-Za-z0-9_]*\[/g)) {
    const start = m.index + m[0].length;
    const end = matching(command, start, "[", "]");
    if (/^\]\+?=/.test(command.slice(end, end + 3))) spans.push([start, end]);
  }
  return spans;
}

/** The parts of `ranges` in `command` that are data text, sentinels cut out. */
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
 * Places the data ranges of `command` for `dialect`: each becomes a
 * reference to a generated `__SWAMP_IN_<n>` variable, named so it never
 * equals one of `authoredEnvKeys` (case-insensitively on PowerShell, as
 * Windows reads names). Text outside the ranges is unchanged. Equal text
 * shares one variable.
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

  // Each piece is swapped for an inert word before the contexts are read,
  // so quote characters in the data cannot move the context of what
  // follows it.
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
