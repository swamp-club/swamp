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

import {
  LEX_ERROR,
  lexSegments,
  LexState,
  lexStep,
} from "./cel_string_lexer.ts";
import { scanExpressions } from "./expression_scanner.ts";
import {
  analyzeVaultCalls,
  isDynamicVaultArgument,
} from "./vault_call_syntax.ts";
export { isDynamicVaultArgument } from "./vault_call_syntax.ts";
import type { SecretReference } from "../vaults/secret_bag_registry.ts";

/**
 * One `vault.get(vaultName, secretKey)` call, with balanced CEL arguments.
 * Keep the capture layout shared by the resolver and reference scanners.
 * Groups: [1]=quote1, [2]=quoted vault, [3]=unquoted vault,
 *         [4]=quote2, [5]=quoted key,   [6]=unquoted key
 */
function matchVaultGetCall(
  text: string,
  start: number,
): RegExpExecArray | undefined {
  if (!text.startsWith("vault.get(", start)) return undefined;
  const argsStart = start + "vault.get(".length;
  const closing = [")"];
  let comma: number | undefined;
  let argumentStarted = false;
  let state: LexState = LexState.Code;
  let pos = argsStart;
  while (pos < text.length) {
    if (state === LexState.Code) {
      const ch = text[pos];
      if (closing.length === 1 && !argumentStarted && !/\s/.test(ch)) {
        argumentStarted = true;
        // Legacy bare names can contain // without starting a CEL comment.
        // Consume a complete literal argument before entering the CEL lexer.
        const bare = /^[^\s,)]+(?=\s*[,)])/.exec(text.slice(pos))?.[0];
        if (bare && !isDynamicVaultArgument(bare) && !bare.startsWith("`")) {
          pos += bare.length;
          continue;
        }
      }
      // Backtick-quoted vault names predate CEL string syntax.
      if (ch === "`") {
        const end = text.indexOf("`", pos + 1);
        if (end === -1) return undefined;
        pos = end + 1;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") {
        closing.push(ch === "(" ? ")" : ch === "[" ? "]" : "}");
      } else if (ch === ")" || ch === "]" || ch === "}") {
        if (closing.pop() !== ch) return undefined;
        if (closing.length === 0) {
          if (comma === undefined) return undefined;
          const vault = text.slice(argsStart, comma).trim();
          const key = text.slice(comma + 1, pos).trim();
          if (!vault || !key) return undefined;
          return Object.assign([
            text.slice(start, pos + 1),
            ...vaultArgumentCaptures(vault),
            ...vaultArgumentCaptures(key),
          ], { index: start, input: text }) as RegExpExecArray;
        }
      } else if (ch === "," && closing.length === 1) {
        if (comma !== undefined) return undefined;
        comma = pos;
        argumentStarted = false;
      }
    }
    const [next, nextState] = lexStep(text, pos, state);
    if (next === LEX_ERROR) return undefined;
    pos = next;
    state = nextState;
  }
  return undefined;
}

/** A whole quoted argument, or the full CEL expression to evaluate. */
function vaultArgumentCaptures(argument: string): (string | undefined)[] {
  const segments = lexSegments(argument);
  const quoted = /^(['"`])([^]*?)\1$/.exec(argument);
  if (
    quoted && (quoted[1] === "`" ||
      (segments.length === 1 && segments[0].kind === "string" &&
        !argument.startsWith(quoted[1].repeat(3))))
  ) {
    return [quoted[1], quoted[2], undefined];
  }
  return [undefined, undefined, argument];
}

/**
 * Finds the `vault.get(...)` calls written as code in a CEL expression, in
 * order and without overlap. A call that starts inside a string literal or a
 * comment is text (`literal('vault.get(')`), and one reached through a member
 * (`self.vault.get(...)`, `self . vault.get(...)`) is not the vault
 * namespace. The resolver that fetches secrets and the serve allowlist both
 * read calls through this one matcher, so they always agree.
 */
export function findVaultGetCalls(celExpression: string): RegExpExecArray[] {
  const calls: RegExpExecArray[] = [];
  if (!celExpression.includes("vault")) return calls;
  let last = 0;
  for (const seg of lexSegments(celExpression)) {
    if (seg.kind !== "code") continue;
    let at = celExpression.indexOf("vault", seg.start);
    while (at !== -1 && at < seg.end) {
      if (at >= last && isNamespaceRoot(celExpression, at)) {
        const call = matchVaultGetCall(celExpression, at);
        if (call) {
          calls.push(call);
          last = at + call[0].length;
        }
      }
      at = celExpression.indexOf("vault", at + 5);
    }
  }
  return calls;
}

/** Whether `vault` at `at` is a root identifier rather than a member. */
function isNamespaceRoot(text: string, at: number): boolean {
  let i = at - 1;
  if (i >= 0 && /\w/.test(text[i])) return false;
  while (i >= 0 && /\s/.test(text[i])) i--;
  return !(i >= 0 && text[i] === ".");
}

/**
 * The name a `vault.get` argument stands for when it is known without
 * evaluating anything: a quoted argument, or an unquoted one that is not
 * dynamic (see {@link isDynamicVaultArgument}). Undefined for a dynamic one.
 */
function literalVaultArg(
  quoted: string | undefined,
  bare: string | undefined,
): string | undefined {
  if (quoted !== undefined) return quoted;
  return bare !== undefined && !isDynamicVaultArgument(bare) ? bare : undefined;
}

/** An analysis call restricted to the syntax the option-off resolver accepts. */
export interface AnalyzedVaultCall {
  readonly start: number;
  readonly end: number;
  readonly authored: string;
  readonly args: readonly {
    readonly text: string;
    readonly literal?: string;
  }[];
}

/**
 * Shared AST analysis with an option-off compatibility filter. Malformed CEL
 * still needs legacy attribution (vault.get(t, db..x) must fail at evaluation,
 * not pass through as foreign text). The resolver also replaces calls under
 * macro bindings without regard to shadowing. Preserve those legacy records
 * until rollout; new typed evaluation uses analyzeVaultCalls directly.
 */
export function vaultCallsForAnalysis(expression: string): AnalyzedVaultCall[] {
  const legacy = findVaultGetCalls(expression);
  if (legacy.length === 0) return [];
  let calls = new Map<number, AnalyzedVaultCall>();
  try {
    calls = new Map(
      analyzeVaultCalls(expression).calls.map((call) => [
        call.start,
        call,
      ]),
    );
  } catch {
    // Keep malformed legacy calls attributable to swamp.
  }
  return legacy.map((match) => {
    const call = calls.get(match.index);
    if (
      call?.end === match.index + match[0].length && call.args.length === 2 &&
      call.args[0].literal === literalVaultArg(match[2], match[3]) &&
      call.args[1].literal === literalVaultArg(match[5], match[6])
    ) return call;
    return {
      start: match.index,
      end: match.index + match[0].length,
      authored: match[0],
      args: [[match[2], match[3]], [match[5], match[6]]].map((
        [quoted, bare],
      ) => ({
        text: quoted !== undefined ? JSON.stringify(quoted) : bare,
        literal: literalVaultArg(quoted, bare),
      })),
    };
  });
}

export interface VaultReference {
  vaultName: string;
  secretKey: string;
}

export interface VaultExtractionResult {
  staticRefs: VaultReference[];
  hasDynamicRefs: boolean;
}

export function extractVaultReferences(
  ...dataSources: unknown[]
): VaultExtractionResult {
  const staticRefs: VaultReference[] = [];
  const seen = new Set<string>();
  let hasDynamicRefs = false;

  for (const data of dataSources) {
    collectVaultReferences(data, staticRefs, seen, (dynamic) => {
      if (dynamic) hasDynamicRefs = true;
    });
  }

  return { staticRefs, hasDynamicRefs };
}

/**
 * `result` with `references` admitted as static references: each one is
 * spelled as the extractor spells it and added unless already listed, in
 * order, with `hasDynamicRefs` unchanged. A workflow step's arguments reach
 * serve with their secrets resolved, so the references its secret bag holds
 * are admitted this way beside any expression still written in the
 * arguments (swamp-club#3529). With no references the input is returned.
 */
export function withVaultReferences(
  result: VaultExtractionResult,
  references: readonly SecretReference[] | undefined,
): VaultExtractionResult {
  if (references === undefined || references.length === 0) return result;
  const staticRefs = [...result.staticRefs];
  const seen = new Set(
    staticRefs.map((ref) => `${ref.vaultName}\u0000${ref.secretKey}`),
  );
  for (const { vaultName, key } of references) {
    const id = `${vaultName}\u0000${key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    staticRefs.push({ vaultName, secretKey: key });
  }
  return { staticRefs, hasDynamicRefs: result.hasDynamicRefs };
}

function collectVaultReferences(
  data: unknown,
  refs: VaultReference[],
  seen: Set<string>,
  onDynamic: (isDynamic: boolean) => void,
): void {
  if (typeof data === "string") {
    for (const span of scanExpressions(data)) {
      for (const call of vaultCallsForAnalysis(span.inner)) {
        const vaultName = call.args[0].literal;
        const secretKey = call.args[1].literal;

        if (vaultName !== undefined && secretKey !== undefined) {
          const key = `${vaultName}\0${secretKey}`;
          if (!seen.has(key)) {
            seen.add(key);
            refs.push({ vaultName, secretKey });
          }
        } else {
          onDynamic(true);
        }
      }
    }
  } else if (Array.isArray(data)) {
    for (const item of data) {
      collectVaultReferences(item, refs, seen, onDynamic);
    }
  } else if (data !== null && typeof data === "object") {
    for (const value of Object.values(data as Record<string, unknown>)) {
      collectVaultReferences(value, refs, seen, onDynamic);
    }
  }
}
