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
 * a whole commit is hidden when any op is unreadable to the caller; a commit
 * with no intent-bearing op (a lease commit) is read as its partition; only
 * serve's own namespace shows
 */

import {
  type AggregateResourceResolver,
  partitionReadAccessOf,
  readAccessOf,
  type RequiredAccess,
} from "../domain/datastore_v3/commit_authorization.ts";
import type { CommitChange } from "../domain/datastore_v3/commit_store.ts";
import type { Op } from "../domain/datastore_v3/op.ts";
import {
  type PartitionKey,
  partitionOf,
} from "../domain/datastore_v3/partition_key.ts";
import { ReadModelIncompleteError } from "../domain/datastore_v3/read_model.ts";
import type { AccessResource } from "../domain/access/access_decision_service.ts";
import type { Action } from "../domain/access/action.ts";
import { findDefinitionByIdGlobal } from "../domain/models/model_lookup.ts";
import type { ModelType } from "../domain/models/model_type.ts";
import { findWorkflowById } from "../domain/workflows/workflow_lookup.ts";
import {
  isGuardedRunRecord,
  WorkflowRunSchema,
} from "../domain/workflows/workflow_run.ts";
import type { V3Datastore } from "../infrastructure/datastore_v3/v3_datastore.ts";
import {
  type AccessCaller,
  callerResourceDecider,
  type ConnectionContext,
  isAdminOnlyModelType,
} from "./handlers/shared.ts";
import {
  MAX_CHECKED_CONTENT_BYTES,
  parseRecord,
} from "./forwarded_content_authorization.ts";

/**
 * drops lease ops and step starts for a reader that cannot read them; a commit
 * left with neither client op is skipped whole, as an unreadable one is
 */
export function commitJSONFor(
  commit: CommitChange["commit"],
  features: ReaderFeatures,
): unknown | undefined {
  const json = commit.toJSON() as {
    ops: readonly { kind?: unknown; intent?: { kind?: unknown } }[];
  };
  const ops = json.ops.filter((op) =>
    (features.leaseOps || op.kind !== "lease") &&
    (features.stepStarts || !isStepStartKind(op.intent?.kind))
  );
  if (ops.length === json.ops.length) return json;
  if (!ops.some((op) => op.kind !== "lease")) return undefined;
  return { ...json, ops };
}

export interface ReaderFeatures {
  readonly leaseOps: boolean;
  readonly stepStarts: boolean;
}

function isStepStartKind(kind: unknown): boolean {
  return kind === "run-start.save" || kind === "run-start.delete";
}

export async function commitReadAccessOf(
  partition: PartitionKey,
  ops: readonly Op[],
  resolver: AggregateResourceResolver,
): Promise<RequiredAccess[]> {
  const required: RequiredAccess[] = [];
  let intents = 0;
  for (const op of ops) {
    if (op.kind === "put" || op.kind === "tombstone") intents++;
    const access = await readAccessOf(op, resolver);
    if (access !== undefined) required.push(access);
  }
  // A commit with no intent-bearing op (serve's own lease commits) still
  // names its partition: it is read as the partition is.
  if (intents === 0) {
    for (const access of await partitionReadAccessOf(partition, resolver)) {
      required.push(access);
    }
  }
  return required;
}

/**
 * resolver lookups and decisions are cached, so a long-lived feed builds a
 * fresh filter per batch and grant or rename changes take effect next batch;
 * unrestricted skips grants but keeps the namespace
 */
export class CommitReadFilter {
  readonly #v3: V3Datastore;
  readonly #access: AccessCaller | "unrestricted";
  readonly #ctx: ConnectionContext;
  readonly #resolver: AggregateResourceResolver;
  readonly #readers = new Map<Action, (resource: AccessResource) => boolean>();

  constructor(
    v3: V3Datastore,
    access: AccessCaller | "unrestricted",
    ctx: ConnectionContext,
  ) {
    this.#v3 = v3;
    this.#access = access;
    this.#ctx = ctx;
    this.#resolver = memoized(serveResolver(ctx, v3));
  }

  async readable(change: CommitChange): Promise<boolean> {
    if (change.commit.namespace !== this.#v3.namespace) return false;
    const access = this.#access;
    if (access === "unrestricted") return true;
    const required = await commitReadAccessOf(
      change.commit.partition,
      change.commit.ops,
      this.#resolver,
    );
    return required.every(({ action, resource }) => {
      let decide = this.#readers.get(action);
      if (decide === undefined) {
        decide = callerResourceDecider(access, action, this.#ctx);
        this.#readers.set(action, decide);
      }
      return decide(resource);
    });
  }
}

/**
 * remembers aggregate lookups for one request so a page costs one lookup per
 * aggregate, not per op; key owners and restricted types are asked afresh
 */
export function memoized(
  resolver: AggregateResourceResolver,
): AggregateResourceResolver {
  const models = new Map<
    string,
    ReturnType<AggregateResourceResolver["model"]>
  >();
  const workflows = new Map<
    string,
    ReturnType<AggregateResourceResolver["workflow"]>
  >();
  const tags = new Map<
    string,
    ReturnType<AggregateResourceResolver["definitionTags"]>
  >();
  const remember = <T>(map: Map<string, T>, key: string, load: () => T): T => {
    let value = map.get(key);
    if (value === undefined) {
      value = load();
      map.set(key, value);
    }
    return value;
  };
  return {
    model: (ref) =>
      remember(models, `${ref.type}\u0000${ref.id}`, () => resolver.model(ref)),
    workflow: (id) => remember(workflows, id, () => resolver.workflow(id)),
    definitionTags: (kind, name, type) =>
      remember(
        tags,
        `${kind}\u0000${name}\u0000${type?.normalized ?? ""}`,
        () => resolver.definitionTags(kind, name, type),
      ),
    keyOwner: (key) => resolver.keyOwner(key),
    isRestrictedType: (type) => resolver.isRestrictedType(type),
    runRecordGuarded: (workflowId, runId) =>
      resolver.runRecordGuarded(workflowId, runId),
  };
}

export function serveResolver(
  ctx: ConnectionContext,
  v3: V3Datastore,
): AggregateResourceResolver {
  const repos = ctx.repoContext;
  return {
    async model(ref) {
      const lookup = await findDefinitionByIdGlobal(
        repos.definitionRepo,
        ref.id,
      );
      // A definition of another type is not this behavior: the intent's type
      // is what the commit writes.
      return lookup !== null && lookup.type.normalized === ref.type
        ? lookup
        : undefined;
    },
    async definitionTags(kind, name, type) {
      switch (kind) {
        case "model": {
          if (type === undefined) return undefined;
          const definition = await repos.definitionRepo.findByName(type, name);
          return definition?.tags;
        }
        case "workflow":
          return (await repos.workflowRepo.findByName(name))?.tags;
        case "vault":
          return undefined;
      }
    },
    async workflow(workflowId) {
      const workflow = await findWorkflowById(repos.workflowRepo, workflowId);
      return workflow === null
        ? undefined
        : { name: workflow.name, tags: workflow.tags };
    },
    keyOwner(key) {
      return v3.readModel.fileOwner(v3.namespace, key);
    },
    isRestrictedType(type: ModelType) {
      return isAdminOnlyModelType(
        undefined,
        type.normalized,
        ctx.authConfig.restrictedModelTypes,
      );
    },
    runRecordGuarded: (workflowId, runId) =>
      storedRunRecordGuarded(v3, workflowId, runId),
  };
}

/**
 * every run record the run's partition holds is read, whatever directory its
 * key names; one that cannot be read or parsed counts as guarded
 */
export async function storedRunRecordGuarded(
  v3: V3Datastore,
  workflowId: string,
  runId: string,
): Promise<boolean> {
  const partition = partitionOf({ kind: "run", workflowId, runId });
  let records;
  try {
    records = await v3.readModel.liveRecords(v3.namespace, partition);
  } catch (error) {
    if (error instanceof ReadModelIncompleteError) return true;
    throw error;
  }
  const identity = partition.identity;
  if (identity.kind !== "run") return true;
  const recordName = `workflow-run-${identity.runId}.yaml`;
  for (const record of records) {
    const key = record.key.toString();
    const name = key.split("/").at(-1)?.toLowerCase();
    if (name !== recordName) continue;
    const found = await v3.readModel.recordBytes(
      v3.namespace,
      partition,
      key,
      MAX_CHECKED_CONTENT_BYTES,
    );
    if (found === undefined || found.record.sha256 !== record.sha256) {
      return true;
    }
    const parsed = WorkflowRunSchema.safeParse(parseRecord(found.bytes));
    if (!parsed.success || isGuardedRunRecord(parsed.data)) return true;
  }
  return false;
}
