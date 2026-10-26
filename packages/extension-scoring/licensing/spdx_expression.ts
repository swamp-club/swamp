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
 * SPDX license expressions (SPDX 2.3, Annex D) parsed into a tree.
 *
 * This is syntax only: it does not know which ids exist or which are
 * allowed. Callers judge the tree with their own policy, so the extension
 * manifest rules and the dependency trust allowlist read licenses the same
 * way.
 */

/** A license id, with `+` ("or any later version") when written. */
export interface SpdxLicenseNode {
  readonly kind: "license";
  readonly id: string;
  readonly orLater: boolean;
}

/** A license with an exception or addition: `<license> WITH <exception>`. */
export interface SpdxWithNode {
  readonly kind: "with";
  readonly license: SpdxLicenseNode;
  readonly exception: string;
}

/** `AND` or `OR` of two sub-expressions. */
export interface SpdxCompoundNode {
  readonly kind: "and" | "or";
  readonly left: SpdxExpression;
  readonly right: SpdxExpression;
}

/** A parsed SPDX license expression. */
export type SpdxExpression = SpdxLicenseNode | SpdxWithNode | SpdxCompoundNode;

/** Longest expression the parser accepts, to bound work on untrusted input. */
export const MAX_SPDX_EXPRESSION_LENGTH = 512;

/** Thrown when an expression is not valid SPDX syntax. */
export class SpdxSyntaxError extends Error {
  /** The token the parser stopped at, when there is one. */
  readonly term: string | undefined;

  constructor(message: string, term?: string) {
    super(message);
    this.name = "SpdxSyntaxError";
    this.term = term;
  }
}

type Token =
  | { type: "id"; value: string }
  | { type: "op"; value: "AND" | "OR" | "WITH" }
  | { type: "plus" | "lparen" | "rparen"; value: string };

const OPERATORS = new Set(["AND", "OR", "WITH"]);
const ID_PATTERN = /^[A-Za-z0-9.\-:]+$/;

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /\s*([()+]|[^\s()+]+)/gy;
  let match: RegExpExecArray | null;
  let consumed = 0;
  while ((match = pattern.exec(input)) !== null) {
    consumed = pattern.lastIndex;
    const raw = match[1];
    if (raw === "(") tokens.push({ type: "lparen", value: raw });
    else if (raw === ")") tokens.push({ type: "rparen", value: raw });
    else if (raw === "+") tokens.push({ type: "plus", value: raw });
    else if (OPERATORS.has(raw)) {
      tokens.push({ type: "op", value: raw as "AND" | "OR" | "WITH" });
    } else if (OPERATORS.has(raw.toUpperCase())) {
      throw new SpdxSyntaxError(
        `operator "${raw}" must be written in uppercase: ${raw.toUpperCase()}`,
        raw,
      );
    } else if (ID_PATTERN.test(raw)) {
      tokens.push({ type: "id", value: raw });
    } else {
      throw new SpdxSyntaxError(
        `"${raw}" is not a license id: ids use only letters, digits, ".", "-" and ":"`,
        raw,
      );
    }
  }
  if (input.slice(consumed).trim() !== "") {
    throw new SpdxSyntaxError("unexpected trailing characters");
  }
  return tokens;
}

class Parser {
  #pos = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): SpdxExpression {
    if (this.tokens.length === 0) {
      throw new SpdxSyntaxError("the expression is empty");
    }
    const expr = this.#or();
    const rest = this.#peek();
    if (rest) {
      throw new SpdxSyntaxError(
        `unexpected "${rest.value}"; join licenses with AND or OR`,
        rest.value,
      );
    }
    return expr;
  }

  #peek(): Token | undefined {
    return this.tokens[this.#pos];
  }

  #next(): Token | undefined {
    return this.tokens[this.#pos++];
  }

  #isOp(value: "AND" | "OR" | "WITH"): boolean {
    const token = this.#peek();
    return token?.type === "op" && token.value === value;
  }

  #or(): SpdxExpression {
    let left = this.#and();
    while (this.#isOp("OR")) {
      this.#pos++;
      left = { kind: "or", left, right: this.#and() };
    }
    return left;
  }

  #and(): SpdxExpression {
    let left = this.#primary();
    while (this.#isOp("AND")) {
      this.#pos++;
      left = { kind: "and", left, right: this.#primary() };
    }
    return left;
  }

  #primary(): SpdxExpression {
    const token = this.#next();
    if (!token) {
      throw new SpdxSyntaxError("the expression ends where a license is due");
    }
    if (token.type === "lparen") {
      const inner = this.#or();
      const close = this.#next();
      if (close?.type !== "rparen") {
        throw new SpdxSyntaxError(
          'unbalanced parentheses: missing ")"',
          close?.value,
        );
      }
      return inner;
    }
    if (token.type !== "id") {
      throw new SpdxSyntaxError(
        `expected a license id, found "${token.value}"`,
        token.value,
      );
    }
    let orLater = false;
    if (this.#peek()?.type === "plus") {
      this.#pos++;
      orLater = true;
    }
    const license: SpdxLicenseNode = {
      kind: "license",
      id: token.value,
      orLater,
    };
    if (!this.#isOp("WITH")) return license;
    this.#pos++;
    const exception = this.#next();
    if (exception?.type !== "id") {
      throw new SpdxSyntaxError(
        "WITH must be followed by an exception id",
        exception?.value,
      );
    }
    return { kind: "with", license, exception: exception.value };
  }
}

/**
 * Parses an SPDX license expression. `OR` binds loosest, then `AND`, then
 * `WITH`; parentheses group.
 *
 * @throws SpdxSyntaxError when the text is not a valid expression.
 */
export function parseSpdxExpression(input: string): SpdxExpression {
  if (input.length > MAX_SPDX_EXPRESSION_LENGTH) {
    throw new SpdxSyntaxError(
      `the expression is longer than ${MAX_SPDX_EXPRESSION_LENGTH} characters`,
    );
  }
  return new Parser(tokenize(input)).parse();
}

/** Writes a tree back as an expression, with the parentheses it needs. */
export function formatSpdxExpression(expr: SpdxExpression): string {
  switch (expr.kind) {
    case "license":
      return `${expr.id}${expr.orLater ? "+" : ""}`;
    case "with":
      return `${formatSpdxExpression(expr.license)} WITH ${expr.exception}`;
    case "and":
      return `${formatAndOperand(expr.left)} AND ${
        formatAndOperand(expr.right, true)
      }`;
    case "or":
      return `${formatSpdxExpression(expr.left)} OR ${
        expr.right.kind === "or"
          ? `(${formatSpdxExpression(expr.right)})`
          : formatSpdxExpression(expr.right)
      }`;
  }
}

function formatAndOperand(expr: SpdxExpression, right = false): string {
  const text = formatSpdxExpression(expr);
  // OR binds looser than AND; a right-hand AND needs grouping to keep the
  // tree's shape, since chains associate to the left.
  if (expr.kind === "or" || (right && expr.kind === "and")) return `(${text})`;
  return text;
}

/** Every license and exception node in the tree, left to right. */
export function spdxLeaves(
  expr: SpdxExpression,
): Array<SpdxLicenseNode | SpdxWithNode> {
  if (expr.kind === "license" || expr.kind === "with") return [expr];
  return [...spdxLeaves(expr.left), ...spdxLeaves(expr.right)];
}
