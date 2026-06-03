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
 * Extension-author-facing model-definition types.
 *
 * These types mirror the canonical ModelDefinition / MethodDefinition shapes
 * in swamp's internal src/domain/models/model.ts so that extension authors
 * can anchor type inference on their own model literals via `satisfies`
 * (or the defineModel helper) without importing from internal paths.
 *
 * A compat test in swamp verifies that the testing-package types remain
 * assignable to the canonical types. The `methods` field on the testing
 * ModelDefinition deliberately uses `Record<string, MethodDefinition>` —
 * matching the canonical — so that `satisfies ModelDefinition<typeof Schema>`
 * contextually types execute parameters and resolves TS7006 under strict
 * mode. Per-method args narrowing is available through the defineModel
 * helper below.
 */

import type { z } from "zod";
import type { MethodContext, MethodResult } from "./types.ts";

/**
 * Resource output specification — structured JSON data validated by a
 * Zod schema. Mirrors the shape of swamp's canonical ResourceOutputSpec
 * from the extension-author perspective (lifetime and gc policy are
 * declared as strings/numbers rather than the canonical branded types).
 */
export interface ResourceOutputSpec<
  TSchema extends z.ZodTypeAny = z.ZodTypeAny,
> {
  description?: string;
  schema: TSchema;
  lifetime?: string;
  garbageCollection?: number | string;
  sensitiveOutput?: boolean;
  vaultName?: string;
  streaming?: boolean;
}

/**
 * File output specification — binary or text content identified by
 * content type.
 */
export interface FileOutputSpec {
  description?: string;
  contentType: string;
  lifetime?: string;
  garbageCollection?: number | string;
  streaming?: boolean;
  sensitiveOutput?: boolean;
  vaultName?: string;
}

/**
 * A single method on an extension model. Parameterised on the method's
 * own arguments Zod schema and (optionally) the model's global-arguments
 * inferred type — the second parameter lets `context.globalArgs` narrow
 * from `Record<string, unknown>` to the inferred global-arguments shape
 * when MethodDefinition is composed into a ModelDefinition that knows
 * its TGlobalArgs.
 */
export interface MethodDefinition<
  TArgs extends z.ZodTypeAny = z.ZodTypeAny,
  TGlobalArgs = Record<string, unknown>,
> {
  description: string;
  kind?: "create" | "read" | "update" | "delete" | "list" | "action";
  arguments: TArgs;
  execute(
    args: z.infer<TArgs>,
    context: MethodContext<TGlobalArgs>,
  ): Promise<MethodResult>;
}

/**
 * Pre-flight check definition — runs before mutating method execution.
 * Extension authors who define checks can use this shape; the context
 * is the same MethodContext that methods receive.
 */
export interface CheckDefinition<TGlobalArgs = Record<string, unknown>> {
  description: string;
  labels?: string[];
  appliesTo?: string[];
  execute(context: MethodContext<TGlobalArgs>): Promise<CheckResult>;
}

/** Result returned from a check execution. */
export interface CheckResult {
  pass: boolean;
  errors?: string[];
  warnings?: string[];
}

/** A version upgrade step for model definition attributes. */
export interface VersionUpgrade {
  toVersion: string;
  description: string;
  upgradeAttributes: (
    oldAttributes: Record<string, unknown>,
  ) => Record<string, unknown>;
}

/**
 * Extension-author-facing ModelDefinition.
 *
 * Parameterised on the global-arguments Zod schema so that
 * `satisfies ModelDefinition<typeof YourGlobalArgsSchema>` narrows
 * `context.globalArgs` inside every method's execute body from
 * `Record<string, unknown>` to the inferred shape of your schema.
 *
 * The `methods` field uses `Record<string, MethodDefinition<...>>` —
 * matching the canonical shape — which is enough to resolve TS7006
 * because each execute function gets contextually typed from the record
 * value type. For per-method args narrowing (where `args` inside `run`
 * is `z.infer<typeof RunArgsSchema>` rather than `z.infer<z.ZodTypeAny>`),
 * use the `defineModel` helper below instead of `satisfies`.
 *
 * Internal-only fields from the canonical ModelDefinition
 * (bundleSourceFactory, branded ModelType) are omitted — extension
 * authors never set them.
 */
export interface ModelDefinition<
  TGlobalArgs extends z.ZodTypeAny = z.ZodTypeAny,
> {
  type: string;
  version: string;
  globalArguments?: TGlobalArgs;
  resources?: Record<string, ResourceOutputSpec>;
  files?: Record<string, FileOutputSpec>;
  methods: Record<
    string,
    MethodDefinition<z.ZodTypeAny, z.infer<TGlobalArgs>>
  >;
  checks?: Record<string, CheckDefinition<z.infer<TGlobalArgs>>>;
  reports?: string[];
  upgrades?: VersionUpgrade[];
}

/**
 * Function-form alternative to `satisfies ModelDefinition<...>`.
 *
 * Behaves identically to the `satisfies` pattern — at runtime it returns
 * the input unchanged, and at type level it narrows `context.globalArgs`
 * to the inferred global-arguments shape. Use whichever form you prefer.
 *
 * Note on `args`: inside each method's execute body, `args` is typed
 * from the method's own `arguments` schema via contextual typing, but
 * because the model literal is inline (not a builder chain), TypeScript
 * widens `args` to `any` during the literal→generic match. Narrow it
 * at the top of each execute with the method's schema:
 *
 * ```ts
 * execute: async (args, context) => {
 *   const { bucket } = RunArgsSchema.parse(args);
 *   // use `bucket` with full type safety
 * }
 * ```
 *
 * @example
 * ```ts
 * const GlobalArgsSchema = z.object({ region: z.string() });
 *
 * export const model = defineModel({
 *   type: "@myorg/my-model",
 *   version: "2026.04.21.1",
 *   globalArguments: GlobalArgsSchema,
 *   methods: {
 *     run: {
 *       description: "Run the model",
 *       arguments: z.object({ bucket: z.string() }),
 *       execute: async (_args, context) => {
 *         // context.globalArgs narrows to { region: string }
 *         return { dataHandles: [] };
 *       },
 *     },
 *   },
 * });
 * ```
 */
export function defineModel<TGlobalArgs extends z.ZodTypeAny>(
  def: ModelDefinition<TGlobalArgs>,
): ModelDefinition<TGlobalArgs> {
  return def;
}
