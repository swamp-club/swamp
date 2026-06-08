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

import type { Environment } from "cel-js";
import type { Logger } from "@logtape/logtape";
import type { CreekMethodContext } from "../../domain/creeks/creek.ts";
import type { CreekRegistry } from "../../domain/creeks/creek_registry.ts";
import {
  createCreekHandle,
  type CreekCallCache,
  stableHash,
} from "../../domain/creeks/creek_handle.ts";
import type { VaultService } from "../../domain/vaults/vault_service.ts";
import { InvalidExpressionError } from "../../domain/expressions/errors.ts";

/** Default recursion cap for `swamp.data(...)` invocations inside CEL. */
export const DEFAULT_MAX_CROSS_QUERY_DEPTH = 3;

/**
 * Dependencies required to register the cross-query CEL functions
 * (`creek(...)` and `swamp.data(...)`).
 */
export interface CrossQueryDeps {
  /** Registry to look up creek definitions and lazy entries from. */
  registry: CreekRegistry;
  /** Cancellation signal forwarded to creek method execute calls. */
  signal: AbortSignal;
  /** LogTape logger scoped to the current evaluation. */
  logger: Logger;
  /** Vault service forwarded to creek method execute calls. */
  vaultService?: VaultService;
  /**
   * Per-type extensionFile resolver. Receives the (raw) creek type and
   * returns the closure model methods use today. Optional — when omitted,
   * the helper throws when called inside an execute body.
   */
  extensionFileResolver?: (type: string) => (relPath: string) => string;
  /**
   * Runs a fresh inline `DataQueryService.query(predicate, select?)` and
   * returns the matching rows. Owned by DataQueryService; passed in here
   * so this module has no upward dependency.
   */
  swampDataQuery: (
    predicate: string,
    select: string | undefined,
    depth: number,
  ) => Promise<unknown[]>;
  /** Current recursion depth (defaults to 0 at the top-level query). */
  recursionDepth?: number;
  /** Max recursion depth before swamp.data(...) throws. */
  maxRecursionDepth?: number;
}

/**
 * Receiver type for the top-level `swamp` namespace exposed inside CEL.
 *
 * Holds the cross-query callback + a recursion-depth counter so nested
 * invocations can be capped without leaking state across queries.
 */
export class CelSwampNamespace {
  constructor(
    private readonly swampDataQuery: CrossQueryDeps["swampDataQuery"],
    private readonly depth: number,
    private readonly maxDepth: number,
  ) {}

  data(predicate: string, select?: string): Promise<unknown[]> {
    if (this.depth >= this.maxDepth) {
      throw new InvalidExpressionError(
        `swamp.data(...) recursion depth limit (${this.maxDepth}) exceeded. ` +
          "Restructure deeply nested cross-queries as workflow steps instead.",
        predicate,
      );
    }
    return this.swampDataQuery(predicate, select, this.depth + 1);
  }
}

/**
 * Result returned by {@link registerCrossQueryFunctions} so the caller can
 * thread the shared call cache and the namespace handle into per-row
 * evaluation contexts.
 */
export interface CrossQueryRegistration {
  /**
   * Per-query call cache shared between every `creek(...)` invocation in
   * the same top-level query. Reset by allocating a new instance for
   * each top-level query.
   */
  readonly callCache: CreekCallCache;
  /**
   * Singleton namespace value that callers inject as the `swamp` context
   * variable when evaluating expressions on this Environment.
   */
  readonly swampNamespace: CelSwampNamespace;
}

/**
 * Wires the `creek(type, method, args)` function and the
 * `CelSwampNamespace` receiver type onto an existing cel-js Environment.
 *
 * Idempotency: do NOT call twice on the same Environment — cel-js
 * `registerFunction` throws on duplicate signatures. Build a fresh
 * Environment per top-level query (see DataQueryService).
 */
export function registerCrossQueryFunctions(
  env: Environment,
  deps: CrossQueryDeps,
): CrossQueryRegistration {
  const callCache: CreekCallCache = new Map();
  const depth = deps.recursionDepth ?? 0;
  const maxDepth = deps.maxRecursionDepth ?? DEFAULT_MAX_CROSS_QUERY_DEPTH;

  const buildContext = (type: string): CreekMethodContext => ({
    signal: deps.signal,
    logger: deps.logger,
    vaultService: deps.vaultService,
    extensionFile: deps.extensionFileResolver?.(type) ?? ((p) => {
      throw new Error(
        `extensionFile("${p}") unavailable: creek "${type}" was not loaded through an extension manifest.`,
      );
    }),
  });

  // Per-(type, method, args) dispatch. Builds a handle on demand and reuses
  // the cache so the same call inside one query hits the network/method
  // body once. CEL signature is "creek(type, method, args)" — see the
  // class doc on CelCreekHandle for why we don't use a typed receiver.
  const creekFn = (
    type: string,
    method: string,
    args: unknown,
  ): Promise<unknown> => {
    const key = `${type.toLowerCase()}::${method}::${stableHash([args])}`;
    let pending = callCache.get(key);
    if (!pending) {
      const handle = createCreekHandle(
        type,
        callCache,
        deps.registry,
        buildContext(type),
      );
      // Route through `.call` so cache writes go through one path.
      pending = handle.call(
        method,
        args && typeof args === "object" && !Array.isArray(args)
          ? args as Record<string, unknown>
          : {},
      );
    }
    return pending;
  };

  env.registerFunction(
    "creek(string, string, dyn): dyn",
    (type: string, method: string, args: unknown) =>
      creekFn(type, method, args),
  );
  env.registerFunction(
    "creek(string, string): dyn",
    (type: string, method: string) => creekFn(type, method, {}),
  );

  // Swamp namespace for the inverse direction: `swamp.data(predicate)` and
  // `swamp.data(predicate, select)`.
  env.registerType("CelSwampNamespace", CelSwampNamespace);
  env.registerFunction(
    "CelSwampNamespace.data(string): dyn",
    (receiver: CelSwampNamespace, predicate: string) =>
      receiver.data(predicate),
  );
  env.registerFunction(
    "CelSwampNamespace.data(string, string): dyn",
    (receiver: CelSwampNamespace, predicate: string, select: string) =>
      receiver.data(predicate, select),
  );

  const swampNamespace = new CelSwampNamespace(
    deps.swampDataQuery,
    depth,
    maxDepth,
  );

  return { callCache, swampNamespace };
}

/**
 * Walks a raw CEL expression string and reports whether it references
 * either of the cross-query entry points. Used by DataQueryService to
 * decide whether per-row evaluation needs to switch to the async path.
 *
 * Conservatively text-based — the check is cheap and false positives
 * just force the async path (still correct, marginally slower).
 */
export function referencesCrossQuery(expression: string): boolean {
  return /\bcreek\s*\(/.test(expression) ||
    /\bswamp\s*\.\s*data\s*\(/.test(expression);
}
