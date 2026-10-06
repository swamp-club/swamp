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
 * Authorizes expression text against the principal who supplies it: a writer
 * saving a definition or workflow, or a caller passing run inputs
 * (swamp-club#2755, swamp-club#2786). Stored content is never re-checked when
 * it runs or is evaluated, so a user running automation an admin wrote is
 * unaffected; only text a principal adds is held to what that principal may
 * read.
 */

import type { AccessResource } from "../../domain/access/access_decision_service.ts";
import type { Principal } from "../../domain/access/principal.ts";
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
import {
  type ConnectionContext,
  isAuthorized,
  isAuthorizedForAll,
} from "./shared.ts";

/**
 * Most distinct models the expressions of one request may name. Each is a
 * catalog query and a definition lookup; past this the request is judged as
 * reading any data, so caller text cannot make the check do unbounded work.
 */
export const MAX_EXPRESSION_TARGETS = 32;

/** How `env` reads in the expressions are judged. */
export type EnvAccess =
  /** The principal holds write on the model: env is theirs to author. */
  | "allowed"
  /** Run inputs from a principal without write on the model named. */
  | { refusedFor: string };

/** A refusal, worded the same whether the target exists or is denied. */
export interface ExpressionRefusal {
  readonly message: string;
}

/**
 * Checks `expressions` against `principal`. Returns the refusal for the
 * first expression that reads something the principal may not read, or
 * undefined when every one is allowed. Every refusal is audited; nothing is
 * sent, so the caller replies in its own error shape.
 */
export async function authorizeExpressionReferences(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
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
    allDataReadable ??= isAuthorizedForAll(
      socket,
      requestId,
      principal,
      "read",
      "data",
      ctx,
    );
  let allModelsReadable: boolean | undefined;
  const readsAllModels = () =>
    allModelsReadable ??= isAuthorizedForAll(
      socket,
      requestId,
      principal,
      "read",
      "model",
      ctx,
    );
  const distinct = new Set<string>();
  for (const { references } of expressions) {
    for (const t of references.dataTargets) distinct.add(`data:${t}`);
    for (const t of references.modelTargets) distinct.add(`model:${t}`);
  }
  const tooMany = distinct.size > MAX_EXPRESSION_TARGETS;

  for (const { raw, references } of expressions) {
    if (references.usesEnv && env !== "allowed") {
      return {
        message: `Access denied: expression ${shown(raw)} reads env, which ` +
          `is only available in ` +
          `run inputs to principals with write on ${env.refusedFor}; ` +
          `reference it in the model definition instead`,
      };
    }
    let allowed = true;
    if (tooMany) {
      // Past the cap no target is looked up one by one: the expressions are
      // judged as reading any data, and any model they name.
      allowed = readsAllData() &&
        (references.modelTargets.size === 0 || readsAllModels());
    } else if (references.dataWide) {
      allowed = readsAllData();
    }
    for (const target of tooMany ? [] : references.dataTargets) {
      if (!allowed) break;
      // A namespace prefix names another repository's data, which no
      // definition here describes; judge it as reading any data.
      if (target.includes(":")) {
        allowed = readsAllData();
        continue;
      }
      allowed = await memo(
        checked,
        `data:${target}`,
        () =>
          dataReadable(
            socket,
            requestId,
            principal,
            ctx,
            owners,
            definitions,
            target,
          ),
      );
    }
    for (const target of tooMany ? [] : references.modelTargets) {
      if (!allowed) break;
      allowed = await memo(
        checked,
        `model:${target}`,
        () =>
          modelReadable(socket, requestId, principal, ctx, definitions, target),
      );
    }
    if (!allowed) {
      return {
        message: `Access denied: expression ${shown(raw)} reads data or ` +
          `models that are not readable here; ask an admin for read on ` +
          `what it references`,
      };
    }
  }
  return undefined;
}

/** Longest expression text quoted in a refusal. */
export const MAX_SHOWN = 120;

/** `raw` for an error message, shortened past {@link MAX_SHOWN}. */
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
 * Whether the principal may read everything `data.*("<target>", ...)` can
 * return. The data accessors match records by the model name stored on
 * them, and fall back to the definition with that name or id, so both count:
 * the current owner of every record stored under the name, and the
 * definition the name resolves to. A name that matches neither is judged as
 * sent. Deny wins.
 */
async function dataReadable(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
  ctx: ConnectionContext,
  owners: CanonicalResources,
  definitions: DefinitionIndex,
  target: string,
): Promise<boolean> {
  const resources: AccessResource[] = [];
  const ns = ctx.repoContext.unifiedDataRepo.namespace;
  // Every version of a data item has the item's owner, so the latest
  // versions name every owner without reading the whole history. Records
  // of control-plane types are left out as the data.* accessors leave them
  // out; a control-plane definition with the name is still judged below,
  // as its access record.
  let records: DataRecord[];
  try {
    records = await ctx.repoContext.dataQueryService.query(
      `modelName == ${celString(target)} && ns == ${celString(ns)}`,
      { excludeModelTypes: CONTROL_PLANE_STORED_TYPES },
    ) as DataRecord[];
  } catch {
    // Owners that cannot be listed cannot be judged; refuse, as a failed
    // definition listing does.
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
    resources.push(unresolvedAccessResource("data", target));
  }
  return resources.every((resource) =>
    isAuthorized(socket, requestId, principal, "read", resource, ctx)
  );
}

/** Whether the principal may read the definition `model.<target>` exposes. */
async function modelReadable(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
  ctx: ConnectionContext,
  definitions: DefinitionIndex,
  target: string,
): Promise<boolean> {
  const named = await definitions(target);
  if (named === "failed") return false;
  const resources = named.length > 0
    ? named.map((definition) => modelAccessResource(definition, "model"))
    : [unresolvedAccessResource("model", target)];
  return resources.every((resource) =>
    isAuthorized(socket, requestId, principal, "read", resource, ctx)
  );
}

/**
 * Every definition `target` names, by name or by id, or "failed" when the
 * definitions cannot be listed. Evaluation reads every definition sharing a
 * name, so each one is judged, not only the first a lookup returns.
 */
type DefinitionIndex = (
  target: string,
) => Promise<DefinitionLookupResult[] | "failed">;

/** A {@link DefinitionIndex} that lists the definitions once per request. */
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
