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
 * Which commits a caller may read, as serve's changes feed filters them
 * (swamp-club#4089), shared by `GET changes` and the `commits.subscribe`
 * WebSocket feed (swamp-club#4120). A whole commit is hidden when any of its
 * ops is one the caller may not read; a commit with no intent-bearing op
 * (a lease commit) is read as its partition is. Only commits of serve's own
 * namespace are ever shown.
 *
 * @module
 */

import {
  type AggregateResourceResolver,
  partitionReadAccessOf,
  readAccessOf,
  type RequiredAccess,
} from "../domain/datastore_v3/commit_authorization.ts";
import type { CommitChange } from "../domain/datastore_v3/commit_store.ts";
import type { Op } from "../domain/datastore_v3/op.ts";
import type { PartitionKey } from "../domain/datastore_v3/partition_key.ts";
import type { AccessResource } from "../domain/access/access_decision_service.ts";
import type { Action } from "../domain/access/action.ts";
import { findDefinitionByIdGlobal } from "../domain/models/model_lookup.ts";
import type { ModelType } from "../domain/models/model_type.ts";
import { findWorkflowById } from "../domain/workflows/workflow_lookup.ts";
import type { V3Datastore } from "../infrastructure/datastore_v3/v3_datastore.ts";
import {
  type AccessCaller,
  callerResourceDecider,
  type ConnectionContext,
  isAdminOnlyModelType,
} from "./handlers/shared.ts";

/**
 * `commit` as a reader is sent it: without its lease ops for a reader that
 * does not understand them (swamp-club#4121), over `GET commits`, `GET
 * changes` and the `commits.subscribe` feed (swamp-club#4168). A swamp from
 * before them judges a lease op's fence against the writer fence; without
 * it, the commit is exactly what that swamp's own rules accept. Serve stamps
 * a lease op only beside a client's ops, so no commit is left empty.
 */
export function commitJSONFor(
  commit: CommitChange["commit"],
  leaseOps: boolean,
): unknown {
  const json = commit.toJSON() as { ops: readonly { kind?: unknown }[] };
  return leaseOps
    ? json
    : { ...json, ops: json.ops.filter((op) => op.kind !== "lease") };
}

/** What reading a commit to `partition` with `ops` requires. */
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
 * Decides which commits one caller may read, for one batch: its resolver
 * remembers aggregate lookups and its decisions are cached, so a long-lived
 * feed builds a fresh filter per batch, and a changed grant or a renamed
 * aggregate takes effect on the next one. A filter `unrestricted` (a team
 * peer's) skips the caller's grants but keeps the namespace.
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

  /** Whether the caller may read `change`. */
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
 * `resolver` with its aggregate lookups remembered for one request, so a
 * changes page costs one lookup per aggregate, not per op. Key owners and
 * restricted types are asked afresh.
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
  };
}

/** The resolver serve's datastore API authorises against. */
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
  };
}
