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

import type { CreekHandle, CreekMethodContext } from "./creek.ts";
import type { CreekRegistry } from "./creek_registry.ts";

/**
 * Shared per-query cache of in-flight or completed creek method calls.
 * Keyed by `${typeLowercased}::${methodName}::${stableHash(args)}`.
 */
export type CreekCallCache = Map<string, Promise<unknown>>;

/**
 * Builds a deterministic JSON string from any value. Object keys are sorted
 * recursively so `{a:1, b:2}` and `{b:2, a:1}` produce the same hash and
 * therefore share the same cache entry.
 */
export function stableHash(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

/** Property names on the handle that bypass the dispatch Proxy. */
const RESERVED_PROPS = new Set<string | symbol>([
  "call",
  "then",
  "constructor",
  "toString",
  "toJSON",
  Symbol.toPrimitive,
  Symbol.iterator,
  Symbol.asyncIterator,
]);

/**
 * Builds a creek handle for one creek type, sharing the supplied call cache
 * with every other handle constructed against the same cache (so the cache
 * stays consistent across multiple `creek(...)` invocations inside a single
 * CEL expression).
 *
 * The returned object behaves two ways:
 *
 * - **CEL access**: property access returns a function that dispatches the
 *   property name as a creek method. `handle.issue({key: "X"})` calls
 *   `methods.issue.execute({key: "X"}, ctx)` through the cache.
 *
 * - **Programmatic access**: `handle.call("issue", {key: "X"})` does the
 *   same thing. This is the form model methods use via `ctx.creek(type)`.
 *
 * Argument convention: a single object argument is the supported v1 form.
 * The object is passed to the method's Zod schema for validation and then
 * to `execute(args, ctx)`. CEL expressions pass the object inline:
 * `creek("@me/jira").issue({key: name})`.
 */
export function createCreekHandle(
  type: string,
  cache: CreekCallCache,
  registry: CreekRegistry,
  ctx: CreekMethodContext,
): CreekHandle {
  const typeKey = type.toLowerCase();

  const invoke = async (
    method: string,
    args: unknown[],
  ): Promise<unknown> => {
    await registry.ensureTypeLoaded(typeKey);
    const def = registry.get(typeKey);
    if (!def) {
      throw new Error(`Unknown creek type: ${type}`);
    }
    const methodDef = def.methods[method];
    if (!methodDef) {
      throw new Error(
        `Unknown method "${method}" on creek "${type}". Available: ${
          Object.keys(def.methods).join(", ")
        }`,
      );
    }

    const rawArgs = args.length === 1 && isPlainObject(args[0])
      ? args[0]
      : args[0] ?? {};
    const parsed = methodDef.arguments.safeParse(rawArgs);
    if (!parsed.success) {
      throw new Error(
        `Invalid arguments for ${type}.${method}: ${parsed.error.message}`,
      );
    }

    const result = await methodDef.execute(parsed.data, ctx);

    if (methodDef.returns) {
      const validated = methodDef.returns.safeParse(result);
      if (!validated.success) {
        const msg =
          `creek ${type}.${method} returned data not matching declared schema: ${validated.error.message}`;
        if (methodDef.strictReturns) {
          throw new Error(msg);
        }
        ctx.logger.warn(msg);
      }
    }

    return result;
  };

  const dispatch = (method: string, args: unknown[]): Promise<unknown> => {
    const key = `${typeKey}::${method}::${stableHash(args)}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = invoke(method, args);
      cache.set(key, pending);
    }
    return pending;
  };

  const target: CreekHandle = {
    call(method: string, args: Record<string, unknown>): Promise<unknown> {
      return dispatch(method, [args]);
    },
  };

  return new Proxy(target, {
    get(t, prop, receiver) {
      if (RESERVED_PROPS.has(prop) || typeof prop !== "string") {
        return Reflect.get(t, prop, receiver);
      }
      return (...callArgs: unknown[]) => dispatch(prop, callArgs);
    },
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
