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
 * Where a position in a POSIX `sh` command sits, for placing an environment
 * variable reference there:
 *
 * - `unquoted`: a word outside quotes (also comments and arithmetic).
 * - `double`: inside double quotes.
 * - `single`: inside single quotes.
 * - `ansi-c`: inside `$'...'`.
 * - `heredoc`: in the body of a here-document whose delimiter is unquoted,
 *   where the shell expands parameters.
 * - `heredoc-literal`: in the body of a here-document with a quoted
 *   delimiter, where nothing is expanded.
 */
export type ShellContext =
  | "unquoted"
  | "double"
  | "single"
  | "ansi-c"
  | "heredoc"
  | "heredoc-literal";

type Frame =
  | { kind: "top" }
  | { kind: "cmdsub"; parens: number }
  | { kind: "backtick" }
  | { kind: "arith"; parens: number };

interface PendingHeredoc {
  delimiter: string;
  quoted: boolean;
  stripTabs: boolean;
}

/**
 * Classifies each of `positions` (offsets into `command`) by the shell
 * context it falls in. A heuristic over `sh` grammar covering quotes,
 * `$'...'`, comments, command substitution and backticks (where quoting
 * restarts), arithmetic expansion, here-strings and here-documents (plain,
 * `<<-`, fully or partly quoted delimiters, several per line in order,
 * bodies running to the terminator line or the end of the script).
 */
export function classifyShellPositions(
  command: string,
  positions: readonly number[],
): ShellContext[] {
  const wanted = new Map<number, number[]>();
  positions.forEach((position, index) => {
    const list = wanted.get(position) ?? [];
    list.push(index);
    wanted.set(position, list);
  });
  const sorted = [...wanted.keys()].sort((a, b) => a - b);
  const result: ShellContext[] = new Array(positions.length).fill("unquoted");
  // Assigns a context to every requested position in [from, to), finding the
  // first by binary search so a long script costs one lookup per range.
  const record = (from: number, to: number, context: ShellContext) => {
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (sorted[mid] < from) low = mid + 1;
      else high = mid;
    }
    for (let k = low; k < sorted.length && sorted[k] < to; k++) {
      for (const index of wanted.get(sorted[k])!) result[index] = context;
    }
  };

  const frames: Frame[] = [{ kind: "top" }];
  let quote: "none" | "double" | "single" | "ansi-c" = "none";
  const quoteStack: ("none" | "double")[] = [];
  const pending: PendingHeredoc[] = [];
  let i = 0;
  let wordStart = true;

  const frame = () => frames[frames.length - 1];

  while (i < command.length) {
    const ch = command[i];
    const next = command[i + 1];

    if (quote === "single") {
      record(i, i + 1, "single");
      if (ch === "'") quote = "none";
      i++;
      continue;
    }
    if (quote === "ansi-c") {
      record(i, i + 1, "ansi-c");
      if (ch === "\\") {
        record(i + 1, i + 2, "ansi-c");
        i += 2;
        continue;
      }
      if (ch === "'") quote = "none";
      i++;
      continue;
    }

    // Here-document bodies start after the newline that ends their line.
    if (ch === "\n" && quote === "none" && pending.length > 0) {
      i++;
      while (pending.length > 0) {
        const doc = pending.shift()!;
        const bodyStart = i;
        let bodyEnd = command.length;
        let after = command.length;
        let lineStart = i;
        while (lineStart <= command.length) {
          const newline = command.indexOf("\n", lineStart);
          const lineEnd = newline === -1 ? command.length : newline;
          const line = command.slice(lineStart, lineEnd);
          const candidate = doc.stripTabs ? line.replace(/^\t+/, "") : line;
          if (candidate === doc.delimiter) {
            bodyEnd = lineStart;
            after = newline === -1 ? command.length : newline + 1;
            break;
          }
          if (newline === -1) break;
          lineStart = newline + 1;
        }
        record(bodyStart, bodyEnd, doc.quoted ? "heredoc-literal" : "heredoc");
        i = after;
      }
      wordStart = true;
      continue;
    }

    if (ch === "\\") {
      const context = quote === "double" ? "double" : "unquoted";
      record(i, i + 2, context);
      i += 2;
      wordStart = false;
      continue;
    }

    if (quote === "double") {
      record(i, i + 1, "double");
      if (ch === '"') {
        quote = "none";
        i++;
        continue;
      }
      if (ch === "$" && next === "(" && command[i + 2] !== "(") {
        quoteStack.push("double");
        quote = "none";
        frames.push({ kind: "cmdsub", parens: 0 });
        i += 2;
        wordStart = true;
        continue;
      }
      if (ch === "`") {
        quoteStack.push("double");
        quote = "none";
        frames.push({ kind: "backtick" });
        i++;
        wordStart = true;
        continue;
      }
      i++;
      continue;
    }

    // Unquoted from here on.
    const current = frame();
    if (current.kind === "arith") {
      record(i, i + 1, "unquoted");
      if (ch === "(") current.parens++;
      else if (ch === ")") {
        if (current.parens === 0 && next === ")") {
          frames.pop();
          i += 2;
          continue;
        }
        current.parens--;
      }
      i++;
      continue;
    }

    if (ch === "#" && wordStart) {
      const newline = command.indexOf("\n", i);
      const end = newline === -1 ? command.length : newline;
      record(i, end, "unquoted");
      i = end;
      continue;
    }
    if (ch === "'") {
      record(i, i + 1, "single");
      quote = "single";
      i++;
      wordStart = false;
      continue;
    }
    if (ch === "$" && next === "'") {
      record(i, i + 2, "ansi-c");
      quote = "ansi-c";
      i += 2;
      wordStart = false;
      continue;
    }
    if (ch === '"') {
      record(i, i + 1, "double");
      quote = "double";
      i++;
      wordStart = false;
      continue;
    }
    // The arithmetic command `(( ... ))` at a command start, where `<<` is a
    // shift, not a here-document.
    if (ch === "(" && next === "(" && wordStart) {
      frames.push({ kind: "arith", parens: 0 });
      record(i, i + 2, "unquoted");
      i += 2;
      continue;
    }
    if (ch === "$" && next === "(" && command[i + 2] === "(") {
      frames.push({ kind: "arith", parens: 0 });
      record(i, i + 3, "unquoted");
      i += 3;
      continue;
    }
    if (ch === "$" && next === "(") {
      quoteStack.push("none");
      frames.push({ kind: "cmdsub", parens: 0 });
      record(i, i + 2, "unquoted");
      i += 2;
      wordStart = true;
      continue;
    }
    if (ch === "`") {
      record(i, i + 1, "unquoted");
      if (current.kind === "backtick") {
        frames.pop();
        quote = quoteStack.pop() === "double" ? "double" : "none";
      } else {
        quoteStack.push("none");
        frames.push({ kind: "backtick" });
      }
      i++;
      continue;
    }
    if (current.kind === "cmdsub" && (ch === "(" || ch === ")")) {
      record(i, i + 1, "unquoted");
      if (ch === "(") current.parens++;
      else if (current.parens === 0) {
        frames.pop();
        quote = quoteStack.pop() === "double" ? "double" : "none";
      } else current.parens--;
      i++;
      wordStart = false;
      continue;
    }
    if (ch === "<" && next === "<" && command[i + 2] !== "<") {
      const heredoc = parseHeredocOperator(command, i);
      if (heredoc) {
        pending.push(heredoc.doc);
        record(i, heredoc.end, "unquoted");
        i = heredoc.end;
        wordStart = false;
        continue;
      }
    }
    if (ch === "<" && next === "<" && command[i + 2] === "<") {
      record(i, i + 3, "unquoted");
      i += 3;
      wordStart = true;
      continue;
    }

    record(i, i + 1, "unquoted");
    wordStart = /[\s;&|()]/.test(ch);
    i++;
  }
  return result;
}

/** Parses `<<WORD` / `<<-WORD` at `start`, returning the heredoc and where it ends. */
function parseHeredocOperator(
  command: string,
  start: number,
): { doc: PendingHeredoc; end: number } | undefined {
  let i = start + 2;
  const stripTabs = command[i] === "-";
  if (stripTabs) i++;
  while (command[i] === " " || command[i] === "\t") i++;
  let delimiter = "";
  let quoted = false;
  while (i < command.length && !/[\s;&|<>()]/.test(command[i])) {
    const ch = command[i];
    if (ch === "'" || ch === '"') {
      quoted = true;
      const close = command.indexOf(ch, i + 1);
      const end = close === -1 ? command.length : close;
      delimiter += command.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (ch === "\\") {
      quoted = true;
      delimiter += command[i + 1] ?? "";
      i += 2;
      continue;
    }
    delimiter += ch;
    i++;
  }
  if (delimiter === "") return undefined;
  return { doc: { delimiter, quoted, stripTabs }, end: i };
}
