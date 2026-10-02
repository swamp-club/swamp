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
 * Detects dynamic code execution — the global `eval`, the `Function`
 * constructor, and `.constructor(...)` calls — in TypeScript/JavaScript
 * source, for the extension safety gate.
 *
 * This is a hygiene gate, not a sandbox. It tokenizes the source so text in
 * comments, strings, template text and regex literals never counts, then
 * applies default-deny rules: an `eval` or `Function` token is flagged unless
 * it sits in a context positively identified as benign (a property name on an
 * ordinary object, a class member or object-literal key, a TypeScript type
 * position). Ambiguous contexts resolve toward flagging. Aliases built at
 * runtime (`globalThis["ev" + "al"]`) cannot be caught statically.
 *
 * The scan is a single linear pass with explicit stacks — no recursion and no
 * backtracking regexes over the input — because `extension pull` runs it on
 * untrusted archive sources.
 */

/** The form of dynamic code execution a finding reports. */
export type DynamicCodeKind =
  | "eval-reference"
  | "eval-computed-access"
  | "function-constructor"
  | "constructor-call";

/** One occurrence of dynamic code execution, 1-based line and column. */
export interface DynamicCodeFinding {
  line: number;
  column: number;
  kind: DynamicCodeKind;
}

type TokenType =
  | "ident"
  | "private"
  | "punct"
  | "string"
  | "template"
  | "number"
  | "regex";

type FrameKind =
  | "block"
  | "class"
  | "object"
  | "type"
  | "paren"
  | "bracket"
  | "tmpl";

interface Token {
  type: TokenType;
  /** Decoded name for identifiers, cooked value for strings and templates. */
  value: string;
  line: number;
  column: number;
  /** A line terminator separates this token from the previous one. */
  nl: boolean;
  /** Index of the innermost enclosing opener token, or -1 at top level. */
  frame: number;
  /** Frame kind this token opens (openers only). */
  opens?: FrameKind;
  /** Index of the matching opener/closer, or -1 when unmatched. */
  match: number;
  /** For `:` — what the colon separates. */
  colon?: "prop" | "ternary" | "other";
  /** For `}` — the kind of frame it closed. */
  closes?: FrameKind;
  /** Token is part of a TypeScript type declaration. */
  inType: boolean;
  /** For templates — the chunk is a whole template with no substitutions. */
  whole?: boolean;
}

interface Frame {
  opener: number;
  char: "{" | "(" | "[" | "${";
  kind: FrameKind;
  ternary: number;
  inType: boolean;
}

const GLOBAL_OBJECTS = new Set([
  "globalThis",
  "window",
  "self",
  "global",
  "frames",
  "parent",
  "top",
]);

// Keywords after which `/` starts a regex and `{` starts an expression.
const EXPRESSION_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

const OBJECT_AFTER_KEYWORDS = new Set([
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "await",
]);

const OBJECT_AFTER_PUNCT = new Set([
  "(",
  "[",
  ",",
  "=",
  "?",
  "...",
  "${",
  "+",
  "-",
  "*",
  "/",
  "%",
  "**",
  "<",
  ">",
  "<=",
  ">=",
  "==",
  "!=",
  "===",
  "!==",
  "&&",
  "||",
  "??",
  "!",
  "~",
  "&",
  "|",
  "^",
  "<<",
  ">>",
  ">>>",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "**=",
  "<<=",
  ">>=",
  ">>>=",
  "&=",
  "|=",
  "^=",
  "&&=",
  "||=",
  "??=",
]);

const CLASS_MODIFIERS = new Set([
  "static",
  "async",
  "get",
  "set",
  "public",
  "private",
  "protected",
  "readonly",
  "override",
  "abstract",
  "declare",
  "accessor",
]);

const OBJECT_MODIFIERS = new Set(["async", "get", "set"]);

// Tokens that continue a type alias across a line break.
const TYPE_CONTINUATION = new Set([
  "=",
  "|",
  "&",
  ",",
  "<",
  "?",
  ":",
  "=>",
  ".",
  "(",
  "[",
  "{",
  "extends",
  "keyof",
  "typeof",
  "infer",
  "readonly",
]);
const TYPE_LEADING_CONTINUATION = new Set([
  "|",
  "&",
  ".",
  "?",
  ":",
  "=>",
  "extends",
  ">",
  ")",
  "]",
  "}",
]);

const PUNCTUATORS = [
  ">>>=",
  "...",
  "===",
  "!==",
  "**=",
  "<<=",
  ">>=",
  ">>>",
  "&&=",
  "||=",
  "??=",
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "?.",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "%=",
  "&=",
  "|=",
  "^=",
  "**",
  "<<",
  ">>",
];

// Operators that can follow a variable named `type` in an expression.
const NOT_A_DECLARED_NAME = new Set([
  "in",
  "instanceof",
  "of",
  "as",
  "satisfies",
  "is",
  "extends",
  "keyof",
]);

const CALL_FORMS = new Set(["call", "apply", "bind"]);
const COMPUTED_NAMES = new Set(["eval", "Function"]);
const MAX_WALK_BACK = 64;

const ID_START = /[\p{ID_Start}$_]/u;
const ID_CONTINUE = /[\p{ID_Continue}$\u200c\u200d]/u;
const SPACE = /[\p{Zs}\t\v\f\ufeff]/u;

function isLineTerminator(ch: string): boolean {
  return ch === "\n" || ch === "\r" || ch === "\u2028" || ch === "\u2029";
}

function isIdStart(cp: number): boolean {
  if (cp < 128) {
    return (cp >= 97 && cp <= 122) || (cp >= 65 && cp <= 90) || cp === 36 ||
      cp === 95;
  }
  return ID_START.test(String.fromCodePoint(cp));
}

function isIdContinue(cp: number): boolean {
  if (cp < 128) {
    return (cp >= 97 && cp <= 122) || (cp >= 65 && cp <= 90) ||
      (cp >= 48 && cp <= 57) || cp === 36 || cp === 95;
  }
  return ID_CONTINUE.test(String.fromCodePoint(cp));
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= "0" && ch <= "9";
}

class Tokenizer {
  private pos = 0;
  private line = 1;
  private lineStart = 0;
  private sawNewline = false;
  private noRegexUntil = -1;
  readonly tokens: Token[] = [];
  private readonly frames: Frame[] = [];
  private readonly pendingClass: number[] = [];
  private pendingInterface = -1;
  private typeAlias:
    | { depth: number; active: boolean; named: boolean }
    | null = null;
  private lastQuestion = -1;
  /** Open ternaries outside any frame. */
  private rootTernary = 0;

  constructor(private readonly src: string) {}

  run(): Token[] {
    const src = this.src;
    if (src.startsWith("#!")) {
      while (this.pos < src.length && !isLineTerminator(src[this.pos])) {
        this.pos++;
      }
    }
    while (this.pos < src.length) {
      const ch = src[this.pos];
      if (isLineTerminator(ch)) {
        this.newline();
        continue;
      }
      if (ch === " " || SPACE.test(ch)) {
        this.pos++;
        continue;
      }
      if (ch === "/" && src[this.pos + 1] === "/") {
        while (this.pos < src.length && !isLineTerminator(src[this.pos])) {
          this.pos++;
        }
        continue;
      }
      if (ch === "/" && src[this.pos + 1] === "*") {
        this.blockComment();
        continue;
      }
      this.token();
    }
    return this.tokens;
  }

  private newline(): void {
    if (this.src[this.pos] === "\r" && this.src[this.pos + 1] === "\n") {
      this.pos++;
    }
    this.pos++;
    this.line++;
    this.lineStart = this.pos;
    this.sawNewline = true;
  }

  private blockComment(): void {
    const src = this.src;
    this.pos += 2;
    while (this.pos < src.length) {
      if (src[this.pos] === "*" && src[this.pos + 1] === "/") {
        this.pos += 2;
        return;
      }
      if (isLineTerminator(src[this.pos])) this.newline();
      else this.pos++;
    }
  }

  private token(): void {
    const src = this.src;
    const start = this.pos;
    const line = this.line;
    const column = start - this.lineStart + 1;
    const ch = src[start];
    const cp = src.codePointAt(start) ?? 0;

    if (isIdStart(cp) || (ch === "\\" && src[start + 1] === "u")) {
      const name = this.readIdentifier();
      // An invalid escape such as a lone `\u` reads nothing; consume it as
      // punctuation so the scan always advances.
      if (this.pos > start) {
        this.emit("ident", name, line, column);
        return;
      }
    }
    if (ch === "#") {
      const next = src.codePointAt(start + 1) ?? 0;
      this.pos++;
      if (isIdStart(next) || src[start + 1] === "\\") {
        this.emit("private", "#" + this.readIdentifier(), line, column);
      } else {
        this.emit("punct", "#", line, column);
      }
      return;
    }
    if (isDigit(ch) || (ch === "." && isDigit(src[start + 1]))) {
      this.readNumber();
      this.emit("number", src.slice(start, this.pos), line, column);
      return;
    }
    if (ch === "'" || ch === '"') {
      this.emit("string", this.readString(ch), line, column);
      return;
    }
    if (ch === "`") {
      this.pos++;
      this.readTemplateChunk(line, column, true);
      return;
    }
    if (ch === "/") {
      if (this.regexAllowed() && this.readRegex()) {
        this.emit("regex", src.slice(start, this.pos), line, column);
        return;
      }
      this.pos = start + (src[start + 1] === "=" ? 2 : 1);
      this.emit("punct", src.slice(start, this.pos), line, column);
      return;
    }
    for (const p of PUNCTUATORS) {
      if (src.startsWith(p, start)) {
        if (p === "?." && isDigit(src[start + 2])) continue;
        this.pos += p.length;
        this.emit("punct", p, line, column);
        return;
      }
    }
    this.pos += cp > 0xffff ? 2 : 1;
    this.emit("punct", String.fromCodePoint(cp), line, column);
  }

  private readIdentifier(): string {
    const src = this.src;
    let name = "";
    while (this.pos < src.length) {
      if (src[this.pos] === "\\" && src[this.pos + 1] === "u") {
        const decoded = this.readUnicodeEscape(this.pos + 2);
        if (decoded === null) break;
        name += decoded.text;
        this.pos = decoded.end;
        continue;
      }
      const cp = src.codePointAt(this.pos) ?? 0;
      if (!isIdContinue(cp)) break;
      name += String.fromCodePoint(cp);
      this.pos += cp > 0xffff ? 2 : 1;
    }
    return name;
  }

  /** Decodes `XXXX` or `{X...}` starting at `at` (just past `\u`). */
  private readUnicodeEscape(at: number): { text: string; end: number } | null {
    const src = this.src;
    if (src[at] === "{") {
      const close = src.indexOf("}", at);
      if (close === -1 || close - at > 8) return null;
      const cp = parseInt(src.slice(at + 1, close), 16);
      if (!Number.isFinite(cp) || cp > 0x10ffff) return null;
      return { text: String.fromCodePoint(cp), end: close + 1 };
    }
    const hex = src.slice(at, at + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
    return { text: String.fromCharCode(parseInt(hex, 16)), end: at + 4 };
  }

  private readNumber(): void {
    const src = this.src;
    const hex = src[this.pos] === "0" &&
      /[xXoObB]/.test(src[this.pos + 1] ?? "");
    while (this.pos < src.length) {
      const c = src[this.pos];
      if (/[0-9A-Za-z_]/.test(c)) {
        this.pos++;
        if (
          !hex && (c === "e" || c === "E") && /[+-]/.test(src[this.pos] ?? "")
        ) {
          this.pos++;
        }
      } else if (c === "." && src[this.pos + 1] !== ".") {
        this.pos++;
      } else {
        break;
      }
    }
  }

  private readString(quote: string): string {
    const src = this.src;
    this.pos++;
    let value = "";
    while (this.pos < src.length) {
      const c = src[this.pos];
      if (c === quote) {
        this.pos++;
        return value;
      }
      if (c === "\\") {
        value += this.readEscape();
        continue;
      }
      if (c === "\n" || c === "\r") return value; // unterminated
      value += c;
      this.pos++;
    }
    return value;
  }

  /** Reads an escape at `\`, returning its cooked text. */
  private readEscape(): string {
    const src = this.src;
    const c = src[this.pos + 1];
    if (c === undefined) {
      this.pos++;
      return "";
    }
    if (isLineTerminator(c)) {
      this.pos++;
      this.newline();
      return "";
    }
    if (c === "u") {
      const decoded = this.readUnicodeEscape(this.pos + 2);
      if (decoded) {
        this.pos = decoded.end;
        return decoded.text;
      }
    }
    if (
      c === "x" &&
      /^[0-9a-fA-F]{2}$/.test(src.slice(this.pos + 2, this.pos + 4))
    ) {
      const text = String.fromCharCode(
        parseInt(src.slice(this.pos + 2, this.pos + 4), 16),
      );
      this.pos += 4;
      return text;
    }
    this.pos += 2;
    const simple: Record<string, string> = {
      n: "\n",
      r: "\r",
      t: "\t",
      b: "\b",
      f: "\f",
      v: "\v",
      "0": "\0",
    };
    return simple[c] ?? c;
  }

  /**
   * Reads template text up to the closing backtick or a `${`. `first` is true
   * for the chunk right after the opening backtick.
   */
  private readTemplateChunk(
    line: number,
    column: number,
    first: boolean,
  ): void {
    const src = this.src;
    let value = "";
    while (this.pos < src.length) {
      const c = src[this.pos];
      if (c === "`") {
        this.pos++;
        const t = this.emit("template", value, line, column);
        t.whole = first;
        return;
      }
      if (c === "$" && src[this.pos + 1] === "{") {
        this.emit("template", value, line, column);
        const subLine = this.line;
        const subColumn = this.pos - this.lineStart + 1;
        this.pos += 2;
        this.emit("punct", "${", subLine, subColumn);
        return;
      }
      if (c === "\\") {
        value += this.readEscape();
        continue;
      }
      if (isLineTerminator(c)) {
        value += "\n";
        this.newline();
        continue;
      }
      value += c;
      this.pos++;
    }
    this.emit("template", value, line, column);
  }

  private regexAllowed(): boolean {
    if (this.pos < this.noRegexUntil) return false;
    const prev = this.tokens[this.tokens.length - 1];
    if (!prev) return true;
    switch (prev.type) {
      case "number":
      case "string":
      case "template":
      case "regex":
      case "private":
        return false;
      case "ident":
        return EXPRESSION_KEYWORDS.has(prev.value);
      case "punct":
        if (prev.value === ")" || prev.value === "]") return false;
        if (prev.value === "++" || prev.value === "--") return false;
        if (prev.value === "}") {
          return prev.closes === "block" || prev.closes === "class";
        }
        return true;
    }
  }

  /** Reads a regex literal at `/`; false (position unchanged) if none. */
  private readRegex(): boolean {
    const src = this.src;
    const start = this.pos;
    let i = start + 1;
    let inClass = false;
    while (i < src.length) {
      const c = src[i];
      if (isLineTerminator(c)) break;
      if (c === "\\") {
        if (i + 1 < src.length && isLineTerminator(src[i + 1])) break;
        i += 2;
        continue;
      }
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) {
        i++;
        while (i < src.length && isIdContinue(src.codePointAt(i) ?? 0)) i++;
        this.pos = i;
        return true;
      }
      i++;
    }
    // Not a regex: a later `/` on this line cannot start one either.
    this.noRegexUntil = i;
    return false;
  }

  private emit(
    type: TokenType,
    value: string,
    line: number,
    column: number,
  ): Token {
    const tokens = this.tokens;
    const index = tokens.length;
    const prev = tokens[index - 1];
    const top = this.frames[this.frames.length - 1];
    const token: Token = {
      type,
      value,
      line,
      column,
      nl: this.sawNewline,
      frame: top ? top.opener : -1,
      match: -1,
      inType: false,
    };
    this.sawNewline = false;
    tokens.push(token);

    // A `?` directly followed by these is a TS optional marker, not a ternary.
    if (this.lastQuestion === index - 1) {
      if (type === "punct" && [":", ")", ",", "=", ";"].includes(value)) {
        if (top) top.ternary--;
        else this.rootTernary--;
      }
    }

    this.updateTypeAlias(token, prev);

    // `type Name` / `interface Name` on one line at statement start is a
    // TypeScript declaration; elsewhere `type` is an ordinary variable.
    if (
      type === "ident" && prev?.type === "ident" && !token.nl &&
      !NOT_A_DECLARED_NAME.has(value)
    ) {
      const before = tokens[index - 2];
      const declared = prev.nl || !before ||
        (before.type === "punct" &&
          (before.value === ";" || before.value === "{" ||
            before.value === "}")) ||
        (before.type === "ident" &&
          (before.value === "export" || before.value === "declare"));
      if (declared && prev.value === "interface") {
        this.pendingInterface = this.frames.length;
        prev.inType = true;
      } else if (declared && prev.value === "type" && !this.typeAlias) {
        this.typeAlias = {
          depth: this.frames.length,
          active: false,
          named: true,
        };
      }
    }

    token.inType = (top?.inType ?? false) ||
      this.pendingInterface === this.frames.length ||
      (this.typeAlias?.active ?? false);

    if (type === "ident" && value === "class") {
      const memberName = prev?.type === "punct" &&
        (prev.value === "." || prev.value === "?.");
      if (!memberName) this.pendingClass.push(this.frames.length);
    }

    if (type !== "punct") return token;

    switch (value) {
      case "?":
        if (top) top.ternary++;
        else this.rootTernary++;
        this.lastQuestion = index;
        break;
      case ":":
        if (top && top.ternary > 0) {
          token.colon = "ternary";
          top.ternary--;
        } else if (!top && this.rootTernary > 0) {
          token.colon = "ternary";
          this.rootTernary--;
        } else if (top?.kind === "object") {
          token.colon = "prop";
        } else {
          token.colon = "other";
        }
        break;
      case "(":
        this.push(index, "(", "paren");
        break;
      case "[":
        this.push(index, "[", "bracket");
        break;
      case "${":
        this.push(index, "${", "tmpl");
        break;
      case "{":
        this.push(index, "{", this.classifyBrace(token, prev));
        break;
      case ")":
        this.close(index, "(");
        break;
      case "]":
        this.close(index, "[");
        break;
      case "}":
        if (top?.char === "${") {
          this.close(index, "${");
          this.readTemplateChunk(
            this.line,
            this.pos - this.lineStart + 1,
            false,
          );
        } else {
          this.close(index, "{");
        }
        break;
    }
    return token;
  }

  private classifyBrace(token: Token, prev: Token | undefined): FrameKind {
    const depth = this.frames.length;
    if (this.pendingInterface === depth) {
      this.pendingInterface = -1;
      token.inType = true;
      return "type";
    }
    if (token.inType) return "type";
    if (this.pendingClass[this.pendingClass.length - 1] === depth) {
      this.pendingClass.pop();
      return "class";
    }
    if (!prev) return "block";
    if (prev.type === "punct") {
      if (prev.value === ":") {
        return prev.colon === "prop" || prev.colon === "ternary"
          ? "object"
          : "block";
      }
      return OBJECT_AFTER_PUNCT.has(prev.value) ? "object" : "block";
    }
    if (prev.type === "ident") {
      if ((prev.value === "return" || prev.value === "yield") && !token.nl) {
        return "object";
      }
      if (OBJECT_AFTER_KEYWORDS.has(prev.value)) return "object";
      const before = this.tokens[this.tokens.length - 3];
      if (
        prev.value === "default" && before?.type === "ident" &&
        before.value === "export"
      ) {
        return "object";
      }
    }
    return "block";
  }

  private push(opener: number, char: Frame["char"], kind: FrameKind): void {
    const top = this.frames[this.frames.length - 1];
    this.tokens[opener].opens = kind;
    this.frames.push({
      opener,
      char,
      kind,
      ternary: 0,
      inType: kind === "type" || (top?.inType ?? false) ||
        (this.typeAlias?.active ?? false),
    });
  }

  private close(index: number, char: Frame["char"]): void {
    const top = this.frames[this.frames.length - 1];
    if (!top || top.char !== char) return;
    this.frames.pop();
    const token = this.tokens[index];
    token.match = top.opener;
    token.frame = this.frames.length > 0
      ? this.frames[this.frames.length - 1].opener
      : -1;
    this.tokens[top.opener].match = index;
    if (char === "{") token.closes = top.kind;
    if (this.pendingClass[this.pendingClass.length - 1] > this.frames.length) {
      this.pendingClass.pop();
    }
    if (this.pendingInterface > this.frames.length) this.pendingInterface = -1;
  }

  private updateTypeAlias(token: Token, prev: Token | undefined): void {
    const alias = this.typeAlias;
    if (!alias) return;
    const depth = this.frames.length;
    const atDepth = depth === alias.depth;
    const isPunct = token.type === "punct";
    if (depth < alias.depth) {
      this.typeAlias = null;
      return;
    }
    if (!alias.active) {
      // The token right after the name must be `=` or the `<` of a
      // generic parameter list.
      if (alias.named) {
        alias.named = false;
        if (!(isPunct && (token.value === "=" || token.value === "<"))) {
          this.typeAlias = null;
          return;
        }
      }
      if (atDepth && isPunct && token.value === "=") {
        alias.active = true;
      } else if (
        atDepth &&
        (token.nl || (isPunct && (token.value === ";" || token.value === "{")))
      ) {
        this.typeAlias = null;
      }
      return;
    }
    if (atDepth && isPunct && token.value === ";") {
      this.typeAlias = null;
      return;
    }
    if (
      atDepth && token.nl && prev && !TYPE_CONTINUATION.has(prev.value) &&
      !TYPE_LEADING_CONTINUATION.has(token.value)
    ) {
      this.typeAlias = null;
    }
  }
}

function isDot(t: Token | undefined): boolean {
  return t?.type === "punct" && (t.value === "." || t.value === "?.");
}

function isPunct(t: Token | undefined, value: string): boolean {
  return t?.type === "punct" && t.value === value;
}

function isIdent(t: Token | undefined, value?: string): boolean {
  return t?.type === "ident" && (value === undefined || t.value === value);
}

function isOperandEnd(t: Token | undefined): boolean {
  if (!t) return false;
  switch (t.type) {
    case "ident":
      return !EXPRESSION_KEYWORDS.has(t.value);
    case "punct":
      return t.value === ")" || t.value === "]" || t.value === "}";
    default:
      return true;
  }
}

class Analyzer {
  private readonly findings: DynamicCodeFinding[] = [];
  /** Per opener index: the frame is a destructuring pattern. */
  private readonly pattern: boolean[] = [];

  constructor(private readonly tokens: Token[]) {}

  run(): DynamicCodeFinding[] {
    const tokens = this.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.opens === "object" || t.opens === "bracket") {
        this.pattern[i] = this.computePattern(i);
      }
      if (t.inType) continue;
      if (t.type === "ident") {
        if (t.value === "eval") this.checkEval(i);
        else if (t.value === "Function") this.checkFunction(i);
        else if (t.value === "constructor") this.checkConstructor(i);
      } else if (isPunct(t, "[")) {
        this.checkComputed(i);
      }
    }
    return this.findings;
  }

  private flag(i: number, kind: DynamicCodeKind): void {
    const t = this.tokens[i];
    this.findings.push({ line: t.line, column: t.column, kind });
  }

  private frameKind(i: number): FrameKind {
    const opener = this.tokens[i].frame;
    if (opener < 0) return "block";
    return this.tokens[opener].opens ?? "block";
  }

  /** Forward pass: parents are always computed before their children. */
  private computePattern(opener: number): boolean {
    const tokens = this.tokens;
    const close = tokens[opener].match;
    if (close >= 0) {
      const after = tokens[close + 1];
      if (isPunct(after, "=") || isIdent(after, "of")) return true;
    }
    const parent = tokens[opener].frame;
    if (parent < 0) return false;
    const parentToken = tokens[parent];
    if (parentToken.opens === "object" || parentToken.opens === "bracket") {
      return this.pattern[parent] ?? false;
    }
    if (parentToken.opens === "paren" && parentToken.match >= 0) {
      const after = tokens[parentToken.match + 1];
      return isPunct(after, "{") || isPunct(after, "=>") || isPunct(after, ":");
    }
    return false;
  }

  /** `obj.name` where `obj` is a global-object name (or a paren group ending in one). */
  private isGlobalMember(i: number): boolean {
    const tokens = this.tokens;
    const at = isPunct(tokens[i - 2], ")") ? i - 3 : i - 2;
    const obj = tokens[at];
    return obj?.type === "ident" && GLOBAL_OBJECTS.has(obj.value) &&
      !isDot(tokens[at - 1]);
  }

  /** The identifier at `i` is a member name in a class body or object literal. */
  private isMemberName(i: number): boolean {
    const tokens = this.tokens;
    const kind = this.frameKind(i);
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    if (kind === "class") {
      if (
        isPunct(prev, "{") || isPunct(prev, ";") || isPunct(prev, "}") ||
        isPunct(prev, "*")
      ) {
        return true;
      }
      if (prev?.type === "ident" && CLASS_MODIFIERS.has(prev.value)) {
        return true;
      }
      return tokens[i].nl && isOperandEnd(prev);
    }
    if (kind !== "object" || this.pattern[tokens[i].frame]) return false;
    const atMember = isPunct(prev, "{") || isPunct(prev, ",") ||
      isPunct(prev, "*") ||
      (prev?.type === "ident" && OBJECT_MODIFIERS.has(prev.value) &&
        (isPunct(tokens[i - 2], "{") || isPunct(tokens[i - 2], ",")));
    if (!atMember) return false;
    if (isPunct(next, ":")) return true;
    if (isPunct(next, "?")) {
      return isPunct(tokens[i + 2], "(") || isPunct(tokens[i + 2], ":");
    }
    if (isPunct(next, "(") && next.match >= 0) {
      const after = tokens[next.match + 1];
      if (isPunct(after, ":")) return true;
      if (isPunct(after, "{") && after.match >= 0) {
        const end = tokens[after.match + 1];
        return isPunct(end, ",") || isPunct(end, "}");
      }
    }
    return false;
  }

  private checkEval(i: number): void {
    const prev = this.tokens[i - 1];
    if (isDot(prev)) {
      if (this.isGlobalMember(i)) this.flag(i, "eval-reference");
      return;
    }
    if (isIdent(prev, "typeof")) return;
    if (this.isMemberName(i)) return;
    this.flag(i, "eval-reference");
  }

  private checkFunction(i: number): void {
    const tokens = this.tokens;
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    if (isDot(prev)) {
      if (this.isGlobalMember(i)) this.flag(i, "function-constructor");
      return;
    }
    if (this.isMemberName(i)) return;
    if (isIdent(prev, "new")) return this.flag(i, "function-constructor");
    if (isPunct(next, "(")) return this.flag(i, "function-constructor");
    if (isDot(next)) {
      const name = tokens[i + 2];
      if (
        name?.type === "ident" &&
        (CALL_FORMS.has(name.value) || name.value === "constructor")
      ) {
        return this.flag(i, "function-constructor");
      }
      if (
        isIdent(name, "prototype") && isDot(tokens[i + 3]) &&
        isIdent(tokens[i + 4], "constructor")
      ) {
        return this.flag(i, "function-constructor");
      }
      if (isPunct(name, "(")) return this.flag(i, "function-constructor");
      return;
    }
    if (isPunct(next, "[")) {
      if (!isPunct(tokens[i + 2], "]")) this.flag(i, "function-constructor");
      return;
    }
    if (prev?.type === "ident") {
      if (
        ["typeof", "instanceof", "keyof", "as", "satisfies", "is", "implements"]
          .includes(prev.value)
      ) {
        return;
      }
      if (prev.value === "extends") {
        if (isPunct(next, "{")) this.flag(i, "function-constructor");
        return;
      }
    }
    if (isPunct(prev, ":") && prev?.colon === "other") return;
    if (isPunct(prev, "<") || isPunct(prev, "|") || isPunct(prev, "&")) return;
    if (isPunct(next, ">") || isPunct(next, "|") || isPunct(next, "&")) return;
    this.flag(i, "function-constructor");
  }

  private checkConstructor(i: number): void {
    const tokens = this.tokens;
    if (!isDot(tokens[i - 1])) return;
    const next = tokens[i + 1];
    const called = isPunct(next, "(") ||
      (isDot(next) && tokens[i + 2]?.type === "ident" &&
        CALL_FORMS.has(tokens[i + 2].value));
    if (!called) return;
    if (isPunct(next, "(") && this.precededByNew(i)) return;
    this.flag(i, "constructor-call");
  }

  /** Walks back over the member chain ending at `.constructor` to find `new`. */
  private precededByNew(i: number): boolean {
    const tokens = this.tokens;
    let j = i - 1;
    for (let steps = 0; steps < MAX_WALK_BACK && j >= 0; steps++) {
      if (!isDot(tokens[j])) return isIdent(tokens[j], "new");
      j--;
      const operand = tokens[j];
      if (!operand) return false;
      if (isPunct(operand, "]")) {
        if (operand.match < 0) return false;
        j = operand.match - 1;
        if (!isOperandEnd(tokens[j])) return false;
        j = this.skipOperand(j);
        if (j < -1) return false;
        continue;
      }
      j = this.skipOperand(j);
      if (j < -1) return false;
    }
    return false;
  }

  /**
   * Skips one primary operand ending at `j` and returns the index before it,
   * or -2 when the operand is a call (so `new` cannot apply to the chain).
   */
  private skipOperand(j: number): number {
    const tokens = this.tokens;
    const t = tokens[j];
    if (isPunct(t, ")")) {
      if (t.match < 0) return -2;
      const before = tokens[t.match - 1];
      if (isOperandEnd(before) && !isIdent(before, "new")) return -2;
      return t.match - 1;
    }
    if (t.type === "ident" || t.type === "private") return j - 1;
    return -2;
  }

  private checkComputed(i: number): void {
    const tokens = this.tokens;
    const prev = tokens[i - 1];
    if (!isOperandEnd(prev) && !isPunct(prev, "?.")) return;
    const key = tokens[i + 1];
    if (!key || !isPunct(tokens[i + 2], "]")) return;
    const literal = key.type === "string" ||
      (key.type === "template" && key.whole);
    if (!literal) return;
    if (COMPUTED_NAMES.has(key.value)) {
      this.flag(i + 1, "eval-computed-access");
    } else if (key.value === "constructor" && isPunct(tokens[i + 3], "(")) {
      this.flag(i + 1, "constructor-call");
    }
  }
}

/**
 * Finds dynamic code execution in `source`. Never throws; unterminated
 * strings, templates, comments and regexes end at end of input.
 */
export function findDynamicCodeExecution(source: string): DynamicCodeFinding[] {
  const tokens = new Tokenizer(source).run();
  return new Analyzer(tokens).run();
}
