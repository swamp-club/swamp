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
 * Vault call syntax shared by CEL evaluation and parse-only consumers. This
 * module depends on the lexer, never on the template scanner (which itself
 * calls the grammar). It knows references and source locations, not Secrets.
 */
import { type ASTNode, Environment } from "cel-js";
import {
  LEX_ERROR,
  lexSegments,
  LexState,
  lexStep,
} from "./cel_string_lexer.ts";

export interface SourceEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** A rewritten expression with offsets mapped back to the authored text. */
export interface MappedCelSource {
  readonly text: string;
  readonly originalOffset: (offset: number) => number;
}

/** Applies disjoint edits; offsets at either end of an edit remain exact. */
export function editCelSource(
  source: string,
  edits: readonly SourceEdit[],
): MappedCelSource {
  const ordered = [...edits].sort((a, b) => a.start - b.start);
  let text = "";
  let last = 0;
  for (const edit of ordered) {
    if (edit.start < last) throw new Error("Overlapping CEL source edits");
    text += source.slice(last, edit.start) + edit.text;
    last = edit.end;
  }
  text += source.slice(last);
  return {
    text,
    originalOffset(offset) {
      let delta = 0;
      for (const edit of ordered) {
        const start = edit.start + delta;
        const end = start + edit.text.length;
        if (offset < start) break;
        if (offset < end) {
          return edit.start + Math.min(offset - start, edit.end - edit.start);
        }
        delta += edit.text.length - (edit.end - edit.start);
      }
      return offset - delta;
    },
  };
}

/** The legacy rule: only a bare token containing a member access is CEL. */
export function isDynamicVaultArgument(token: string): boolean {
  return token.includes(".");
}

interface CallSpan {
  start: number;
  end: number;
  args: { start: number; end: number }[];
}

/**
 * A single lexer walk finds argument boundaries, including nested calls and
 * containers. A backtick only quotes a legacy argument, never ordinary CEL.
 */
function callSpans(source: string): CallSpan[] {
  const calls: CallSpan[] = [];
  const frames: { close: string; call?: CallSpan; argument: number }[] = [];
  let state: LexState = LexState.Code;
  let pos = 0;
  let precedingCode = "";
  while (pos < source.length) {
    if (state === LexState.Code) {
      const ch = source[pos];
      const frame = frames.at(-1);
      // Legacy names can themselves contain CEL punctuation, even // or
      // quotes in a bare token. Recognize one complete literal argument before
      // feeding its contents to the CEL lexer. Nested CEL still uses the stack.
      if (frame?.call && source.slice(frame.argument, pos).trim() === "") {
        const rest = source.slice(pos);
        const token = /^(?:(['"`])(.+?)\1|[^\s,)]+)(?=\s*[,)])/.exec(rest)?.[0];
        if (token && literalArgument(token) !== undefined) {
          pos += token.length;
          precedingCode = token.at(-1)!;
          continue;
        }
      }
      if (
        ch === "`" && frame?.call &&
        source.slice(frame.argument, pos).trim() === ""
      ) {
        const end = source.indexOf("`", pos + 1);
        if (end === -1) break;
        pos = end + 1;
        precedingCode = "`";
        continue;
      }
      if (
        source.startsWith("vault", pos) && precedingCode !== "." &&
        (pos === 0 || !/\w/.test(source[pos - 1]))
      ) {
        const match = /^vault\s*\.\s*get\s*\(/.exec(source.slice(pos));
        if (match) {
          const start = pos;
          pos += match[0].length;
          precedingCode = "(";
          frames.push({
            close: ")",
            call: { start, end: 0, args: [] },
            argument: pos,
          });
          continue;
        }
      }
      if (ch === "(" || ch === "[" || ch === "{") {
        frames.push({
          close: ch === "(" ? ")" : ch === "[" ? "]" : "}",
          argument: pos + 1,
        });
      } else if (ch === "," && frame?.call) {
        frame.call.args.push({ start: frame.argument, end: pos });
        frame.argument = pos + 1;
      } else if (ch === ")" || ch === "]" || ch === "}") {
        if (frame?.close !== ch) break;
        frames.pop();
        if (frame.call) {
          frame.call.args.push({ start: frame.argument, end: pos });
          frame.call.end = pos + 1;
          calls.push(frame.call);
        }
      }
    }
    const [next, nextState] = lexStep(source, pos, state);
    if (next === LEX_ERROR) break;
    if (
      state === LexState.Code && nextState !== LexState.Comment &&
      !/\s/.test(source[pos])
    ) precedingCode = source[pos];
    pos = next;
    state = nextState;
  }
  return calls;
}

/**
 * Legacy literals retain their exact name, including backslashes: the old
 * resolver did not CEL-decode quoted names. Re-encoding a name is not a walk
 * of its contents, so text containing vault.get stays text.
 */
function literalArgument(text: string): string | undefined {
  const quoted = /^(['"`])(.+)\1$/.exec(text);
  if (quoted) return quoted[2];
  if (/^[^\s,()]+$/.test(text) && !isDynamicVaultArgument(text)) return text;
  return undefined;
}

/** Normalizes only arguments of direct calls, leaving all other text alone. */
export function rewriteVaultArguments(source: string): MappedCelSource {
  const edits: SourceEdit[] = [];
  for (const call of callSpans(source)) {
    if (call.args.length !== 2) continue;
    for (const arg of call.args) {
      const raw = source.slice(arg.start, arg.end);
      const trimmed = raw.trim();
      const value = literalArgument(trimmed);
      if (value === undefined) continue;
      const start = arg.start + raw.indexOf(trimmed);
      edits.push({
        start,
        end: start + trimmed.length,
        text: JSON.stringify(value),
      });
    }
  }
  return editCelSource(source, edits);
}

/** The existing model-name rewrite, now with authored offsets retained. */
export function rewriteHyphenatedModelRefs(source: string): MappedCelSource {
  const edits: SourceEdit[] = [];
  const pattern =
    /model\.([a-zA-Z0-9_]+-[a-zA-Z0-9_-]+)\.(input|resource|file|execution|definition)/g;
  for (const segment of lexSegments(source)) {
    if (segment.kind !== "code") continue;
    for (
      const match of source.slice(segment.start, segment.end).matchAll(pattern)
    ) {
      const start = segment.start + match.index;
      edits.push({
        start,
        end: start + match[0].length,
        text: `model["${match[1]}"].${match[2]}`,
      });
    }
  }
  return editCelSource(source, edits);
}

export function prepareVaultSource(source: string): MappedCelSource {
  const vaults = rewriteVaultArguments(source);
  const models = rewriteHyphenatedModelRefs(vaults.text);
  return {
    text: models.text,
    originalOffset: (offset) =>
      vaults.originalOffset(models.originalOffset(offset)),
  };
}

export interface VaultCallArgument {
  readonly node: ASTNode;
  /** Normalized CEL, ready for argument evaluation. */
  readonly text: string;
  readonly literal?: string;
}

export interface VaultGetCall {
  readonly node: ASTNode;
  readonly args: readonly VaultCallArgument[];
  readonly start: number;
  readonly end: number;
  readonly authored: string;
  /** Arguments are checked outside surrounding comprehensions and cel.bind. */
  readonly usesLocalBinding: boolean;
}

export interface VaultCallAnalysis {
  readonly source: MappedCelSource;
  readonly ast: ASTNode;
  /** Children before parents, so nested arguments can be checked first. */
  readonly calls: readonly VaultGetCall[];
  readonly invalidUses: readonly ASTNode[];
}

const grammar = new Environment({
  unlistedVariablesAreDyn: true,
  enableOptionalTypes: true,
});
const binders = new Set(["map", "filter", "all", "exists", "exists_one"]);

/** One AST extractor, independent of whether an expression will be executed. */
export function analyzeVaultCalls(expression: string): VaultCallAnalysis {
  const source = prepareVaultSource(expression);
  const ast = grammar.parse(source.text).ast;
  const calls: VaultGetCall[] = [];
  const invalidUses: ASTNode[] = [];
  const argumentScopes: { bound: ReadonlySet<string>; used: boolean }[] = [];
  const visit = (node: ASTNode, bound: ReadonlySet<string>): void => {
    switch (node.op) {
      case "value":
        return;
      case "id":
        for (const scope of argumentScopes) {
          if (scope.bound.has(node.args)) scope.used = true;
        }
        if (node.args === "vault" && !bound.has("vault")) {
          invalidUses.push(node);
        }
        return;
      case ".":
      case ".?":
        visit(node.args[0], bound);
        return;
      case "!_":
      case "-_":
        visit(node.args, bound);
        return;
      case "map":
        for (const [key, value] of node.args) {
          visit(key, bound);
          visit(value, bound);
        }
        return;
      case "call":
        for (const arg of node.args[1]) visit(arg, bound);
        return;
      case "rcall": {
        const [name, receiver, args] = node.args;
        if (
          name === "get" && receiver.op === "id" && receiver.args === "vault" &&
          !bound.has("vault")
        ) {
          const scope = { bound, used: false };
          argumentScopes.push(scope);
          for (const arg of args) visit(arg, bound);
          argumentScopes.pop();
          const start = source.originalOffset(node.start);
          const end = source.originalOffset(node.end);
          calls.push({
            node,
            start,
            end,
            authored: expression.slice(start, end),
            usesLocalBinding: scope.used,
            args: args.map((arg) => ({
              node: arg,
              text: source.text.slice(arg.start, arg.end),
              ...(arg.op === "value" && typeof arg.args === "string"
                ? { literal: arg.args }
                : {}),
            })),
          });
          return;
        }
        const first = args[0];
        if (
          name === "bind" && receiver.op === "id" && receiver.args === "cel" &&
          args.length === 3 && first?.op === "id"
        ) {
          visit(args[1], bound);
          visit(args[2], new Set(bound).add(first.args));
          return;
        }
        visit(receiver, bound);
        if (binders.has(name) && first?.op === "id") {
          for (const arg of args.slice(1)) {
            visit(arg, new Set(bound).add(first.args));
          }
        } else for (const arg of args) visit(arg, bound);
        return;
      }
      default:
        for (const child of node.args as ASTNode[]) visit(child, bound);
    }
  };
  visit(ast, new Set());
  return { source, ast, calls, invalidUses };
}
