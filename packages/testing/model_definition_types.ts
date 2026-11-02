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
 * mirrors the canonical ModelDefinition shapes so authors can anchor inference
 * with `satisfies` or defineModel; `methods` is a Record<string,
 * MethodDefinition> like the canonical, which resolves TS7006 under strict
 * mode.
 */

import type { z } from "zod";
import type { MethodContext, MethodResult } from "./types.ts";

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

export interface FileOutputSpec {
  description?: string;
  contentType: string;
  lifetime?: string;
  garbageCollection?: number | string;
  streaming?: boolean;
  sensitiveOutput?: boolean;
  vaultName?: string;
}

export interface MethodDefinition<
  TArgs extends z.ZodTypeAny = z.ZodTypeAny,
  TGlobalArgs = Record<string, unknown>,
> {
  description: string;
  kind?: "create" | "read" | "update" | "delete" | "list" | "action";
  rollbackOnFailure?: boolean;
  arguments: TArgs;
  execute(
    args: z.infer<TArgs>,
    context: MethodContext<TGlobalArgs>,
  ): Promise<MethodResult>;
}

export interface CheckDefinition<TGlobalArgs = Record<string, unknown>> {
  description: string;
  labels?: string[];
  appliesTo?: string[];
  execute(context: MethodContext<TGlobalArgs>): Promise<CheckResult>;
}

export interface CheckResult {
  pass: boolean;
  errors?: string[];
  warnings?: string[];
}

export interface VersionUpgrade {
  toVersion: string;
  description: string;
  upgradeAttributes: (
    oldAttributes: Record<string, unknown>,
  ) => Record<string, unknown>;
}

/**
 * narrows context.globalArgs from the global-arguments schema; for per-method
 * args narrowing use defineModel instead of `satisfies`. Internal-only
 * canonical fields are omitted.
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
 * returns its input and narrows context.globalArgs, like `satisfies
 * ModelDefinition<...>`; args still widens to any in execute, so parse it with
 * the method's own schema.
 */
export function defineModel<TGlobalArgs extends z.ZodTypeAny>(
  def: ModelDefinition<TGlobalArgs>,
): ModelDefinition<TGlobalArgs> {
  return def;
}

/**
 * defineModel under the behavior spelling; pair it with `export const
 * behavior`, which swamp loads exactly as `export const model`.
 */
export const defineBehavior: typeof defineModel = defineModel;
