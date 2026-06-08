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

import type { Logger } from "@logtape/logtape";
import type { z } from "zod";
import type { VaultService } from "../vaults/vault_service.ts";

/**
 * Context passed to every creek method's `execute` function. Mirrors
 * `MethodContext` for model methods but is narrower because creeks only
 * read from external systems — they do not write data, declare resources,
 * or run inside an execution driver.
 */
export interface CreekMethodContext {
  /** Cancellation signal — forward to `fetch(...)` and other async work. */
  signal: AbortSignal;
  /** LogTape logger scoped to the creek invocation. */
  logger: Logger;
  /** Vault service for resolving secret references (e.g. API tokens). */
  vaultService?: VaultService;
  /**
   * Resolve a path to an asset declared in the extension's
   * `additionalFiles` manifest field. Same semantics as the
   * `MethodContext.extensionFile` helper. Throws when the creek was not
   * shipped via an extension manifest.
   */
  extensionFile: (relPath: string) => string;
}

/**
 * Definition of one method on a creek. Methods are the callable surface
 * exposed to CEL (e.g. `creek("@me/jira").issue("FOO-1")`).
 */
export interface CreekMethodDefinition<
  TArgs extends z.ZodTypeAny = z.ZodTypeAny,
  TReturns extends z.ZodTypeAny = z.ZodTypeAny,
> {
  /** Human-readable description of what the method returns. */
  description: string;
  /** Zod schema for the method's argument object. */
  arguments: TArgs;
  /** Optional Zod schema for the return value — used for warning-mode validation. */
  returns?: TReturns;
  /**
   * If true, return-value validation errors throw instead of just warning.
   * Default: false (warn and pass through).
   */
  strictReturns?: boolean;
  /** Execute the method and return its result. */
  execute(
    args: z.infer<TArgs>,
    context: CreekMethodContext,
  ): Promise<unknown>;
}

/**
 * Definition of a creek — an external-system wrapper registered as an
 * extension contribution kind. Authors construct one via {@link defineCreek}
 * and export it as `export const creek = defineCreek({ ... })`.
 */
export interface CreekDefinition {
  /** Scoped type identifier, e.g. `@me/jira`. */
  type: string;
  /** CalVer version string, e.g. `2026.06.01.1`. */
  version: string;
  /** Optional human-readable description. */
  description?: string;
  /** Map of method name → definition. */
  methods: Record<string, CreekMethodDefinition>;
}

/**
 * Public runtime interface for invoking creek methods from model code.
 * Returned by `MethodContext.creek(type)` and implemented by the
 * Proxy-wrapped `CelCreekHandle`.
 */
export interface CreekHandle {
  /** Invoke a creek method, returning its (possibly cached) result. */
  call(method: string, args: Record<string, unknown>): Promise<unknown>;
}

/**
 * Identity helper that gives authors strong type inference for method
 * argument schemas while documenting the creek contract. Does NOT
 * self-register — registration is the responsibility of the extension
 * loader (for shipped creeks) or the built-in barrel (for built-ins).
 */
export function defineCreek(definition: CreekDefinition): CreekDefinition {
  return definition;
}

/**
 * Identity helper that captures a method's argument schema type so that
 * `args` inside `execute` is typed as `z.infer<typeof arguments>` instead
 * of `unknown`. Use this when defining methods in a Record literal:
 *
 * ```ts
 * methods: {
 *   issue: defineCreekMethod({
 *     arguments: z.object({ key: z.string() }),
 *     execute: async (args, ctx) => { args.key; ... },
 *   }),
 * }
 * ```
 */
export function defineCreekMethod<
  TArgs extends z.ZodTypeAny,
  TReturns extends z.ZodTypeAny = z.ZodTypeAny,
>(
  definition: CreekMethodDefinition<TArgs, TReturns>,
): CreekMethodDefinition<TArgs, TReturns> {
  return definition;
}

/**
 * Metadata for a lazily-indexed creek type. The type is known to exist
 * (from the bundle catalog) but its bundle has not been imported yet.
 */
export interface LazyCreekEntry {
  type: string;
  bundlePath: string;
  sourcePath: string;
  version: string;
}
