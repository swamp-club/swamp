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
 * stored content is never re-checked when it runs, so a user running automation
 * an admin wrote is unaffected; only text a principal adds is held to what that
 * principal may read
 */

import type { AccessResource } from "../../domain/access/access_decision_service.ts";
import { celString } from "../../domain/data/data_query_command.ts";
import type { DataRecord } from "../../domain/data/data_record.ts";
import type { AnalyzedExpression } from "../../domain/expressions/expression_references.ts";
import { CONTROL_PLANE_STORED_TYPES } from "../../domain/models/control_plane_types.ts";
import type { DefinitionLookupResult } from "../../domain/models/model_lookup.ts";
import {
  type CanonicalResources,
  canonicalResources,
  modelAccessResource,
  unresolvedAccessResource,
} from "./resource_resolution.ts";
import type { ConnectionContext, RequestAuthority } from "./shared.ts";

/**
 * past the cap the request is judged as reading any data, so caller text cannot
 * make the check do unbounded work
 */
export const MAX_EXPRESSION_TARGETS = 32;

export type EnvAccess =
  | "allowed"
  | { refusedFor: string };

export interface ExpressionRefusal {
  readonly message: string;
}

export async function authorizeExpressionReferences(
  authority: RequestAuthority,
  ctx: ConnectionContext,
  expressions: readonly AnalyzedExpression[],
  env: EnvAccess,
): Promise<ExpressionRefusal | undefined> {
  if (expressions.length === 0) return undefined;
  const owners = canonicalResources(ctx);
  const definitions = definitionIndex(ctx);
  const checked = new Map<string, Promise<boolean>>();
  let allDataReadable: boolean | undefined;
  const readsAllData = () =>
    allDataReadable ??= authority.allowsAll("read", "data");
  let allModelsReadable: boolean | undefined;
  const readsAllModels = () =>
    allModelsReadable ??= authority.allowsAll("read", "model");
  const distinct = new Set<string>();
  for (const { references } of expressions) {
    for (const t of references.dataTargets) distinct.add(`data:${t}`);
    for (const t of references.modelTargets) distinct.add(`model:${t}`);
  }
  const tooMany = distinct.size > MAX_EXPRESSION_TARGETS;

  for (const { raw, references } of expressions) {
    if (references.usesEnv && env !== "allowed") {
      if (references.unanalyzable) {
        return {
          message: `Access denied: expression ${shown(raw)} could not be ` +
            `analyzed, and run inputs that may read env need write on ` +
            `${env.refusedFor}`,
        };
      }
      return {
        message: `Access denied: expression ${shown(raw)} reads env, which ` +
          `is only available in ` +
          `run inputs to principals with write on ${env.refusedFor}; ` +
          `reference it in the behavior definition instead`,
      };
    }
    let allowed = true;
    if (tooMany) {
      // past the cap no target is looked up one by one: the expressions are
      // judged as reading any data, and any model they name
      allowed = readsAllData() &&
        (references.modelTargets.size === 0 || readsAllModels());
    } else if (references.dataWide) {
      allowed = readsAllData();
    }
    for (const target of tooMany ? [] : references.dataTargets) {
      if (!allowed) break;
      // a namespace prefix names another repository's data, which no definition
      // here describes; judge it as reading any data
      if (target.includes(":")) {
        allowed = readsAllData();
        continue;
      }
      allowed = await memo(
        checked,
        `data:${target}`,
        () => dataReadable(authority, ctx, owners, definitions, target),
      );
    }
    for (const target of tooMany ? [] : references.modelTargets) {
      if (!allowed) break;
      allowed = await memo(
        checked,
        `model:${target}`,
        () => modelReadable(authority, definitions, target),
      );
    }
    if (!allowed) {
      return {
        message: `Access denied: expression ${shown(raw)} reads data or ` +
          `behaviors that are not readable here; ask an admin for read on ` +
          `what it references`,
      };
    }
  }
  return undefined;
}

export async function authorizeRunInputExpressions(
  authority: RequestAuthority,
  ctx: ConnectionContext,
  expressions: readonly AnalyzedExpression[],
  runOn: AccessResource,
): Promise<ExpressionRefusal | undefined> {
  if (expressions.length === 0) return undefined;
  const { methodName: _methodName, ...fields } = runOn.fields;
  // decided only when an input reads env, so a refusal is audited exactly when
  // it decides the request
  const writable = !expressions.some((e) => e.references.usesEnv) ||
    authority.allows("write", { ...runOn, fields });
  return await authorizeExpressionReferences(
    authority,
    ctx,
    expressions,
    writable ? "allowed" : { refusedFor: runOn.name },
  );
}

export const MAX_SHOWN = 120;

export function shown(raw: string): string {
  const flat = raw.replace(/\s+/g, " ");
  return flat.length > MAX_SHOWN ? `${flat.slice(0, MAX_SHOWN)}…` : flat;
}

function memo(
  cache: Map<string, Promise<boolean>>,
  key: string,
  check: () => Promise<boolean>,
): Promise<boolean> {
  let found = cache.get(key);
  if (!found) {
    found = check();
    cache.set(key, found);
  }
  return found;
}

/**
 * data accessors match records by stored model name and fall back to the
 * definition with that name or id, so both count: each record's owner and the
 * definition. A name matching neither needs all-data read.
 */
async function dataReadable(
  authority: RequestAuthority,
  ctx: ConnectionContext,
  owners: CanonicalResources,
  definitions: DefinitionIndex,
  target: string,
): Promise<boolean> {
  const resources: AccessResource[] = [];
  const ns = ctx.repoContext.unifiedDataRepo.namespace;
  // every version of a data item has the item's owner, so latest versions name
  // every owner without reading the history; control-plane records are left out
  // as data.* leaves them, their definition is judged below
  let records: DataRecord[];
  try {
    records = await ctx.repoContext.dataQueryService.query(
      `modelName == ${celString(target)} && ns == ${celString(ns)}`,
      { excludeModelTypes: CONTROL_PLANE_STORED_TYPES },
    ) as DataRecord[];
  } catch {
    // owners that cannot be listed cannot be judged; refuse, as a failed
    // definition listing does
    return false;
  }
  const seen = new Set<string>();
  for (const record of records) {
    const key = JSON.stringify([
      record.modelType,
      record.modelId,
      record.modelName,
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    const recordOwners = await owners.dataOwners({
      modelType: record.modelType,
      modelId: record.modelId,
      modelName: record.modelName,
    });
    for (const owner of recordOwners) resources.push(owner);
  }
  const named = await definitions(target);
  if (named === "failed") return false;
  for (const definition of named) {
    resources.push(modelAccessResource(definition, "data"));
  }
  if (resources.length === 0) {
    // nothing owns the name yet, so the reference will read whatever is stored
    // under it later, by anyone: judge it as reading any data
    return authority.allowsAll("read", "data");
  }
  return resources.every((resource) => authority.allows("read", resource));
}

async function modelReadable(
  authority: RequestAuthority,
  definitions: DefinitionIndex,
  target: string,
): Promise<boolean> {
  const named = await definitions(target);
  if (named === "failed") return false;
  const resources = named.length > 0
    ? named.map((definition) => modelAccessResource(definition, "model"))
    : [unresolvedAccessResource("model", target)];
  return resources.every((resource) => authority.allows("read", resource));
}

/**
 * evaluation reads every definition sharing a name, so each one is judged, not
 * only the first a lookup returns
 */
type DefinitionIndex = (
  target: string,
) => Promise<DefinitionLookupResult[] | "failed">;

function definitionIndex(ctx: ConnectionContext): DefinitionIndex {
  let all: Promise<DefinitionLookupResult[] | "failed"> | undefined;
  return async (target) => {
    all ??= ctx.repoContext.definitionRepo.findAllGlobal().catch(() =>
      "failed" as const
    );
    const listed = await all;
    if (listed === "failed") return "failed";
    return listed.filter(({ definition }) =>
      definition.name === target || definition.id === target
    );
  };
}
