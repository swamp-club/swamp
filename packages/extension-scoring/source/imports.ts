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
 * Reading import specifiers out of TypeScript or JavaScript source without
 * parsing it. The registry runs these on archives it did not author, so
 * every scan is a single pass over the text: no pattern here backtracks
 * over more than the code between two string literals, and nesting is
 * bounded.
 *
 * @module
 */

// This scanner blanks comments and template literals while preserving
// ' and " string contents, so the import-specifier regex can still match real
// import strings — a specifier always lives in one of those two quote styles.
//
// Template literals are blanked because a static import specifier can never be
// one (`import x from `y`` is a SyntaxError), so an import statement between
// backticks is always generated code, not part of this module's own graph
// (swamp-club#1490 — the same false-positive lineage as #602 and #657). When a
// backtick has no closing partner — a regex literal, say, which this scanner
// cannot recognise — the span is re-emitted verbatim rather than blanked, so an
// unbalanced backtick degrades to a no-op instead of erasing the rest of the
// file from the caller's view.
//
// Every blanked character becomes a space and newlines stay, so an offset in
// the output is the same offset in `source` (findImportSpecifiers reads import
// spans from it, swamp-club#3637).
export function stripSourceComments(source: string): string {
  const result: string[] = [];
  let i = 0;

  while (i < source.length) {
    // Single-line comment — blank to end of line
    if (source[i] === "/" && i + 1 < source.length && source[i + 1] === "/") {
      result.push(" ", " ");
      i += 2;
      while (i < source.length && source[i] !== "\n") {
        result.push(" ");
        i++;
      }
      continue;
    }

    // Block comment — blank preserving newlines
    if (source[i] === "/" && i + 1 < source.length && source[i + 1] === "*") {
      result.push(" ", " ");
      i += 2;
      while (i < source.length) {
        if (
          source[i] === "*" && i + 1 < source.length &&
          source[i + 1] === "/"
        ) {
          result.push(" ", " ");
          i += 2;
          break;
        }
        result.push(source[i] === "\n" ? "\n" : " ");
        i++;
      }
      continue;
    }

    // Double-quoted string — preserve content (imports live here)
    if (source[i] === '"') {
      result.push(source[i]);
      i++;
      while (i < source.length && source[i] !== '"' && source[i] !== "\n") {
        if (source[i] === "\\") {
          result.push(source[i]);
          i++;
        }
        if (i < source.length) {
          result.push(source[i]);
          i++;
        }
      }
      if (i < source.length && source[i] === '"') {
        result.push(source[i]);
        i++;
      }
      continue;
    }

    // Single-quoted string — preserve content
    if (source[i] === "'") {
      result.push(source[i]);
      i++;
      while (i < source.length && source[i] !== "'" && source[i] !== "\n") {
        if (source[i] === "\\") {
          result.push(source[i]);
          i++;
        }
        if (i < source.length) {
          result.push(source[i]);
          i++;
        }
      }
      if (i < source.length && source[i] === "'") {
        result.push(source[i]);
        i++;
      }
      continue;
    }

    // Template literal — blank content
    if (source[i] === "`") {
      const span: string[] = [];
      const next = skipTemplateLiteral(source, i, span);
      if (next === null) {
        // Unterminated: the backtick was not a template after all. Keep the
        // remainder verbatim — byte-identical to leaving it unscanned.
        result.push(source.slice(i));
        break;
      }
      result.push(span.join(""));
      i = next;
      continue;
    }

    result.push(source[i]);
    i++;
  }

  return result.join("");
}

/**
 * Deepest template literal nesting (`` `${`${...}`}` ``) the scanner follows;
 * deeper is treated as unterminated, so hostile input cannot exhaust the
 * stack.
 */
const MAX_TEMPLATE_NESTING = 64;

/** Blanks a character, keeping newlines so line positions do not drift. */
function blank(ch: string): string {
  return ch === "\n" ? "\n" : " ";
}

/**
 * Consumes the template literal opening at `start`, appending its blanked span
 * to `out`. Returns the index just past the closing backtick, or null when the
 * source ends first — the caller re-emits the span verbatim in that case.
 */
function skipTemplateLiteral(
  source: string,
  start: number,
  out: string[],
  nesting = 0,
): number | null {
  if (nesting >= MAX_TEMPLATE_NESTING) return null;
  out.push(" ");
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      out.push(" ");
      i++;
      if (i < source.length) {
        out.push(blank(source[i]));
        i++;
      }
      continue;
    }
    if (ch === "`") {
      out.push(" ");
      return i + 1;
    }
    if (ch === "$" && source[i + 1] === "{") {
      out.push(" ", " ");
      i = skipInterpolation(source, i + 2, out, nesting);
      continue;
    }
    out.push(blank(ch));
    i++;
  }
  return null;
}

/**
 * Consumes a `${...}` interpolation body starting just past the `${`. Counts
 * every brace so an object literal cannot close the interpolation early, and
 * delegates quotes and nested templates so their contents cannot either.
 */
function skipInterpolation(
  source: string,
  start: number,
  out: string[],
  nesting: number,
): number {
  let depth = 1;
  let i = start;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "{") {
      depth++;
      out.push(" ");
      i++;
      continue;
    }
    if (ch === "}") {
      depth--;
      out.push(" ");
      i++;
      if (depth === 0) return i;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipQuoted(source, i, ch, out);
      continue;
    }
    if (ch === "`") {
      const next = skipTemplateLiteral(source, i, out, nesting + 1);
      // A nested template that never closes means the enclosing one does not
      // either — hand the whole span back to the caller's verbatim fallback.
      if (next === null) return source.length;
      i = next;
      continue;
    }
    out.push(blank(ch));
    i++;
  }
  return i;
}

/**
 * Consumes a ' or " string inside an interpolation, blanking it so braces in
 * its content are not counted against the interpolation depth.
 */
function skipQuoted(
  source: string,
  start: number,
  quote: string,
  out: string[],
): number {
  out.push(" ");
  let i = start + 1;
  while (i < source.length && source[i] !== quote && source[i] !== "\n") {
    if (source[i] === "\\") {
      out.push(" ");
      i++;
      if (i >= source.length) break;
    }
    out.push(blank(source[i]));
    i++;
  }
  if (i < source.length && source[i] === quote) {
    out.push(" ");
    i++;
  }
  return i;
}

/** A quoted specifier in import position, by UTF-16 offsets of its quotes. */
export interface ImportedSpecifierAt {
  specifier: string;
  /** Offset of the opening quote. */
  start: number;
  /** Offset just past the closing quote; the line end when unterminated. */
  end: number;
  terminated: boolean;
}

/**
 * The quoted specifiers in import position in `code`, which
 * {@link stripSourceComments} has already cleaned. Each string literal is
 * read as a token, so text inside a string (`"run: import x from 'y'"`) is
 * never taken for an import, and only the code between it and the previous
 * literal is examined.
 */
export function importedSpecifiersAt(code: string): ImportedSpecifierAt[] {
  const specifiers: ImportedSpecifierAt[] = [];
  let codeStart = 0;
  let i = 0;
  while (i < code.length) {
    const quote = code[i];
    if (quote !== '"' && quote !== "'") {
      i++;
      continue;
    }
    let end = i + 1;
    while (end < code.length && code[end] !== quote && code[end] !== "\n") {
      end += code[end] === "\\" ? 2 : 1;
    }
    if (inImportPosition(code.slice(codeStart, i))) {
      const terminated = code[end] === quote;
      specifiers.push({
        specifier: code.slice(i + 1, end),
        start: i,
        end: terminated ? end + 1 : end,
        terminated,
      });
    }
    i = end + 1;
    codeStart = i;
  }
  return specifiers;
}

/** The specifiers {@link importedSpecifiersAt} finds in raw source. */
export function importedSpecifiers(source: string): string[] {
  return importedSpecifiersAt(stripSourceComments(source)).map((s) =>
    s.specifier
  );
}

/** A character that cannot end an identifier or a member access before a keyword. */
const KEYWORD_BOUNDARY = /[^.\w$]/;

/** A keyword in a statement position, scanned once from the left. */
const IMPORT_OR_EXPORT = /(?:^|[^.\w$])(?:import|export)\b/;

function endsWithKeyword(text: string, keyword: string): boolean {
  if (!text.endsWith(keyword)) return false;
  const before = text.length - keyword.length - 1;
  return before < 0 || KEYWORD_BOUNDARY.test(text[before]);
}

/**
 * Whether the code before a string literal puts it in import position:
 * `import ... from`/`export ... from` with no `;` between the keyword and
 * `from`, a side-effect `import`, or `import(`. Equivalent to the pattern
 * `(?:^|[^.\w$])(?:(?:import|export)\b[^;]*\bfrom|import)\s*$|(?:^|[^.\w$])import\s*\(\s*$`
 * but linear in the length of the code: that pattern backtracks over the
 * whole text once per keyword.
 */
export function inImportPosition(code: string): boolean {
  const tail = code.trimEnd();
  if (tail.endsWith("(")) {
    return endsWithKeyword(tail.slice(0, -1).trimEnd(), "import");
  }
  if (endsWithKeyword(tail, "import")) return true;
  if (!tail.endsWith("from")) return false;
  const beforeFrom = tail.length - 5;
  // `\bfrom`: the character before must not be a word character
  if (beforeFrom >= 0 && /\w/.test(tail[beforeFrom])) return false;
  const statement = tail.slice(tail.lastIndexOf(";") + 1, tail.length - 4);
  return IMPORT_OR_EXPORT.test(statement);
}
