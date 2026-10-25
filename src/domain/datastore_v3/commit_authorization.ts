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
 * Authorises a forwarded commit op by op on its intents (swamp-club#3915).
 *
 * Serve accepts commits that a client built, so nothing in them is trusted.
 * {@link checkCommitBindings} applies the binding rules that need no
 * policy, and {@link authorizeCommit} adds key ownership and the access
 * decision of every op. The first refusal fails the whole commit. The
 * tables are in "Team mode: serve's datastore API" in
 * `design/enablers/datastores.md`.
 *
 * The service is pure: what it needs to know about aggregates (a behavior's
 * name and tags, a workflow's, a key's current owner) and the caller's
 * authority come in through ports.
 *
 * @module
 */

import type { AccessResource } from "../access/access_decision_service.ts";
import type { Action } from "../access/action.ts";
import {
  modelAccessResource,
  modelTypeFields,
  unresolvedAccessResource,
  vaultKindResource,
  workflowAccessResource,
} from "../access/access_resources.ts";
import { controlPlaneRecordResource } from "../access/control_plane_records.ts";
import { isControlPlaneModelType } from "../models/control_plane_types.ts";
import type { DefinitionLookupResult } from "../models/model_lookup.ts";
import { ModelType } from "../models/model_type.ts";
import {
  CONTROL_PLANE_INTENT_TYPES,
  type Intent,
  intentPartition,
  type ModelRef,
} from "./intent.ts";
import { bindKey, type KeyBindingRefusal } from "./intent_key_paths.ts";
import type { DataVersionOp, Op, PutOp, TombstoneOp } from "./op.ts";
import { type DefinitionKind, partitionOf } from "./partition_key.ts";
import type { PartitionKey } from "./partition_key.ts";

/** Why a forwarded commit was refused. */
export type CommitRefusalReason =
  | KeyBindingRefusal
  | "lease-op"
  | "intent-partition-mismatch"
  | "data-version-unpaired"
  | "definition-type-mismatch"
  | "key-owned-elsewhere"
  | "forbidden";

/** A refused op: the first one, by its index in the commit. */
export interface CommitRefusal {
  readonly ok: false;
  readonly reason: CommitRefusalReason;
  readonly opIndex: number;
  readonly message: string;
}

/** The outcome of authorising a commit. */
export type CommitAuthorization = { readonly ok: true } | CommitRefusal;

/** What a workflow resolves to, for its access resource. */
export interface ResolvedWorkflow {
  readonly name: string;
  readonly tags?: Record<string, string>;
}

/** A key's current owner in the commit store. */
export interface KeyOwnership {
  /** The partition whose put the key shows, or showed before removal. */
  readonly owner: string;
  /** False once the owner removed the key. */
  readonly present: boolean;
}

/**
 * What the authoriser needs to know about aggregates. Every lookup is by
 * the canonical identity an intent holds (a lowercased id), so the identity
 * authorised is the one the commit writes.
 */
export interface AggregateResourceResolver {
  /** A behavior's definition by its id, or undefined when none holds it. */
  model(ref: ModelRef): Promise<DefinitionLookupResult | undefined>;
  /**
   * A managed-config definition's current tags, by kind and name, and for a
   * behavior definition its type.
   */
  definitionTags(
    kind: DefinitionKind,
    name: string,
    type?: ModelType,
  ): Promise<Record<string, string> | undefined>;
  /** A workflow by its id. */
  workflow(workflowId: string): Promise<ResolvedWorkflow | undefined>;
  /** Who owns a record key now; undefined when no commit put it. */
  keyOwner(key: string): Promise<KeyOwnership | undefined>;
  /** Whether a behavior type is restricted to admins on this server. */
  isRestrictedType(type: ModelType): boolean;
}

/**
 * The caller's authority: whether it may take `action` on `resource`. Serve
 * answers it as it answers every request, including its admin fallback.
 */
export interface CallerAuthority {
  /**
   * With `every`, the decision covers every resource of the kind, as
   * serve's kind-wide operations decide it: any deny for the kind refuses.
   */
  allows(action: Action, resource: AccessResource, every?: boolean): boolean;
}

/** Everything a write needs authorised on, besides the ops' bindings. */
export interface RequiredAccess {
  readonly action: Action;
  readonly resource: AccessResource;
  /** Decided for every resource of the kind (`resource` is `<kind>:*`). */
  readonly every?: true;
}

/**
 * Puts whose content serve checks, or trusts, beyond the write itself: a
 * behavior or workflow definition (retags, renames, the expressions and
 * steps an edit adds), a vault config (a vault is found by the name its
 * content declares, not the intent's), an auto-definition, and the
 * evaluated files and run snapshots serve reads back when it runs one. A forwarded commit cannot
 * have its content checked as serve's handlers check it yet, so these need
 * admin (swamp-club#3915) until swamp-club#3922 adds that.
 */
const CONTENT_CHECKED_PUTS: ReadonlySet<string> = new Set([
  "definition.create",
  "definition.edit",
  "definition.rename-to",
  "evaluated-workflow.save",
  "evaluated-definition.save",
  "auto-definition.save",
  "run-snapshot.save",
]);

/** The resource every admin-only operation is decided on. */
const ADMIN_RESOURCE: AccessResource = {
  kind: "access",
  name: "*",
  fields: {},
};

/**
 * The binding rules that need no lookup:
 * - a lease op is refused: only the lease machinery writes leases;
 * - every intent belongs to the commit's partition;
 * - every key is one its intent's aggregate owns, and the intent may ride
 *   the op's kind;
 * - a behavior definition's ops agree on the type their keys name;
 * - every data-version op pairs with a data.save, data.append or
 *   data.rename put of the same name and version in the commit.
 */
export function checkCommitBindings(
  partition: PartitionKey,
  ops: readonly Op[],
): CommitAuthorization {
  let definitionType: string | undefined;
  for (const [index, op] of ops.entries()) {
    if (op.kind === "lease") {
      return refuse(
        "lease-op",
        index,
        "A forwarded commit cannot carry a lease op",
      );
    }
    if (op.kind === "data-version") continue;
    if (!intentPartition(op.intent).equals(partition)) {
      return refuse(
        "intent-partition-mismatch",
        index,
        `Op ${index}'s intent belongs to another partition`,
      );
    }
    const binding = bindKey(op.intent, op.kind, op.key);
    if (!binding.ok) {
      return refuse(
        binding.reason,
        index,
        `Op ${index} (${op.intent.kind} ${op.kind}) cannot write ${op.key}`,
      );
    }
    if (isBehaviorDefinition(op.intent) && binding.type !== undefined) {
      definitionType ??= binding.type.normalized;
      if (binding.type.normalized !== definitionType) {
        return refuse(
          "definition-type-mismatch",
          index,
          `Op ${index} names behavior type ${binding.type.normalized}, ` +
            `not ${definitionType}`,
        );
      }
    }
  }
  for (const [index, op] of ops.entries()) {
    if (op.kind !== "data-version") continue;
    if (!pairsWithPut(op, ops)) {
      return refuse(
        "data-version-unpaired",
        index,
        `Op ${index} records a data version no put in the commit writes`,
      );
    }
  }
  return { ok: true };
}

/**
 * Authorises a forwarded commit: its bindings, the ownership of every key,
 * and the caller's access to every op's intent.
 */
export async function authorizeCommit(
  partition: PartitionKey,
  ops: readonly Op[],
  resolver: AggregateResourceResolver,
  authority: CallerAuthority,
): Promise<CommitAuthorization> {
  const bindings = checkCommitBindings(partition, ops);
  if (!bindings.ok) return bindings;
  const decided = new Map<string, boolean>();
  for (const [index, op] of ops.entries()) {
    if (op.kind !== "put" && op.kind !== "tombstone") continue;
    if (!(await ownsKey(op, partition, resolver))) {
      return refuse(
        "key-owned-elsewhere",
        index,
        `Op ${index}'s key ${op.key} belongs to another aggregate`,
      );
    }
    for (const required of await writeAccessesOf(op, resolver)) {
      // Ops of one intent share a decision, so a commit of many versions
      // asks once.
      const memo = JSON.stringify(required);
      let allowed = decided.get(memo);
      if (allowed === undefined) {
        allowed = authority.allows(
          required.action,
          required.resource,
          required.every === true,
        );
        decided.set(memo, allowed);
      }
      if (!allowed) {
        return refuse(
          "forbidden",
          index,
          `Not authorized to ${required.action} ${required.resource.kind}:` +
            `${required.resource.name} (${op.intent.kind})`,
        );
      }
    }
  }
  return { ok: true };
}

/**
 * Every access a put or tombstone needs: {@link writeAccessOf}, and for a
 * half of a definition rename the same write on the other name. A rename
 * may write a key the other name's partition owns, and its other name is
 * the client's to choose, so a caller must be able to change both
 * definitions the rename joins.
 */
export async function writeAccessesOf(
  op: PutOp | TombstoneOp,
  resolver: AggregateResourceResolver,
): Promise<readonly RequiredAccess[]> {
  const required = [await writeAccessOf(op, resolver)];
  const intent = op.intent;
  if (
    intent.kind === "definition.rename-to" ||
    intent.kind === "definition.rename-from"
  ) {
    const other = intent.kind === "definition.rename-to"
      ? intent.from
      : intent.to;
    required.push(
      await definitionAccessOf(
        op,
        { kind: intent.definition.kind, name: other },
        resolver,
      ),
    );
  }
  return required;
}

/**
 * The access a put or tombstone needs, copied from what serve's handlers
 * check for the same write. A control-plane behavior, a restricted type and
 * the lockfile need admin.
 */
export async function writeAccessOf(
  op: PutOp | TombstoneOp,
  resolver: AggregateResourceResolver,
): Promise<RequiredAccess> {
  const intent = op.intent;
  if (op.kind === "put" && CONTENT_CHECKED_PUTS.has(intent.kind)) {
    return { action: "admin", resource: ADMIN_RESOURCE };
  }
  if ("model" in intent) {
    const type = ModelType.create(intent.model.type);
    if (
      CONTROL_PLANE_INTENT_TYPES[intent.kind] !== undefined ||
      isControlPlaneModelType(type.normalized)
    ) {
      return {
        action: "admin",
        resource: await controlPlaneResourceOf(intent.model, resolver),
      };
    }
    if (resolver.isRestrictedType(type)) {
      return { action: "admin", resource: ADMIN_RESOURCE };
    }
    return await modelWriteAccessOf(intent, type, resolver);
  }
  if ("run" in intent) {
    const workflow = await resolver.workflow(intent.run.workflowId);
    const removal = intent.kind === "run.delete" ||
      intent.kind === "run-snapshot.delete";
    return {
      action: removal ? "write" : "run",
      resource: workflow === undefined
        ? unresolvedAccessResource("workflow", intent.run.workflowId)
        : workflowAccessResource({
          name: workflow.name,
          tags: workflow.tags ?? {},
        }),
    };
  }
  if ("definition" in intent) {
    return await definitionAccessOf(op, intent.definition, resolver);
  }
  if ("autoDefinition" in intent) {
    const type = bindKey(intent, op.kind, op.key);
    const modelType = type.ok ? type.type : undefined;
    if (modelType === undefined) {
      return { action: "admin", resource: ADMIN_RESOURCE };
    }
    if (
      isControlPlaneModelType(modelType.normalized) ||
      resolver.isRestrictedType(modelType)
    ) {
      return { action: "admin", resource: ADMIN_RESOURCE };
    }
    // Direct execution writes an auto-definition, which serve authorises
    // as running the behavior.
    return {
      action: intent.kind === "auto-definition.delete" ? "write" : "run",
      resource: unresolvedModelResource(
        modelType,
        intent.autoDefinition.id,
        "model",
      ),
    };
  }
  return { action: "admin", resource: ADMIN_RESOURCE };
}

/**
 * The access a write to a behavior's partition needs, as serve's handlers
 * decide the same write:
 * - data and outputs are saved only by running a method, decided as `run`
 *   on the behavior (`model.method.run`);
 * - a data delete or rename is `write` on the behavior's data
 *   (`data.delete`, `data.rename`);
 * - data garbage collection is `write` on all data, decided for the whole
 *   kind (`data.gc`);
 * - an output or evaluated definition removed, as a behavior delete
 *   removes them, is `write` on the behavior.
 */
async function modelWriteAccessOf(
  intent: Intent & { readonly model: ModelRef },
  type: ModelType,
  resolver: AggregateResourceResolver,
): Promise<RequiredAccess> {
  const lookup = await resolver.model(intent.model);
  const resourceAs = (kind: "model" | "data") =>
    lookup === undefined
      ? unresolvedModelResource(type, intent.model.id, kind)
      : modelAccessResource(lookup, kind);
  switch (intent.kind) {
    case "data.save":
    case "data.append":
    case "output.save":
      return { action: "run", resource: resourceAs("model") };
    case "data.delete":
    case "data.rename":
      return { action: "write", resource: resourceAs("data") };
    case "data.gc":
      return {
        action: "write",
        resource: { kind: "data", name: "*", fields: { name: "*" } },
        every: true,
      };
    default:
      return { action: "write", resource: resourceAs("model") };
  }
}

/**
 * The access needed to read an op's record: in the changes feed, a commit
 * is kept only when the caller may read every op. Undefined when any
 * authenticated caller may read it (the extension lockfile, and
 * data-version ops, which are read with their partition's other ops).
 */
export async function readAccessOf(
  op: Op,
  resolver: AggregateResourceResolver,
): Promise<RequiredAccess | undefined> {
  if (op.kind === "data-version" || op.kind === "lease") return undefined;
  const intent = op.intent;
  if ("model" in intent) {
    const type = ModelType.create(intent.model.type);
    if (
      CONTROL_PLANE_INTENT_TYPES[intent.kind] !== undefined ||
      isControlPlaneModelType(type.normalized)
    ) {
      return {
        action: "admin",
        resource: await controlPlaneResourceOf(intent.model, resolver),
      };
    }
    const kind = intent.kind.startsWith("data.") ? "data" : "model";
    const lookup = await resolver.model(intent.model);
    return {
      action: "read",
      resource: lookup === undefined
        ? unresolvedModelResource(type, intent.model.id, kind)
        : modelAccessResource(lookup, kind),
    };
  }
  if ("run" in intent) {
    const workflow = await resolver.workflow(intent.run.workflowId);
    return {
      action: "read",
      resource: workflow === undefined
        ? unresolvedAccessResource("workflow", intent.run.workflowId)
        : workflowAccessResource({
          name: workflow.name,
          tags: workflow.tags ?? {},
        }),
    };
  }
  if ("definition" in intent) {
    const write = await definitionAccessOf(op, intent.definition, resolver);
    return write.action === "admin"
      ? write
      : { action: "read", resource: write.resource };
  }
  if ("autoDefinition" in intent) {
    const binding = bindKey(intent, op.kind, op.key);
    const modelType = binding.ok ? binding.type : undefined;
    if (
      modelType === undefined || isControlPlaneModelType(modelType.normalized)
    ) {
      return { action: "admin", resource: ADMIN_RESOURCE };
    }
    return {
      action: "read",
      resource: unresolvedModelResource(
        modelType,
        intent.autoDefinition.id,
        "model",
      ),
    };
  }
  return undefined;
}

/**
 * What a caller needs to read anything a partition holds, for a chunk read
 * or a catch-up of the whole partition. It is conservative: a behavior's
 * partition holds its data and its outputs, so both reads are needed. An
 * empty list means any authenticated caller may read it (the lockfile).
 */
export async function partitionReadAccessOf(
  partition: PartitionKey,
  resolver: AggregateResourceResolver,
): Promise<readonly RequiredAccess[]> {
  const identity = partition.identity;
  switch (identity.kind) {
    case "model": {
      const model = { type: identity.type, id: identity.id };
      const type = ModelType.create(identity.type);
      if (isControlPlaneModelType(type.normalized)) {
        return [{
          action: "admin",
          resource: await controlPlaneResourceOf(model, resolver),
        }];
      }
      const lookup = await resolver.model(model);
      return (["data", "model"] as const).map((kind) => ({
        action: "read",
        resource: lookup === undefined
          ? unresolvedModelResource(type, identity.id, kind)
          : modelAccessResource(lookup, kind),
      }));
    }
    case "run": {
      const workflow = await resolver.workflow(identity.workflowId);
      return [{
        action: "read",
        resource: workflow === undefined
          ? unresolvedAccessResource("workflow", identity.workflowId)
          : workflowAccessResource({
            name: workflow.name,
            tags: workflow.tags ?? {},
          }),
      }];
    }
    case "config": {
      const tags = await resolver.definitionTags(
        identity.definitionKind,
        identity.name,
      );
      switch (identity.definitionKind) {
        case "workflow":
          return [{
            action: "read",
            resource: workflowAccessResource({
              name: identity.name,
              tags: tags ?? {},
            }),
          }];
        case "vault":
          return [{
            action: "read",
            resource: vaultKindResource(identity.name),
          }];
        case "model":
          // The partition names no behavior type, and same-named
          // definitions of several types share it, so neither their type
          // nor their tags is known: the resource carries neither, and a
          // deny conditioned on either fails closed.
          return [{
            action: "read",
            resource: {
              kind: "model",
              name: identity.name,
              fields: { name: identity.name },
            },
          }];
      }
      return [{ action: "admin", resource: ADMIN_RESOURCE }];
    }
    case "definition":
      // An auto-definition's partition names neither its behavior type nor
      // its name, so it cannot be told from a control-plane one: admin.
      return [{ action: "admin", resource: ADMIN_RESOURCE }];
    case "lockfile":
      return [];
  }
}

async function definitionAccessOf(
  op: PutOp | TombstoneOp,
  definition: { readonly kind: DefinitionKind; readonly name: string },
  resolver: AggregateResourceResolver,
): Promise<RequiredAccess> {
  const binding = bindKey(op.intent, op.kind, op.key);
  const keyType = binding.ok ? binding.type : undefined;
  const tags = await resolver.definitionTags(
    definition.kind,
    definition.name,
    definition.kind === "model" ? keyType : undefined,
  );
  switch (definition.kind) {
    case "workflow":
      return {
        action: "write",
        resource: workflowAccessResource({
          name: definition.name,
          tags: tags ?? {},
        }),
      };
    case "vault":
      return { action: "write", resource: vaultKindResource(definition.name) };
    case "model": {
      const type = keyType;
      // A behavior definition's type comes from its key, never its content.
      if (
        type === undefined || isControlPlaneModelType(type.normalized) ||
        resolver.isRestrictedType(type)
      ) {
        return { action: "admin", resource: ADMIN_RESOURCE };
      }
      return {
        action: "write",
        resource: {
          kind: "model",
          name: definition.name,
          fields: modelTypeFields(
            definition.name,
            type.normalized,
            tags,
            "model",
          ),
        },
      };
    }
  }
}

/**
 * Whether an op may write its key: no other aggregate holds it, or the
 * other one is the counterpart of a definition rename.
 */
async function ownsKey(
  op: PutOp | TombstoneOp,
  partition: PartitionKey,
  resolver: AggregateResourceResolver,
): Promise<boolean> {
  const ownership = await resolver.keyOwner(op.key.toString());
  if (ownership === undefined) return true;
  const owner = ownership.owner;
  if (owner === partition.toString()) return true;
  const intent = op.intent;
  if (intent.kind === "definition.rename-to") {
    return owner === configPartition(intent.definition.kind, intent.from);
  }
  if (intent.kind === "definition.rename-from") {
    return owner === configPartition(intent.definition.kind, intent.to);
  }
  // A key its owner removed can be put again by another aggregate: the
  // read model hands the file to the newest live put.
  return op.kind === "put" && !ownership.present;
}

function configPartition(kind: DefinitionKind, name: string): string {
  try {
    return partitionOf({ kind: "config", definitionKind: kind, name })
      .toString();
  } catch {
    return "";
  }
}

async function controlPlaneResourceOf(
  model: ModelRef,
  resolver: AggregateResourceResolver,
): Promise<AccessResource> {
  const lookup = await resolver.model(model);
  return controlPlaneRecordResource(model.type, {
    name: lookup?.definition.name ?? model.id,
    tags: lookup?.definition.tags,
  });
}

/**
 * A behavior no definition holds, named by its id: a grant on the name
 * cannot match it, so only a kind-wide or wildcard grant allows it.
 */
function unresolvedModelResource(
  type: ModelType,
  id: string,
  kind: "model" | "data",
): AccessResource {
  return {
    kind,
    name: id,
    fields: modelTypeFields(id, type.normalized, {}, kind),
  };
}

function isBehaviorDefinition(intent: Intent): boolean {
  return "definition" in intent && intent.definition.kind === "model";
}

/**
 * Whether a data-version op is recorded by a put of its own metadata key, of
 * the name and version its metadata states. A rename records versions under
 * both names: the new name's, and the old name's `renamedTo` marker.
 */
function pairsWithPut(op: DataVersionOp, ops: readonly Op[]): boolean {
  const metadata = op.metadata;
  const segments = op.key.toString().split("/");
  // `.../{name}/{version}/metadata.yaml`: the metadata must describe the
  // version whose key it is recorded at.
  if (
    segments[segments.length - 1] !== "metadata.yaml" ||
    segments[segments.length - 3] !== metadata.name ||
    segments[segments.length - 2] !== String(metadata.version)
  ) {
    return false;
  }
  return ops.some((other) => {
    if (other.kind !== "put" || !other.key.equals(op.key)) return false;
    const intent = other.intent;
    if (intent.kind === "data.save" || intent.kind === "data.append") {
      return intent.name === metadata.name &&
        intent.version === metadata.version;
    }
    return intent.kind === "data.rename" &&
      (intent.to === metadata.name || intent.name === metadata.name);
  });
}

function refuse(
  reason: CommitRefusalReason,
  opIndex: number,
  message: string,
): CommitRefusal {
  return { ok: false, reason, opIndex, message };
}
