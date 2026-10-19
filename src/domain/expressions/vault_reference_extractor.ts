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

import { lexSegments } from "./cel_string_lexer.ts";
import { scanExpressions } from "./expression_scanner.ts";
import {
  analyzeVaultCalls,
  isDynamicVaultArgument,
} from "./vault_call_syntax.ts";
export { isDynamicVaultArgument } from "./vault_call_syntax.ts";

/**
 * One `vault.get(vaultName, secretKey)` call. Each argument is quoted or a
 * bare token: `(['"`])(.+?)\1` reads a quoted argument, which may hold spaces
 * (`vault.get("infra", "Client ID")`), and `([^\s,)]+)` a bare one.
 * Groups: [1]=quote1, [2]=quoted vault, [3]=unquoted vault,
 *         [4]=quote2, [5]=quoted key,   [6]=unquoted key
 */
const VAULT_GET_CALL =
  /vault\.get\(\s*(?:(['"`])(.+?)\1|([^\s,)]+))\s*,\s*(?:(['"`])(.+?)\4|([^\s,)]+))\s*\)/y;

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
        VAULT_GET_CALL.lastIndex = at;
        const call = VAULT_GET_CALL.exec(celExpression);
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
    if (call?.end === match.index + match[0].length) return call;
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
