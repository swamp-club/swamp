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
 * Serve's content checks for forwarded commits (swamp-club#3922).
 *
 * A forwarded commit is authorised op by op on its intents
 * (`commit_authorization.ts`); this module checks what a put's content
 * carries, as serve's WebSocket handlers check the same write. It reads the
 * put's bytes (proof of possession first, so a refusal never tells a caller
 * about content it may not read), parses them as the repositories do, reads
 * the record the put replaces from serve's read model, and applies the
 * handlers' own checks through the caller's {@link RequestAuthority}.
 *
 * Every record it reads to judge a put is remembered with its digest:
 * {@link ForwardedContentAuthority.unchanged} checks, under the forwarded
 * lock, that none moved before the commit is appended.
 *
 * @module
 */

import { parse as parseYaml } from "@std/yaml";
import type { AccessResource } from "../domain/access/access_decision_service.ts";
import { modelTypeFields } from "../domain/access/access_resources.ts";
import { restoreNamespace, SOLO_NAMESPACE } from "../domain/data/namespace.ts";
import { Definition } from "../domain/definitions/definition.ts";
import { storageNamespaceOf } from "../domain/datastore_v3/chunk_store.ts";
import type {
  AggregateResourceResolver,
  ContentAuthority,
  ContentRefusal,
} from "../domain/datastore_v3/commit_authorization.ts";
import {
  type DeclaredIdentity,
  identityRefusal,
  type KeyFacts,
} from "../domain/datastore_v3/content_bindings.ts";
import { bindKey } from "../domain/datastore_v3/intent_key_paths.ts";
import type { Op, PutOp } from "../domain/datastore_v3/op.ts";
import {
  type PartitionKey,
  partitionOf,
  runPartitionsPrefix,
} from "../domain/datastore_v3/partition_key.ts";
import { isDeferredExpression } from "../domain/expressions/deferred_expression.ts";
import { extractExpressions } from "../domain/expressions/expression_parser.ts";
import {
  analyzeContentExpressions,
  canonicalJson,
  definitionRetargetSourcesChanged,
  expressionsAddedByEdit,
} from "../domain/expressions/expression_references.ts";
import { modelRegistry } from "../domain/models/model.ts";
import { findDefinitionByIdGlobal } from "../domain/models/model_lookup.ts";
import { ModelType } from "../domain/models/model_type.ts";
import { findLiteralSensitiveGlobalArgs } from "../domain/models/sensitive_field_extractor.ts";
import {
  findChangedKeySourceFields,
  findNonDefaultKeySourceFields,
  isLocalEncryptionType,
} from "../domain/vaults/local_encryption_key_source.ts";
import { findLocalEncryptionLeftovers } from "../domain/vaults/local_encryption_vault_provider.ts";
import { VaultConfigDataSchema } from "../domain/vaults/vault_config.ts";
import { isValidVaultName } from "../domain/vaults/vault_name.ts";
import { Workflow } from "../domain/workflows/workflow.ts";
import { findWorkflowById } from "../domain/workflows/workflow_lookup.ts";
import type { V3Datastore } from "../infrastructure/datastore_v3/v3_datastore.ts";
import { parseEvaluatedDefinitionCache } from "../infrastructure/persistence/yaml_evaluated_definition_repository.ts";
import { parseEvaluatedWorkflowCache } from "../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import {
  authorizeExpressionReferences,
  authorizeRunInputExpressions,
} from "./handlers/expression_reference_authorization.ts";
import { workflowAccessResource } from "./handlers/resource_resolution.ts";
import {
  type AccessCaller,
  callerAuthority,
  type ConnectionContext,
  isAdminOnlyModelType,
  isCallerVaultAuthorized,
  type RequestAuthority,
  retagResources,
  vaultAccessResource,
} from "./handlers/shared.ts";
import { authorizeWorkflowEdit } from "./handlers/workflow_step_authorization.ts";
import { checkRunRecord, checkRunSnapshot } from "./forwarded_run_content.ts";
import { checkDataPut } from "./forwarded_data_content.ts";

/** The most bytes of one put serve reads to check it. */
export const MAX_CHECKED_CONTENT_BYTES = 16 * 1024 * 1024;

/** What the content checks of one forwarded commit need. */
export interface ForwardedContentDeps {
  readonly ctx: ConnectionContext;
  readonly v3: V3Datastore;
  /** The commit's partition. */
  readonly partition: PartitionKey;
  readonly caller: AccessCaller;
  readonly requestId: string;
  readonly resolver: AggregateResourceResolver;
  /** Whether the caller may name a chunk: it carried it, or may reference it. */
  readonly possesses: (sha256: string) => Promise<boolean>;
  readonly signal: AbortSignal;
  readonly now?: () => Date;
}

/** A record a put is judged against. */
export type PriorRecord =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly bytes: Uint8Array }
  | { readonly kind: "unreadable" };

/**
 * What the per-kind checks share: reading content and prior records, and
 * deciding for the caller.
 */
export interface ContentCheckContext {
  readonly deps: ForwardedContentDeps;
  readonly authority: RequestAuthority;
  /** The put's bytes, or a refusal when they cannot be read. */
  bytesOf(op: PutOp): Promise<Uint8Array | ContentRefusal>;
  /** The live record of `key` in `partition`, remembered for the guard. */
  prior(partition: PartitionKey, key: string): Promise<PriorRecord>;
  /**
   * The digest of the live record of `key` in `partition`, null when
   * absent, remembered for the guard: for comparing content without reading it.
   */
  digest(partition: PartitionKey, key: string): Promise<string | null>;
  /** Whether a partition whose key starts with `prefix` holds records. */
  holdsRecordsUnder(prefix: string): Promise<boolean>;
  /**
   * Registers a check {@link ForwardedContentAuthority.unchanged} runs
   * again under the forwarded lock: one that reads more than records (an
   * id claimed by no definition), which the record guard cannot cover.
   */
  recheckUnderLock(check: () => Promise<boolean>): void;
  now(): Date;
}

/**
 * The {@link ContentAuthority} serve checks a forwarded commit with. One
 * instance per authorisation pass: it remembers the records it read.
 */
export class ForwardedContentAuthority implements ContentAuthority {
  readonly #deps: ForwardedContentDeps;
  readonly #authority: RequestAuthority;
  /** Every record read, by partition and key: its digest, or null when absent. */
  readonly #read = new Map<
    string,
    { partition: PartitionKey; key: string; sha256: string | null }
  >();
  /** Checks to run again under the forwarded lock. */
  readonly #rechecks: (() => Promise<boolean>)[] = [];

  constructor(deps: ForwardedContentDeps) {
    this.#deps = deps;
    this.#authority = callerAuthority(deps.caller, deps.requestId, deps.ctx);
  }

  async check(
    op: PutOp,
    commit: readonly Op[],
  ): Promise<ContentRefusal | undefined> {
    const context = this.#context();
    switch (op.intent.kind) {
      case "definition.create":
      case "definition.edit":
      case "definition.rename-to":
        return await checkDefinitionPut(context, op, commit);
      case "auto-definition.save":
        return await checkAutoDefinition(context, op);
      case "evaluated-definition.save":
        return await checkEvaluatedDefinition(context, op);
      case "evaluated-workflow.save":
        return await checkEvaluatedWorkflow(context, op);
      case "run-snapshot.save":
        return await checkRunSnapshot(context, op);
      case "run.create":
      case "run.update":
        return await checkRunRecord(context, op);
      case "data.save":
      case "data.append":
      case "data.delete":
      case "data.gc":
      case "data.rename":
        return await checkDataPut(context, op, commit);
    }
    return { message: `${op.intent.kind} content is not checked here` };
  }

  /**
   * Whether every record this authority read still holds what it read:
   * checked under the forwarded lock, so a commit judged against a record
   * that has since changed is retried instead of appended.
   */
  async unchanged(): Promise<boolean> {
    for (const { partition, key, sha256 } of this.#read.values()) {
      const record = await this.#deps.v3.readModel.liveRecord(
        this.#deps.v3.namespace,
        partition,
        key,
      );
      if ((record?.sha256 ?? null) !== sha256) return false;
    }
    for (const recheck of this.#rechecks) {
      if (!(await recheck())) return false;
    }
    return true;
  }

  #context(): ContentCheckContext {
    const deps = this.#deps;
    const read = this.#read;
    return {
      deps,
      authority: this.#authority,
      bytesOf: (op) => readPutBytes(deps, op),
      prior: async (partition, key) => {
        const v3 = deps.v3;
        const record = await v3.readModel.liveRecord(
          v3.namespace,
          partition,
          key,
        );
        const memo = `${partition.toString()}\u0000${key}`;
        if (record === undefined) {
          read.set(memo, { partition, key, sha256: null });
          return { kind: "absent" };
        }
        read.set(memo, { partition, key, sha256: record.sha256 });
        // A record past the cap is judged unreadable, never read whole.
        if ((record.blob?.size ?? 0) > MAX_CHECKED_CONTENT_BYTES) {
          return { kind: "unreadable" };
        }
        const found = await v3.readModel.recordBytes(
          v3.namespace,
          partition,
          key,
          MAX_CHECKED_CONTENT_BYTES,
        );
        return found === undefined || found.record.sha256 !== record.sha256
          ? { kind: "unreadable" }
          : { kind: "present", bytes: found.bytes };
      },
      digest: async (partition, key) => {
        const record = await deps.v3.readModel.liveRecord(
          deps.v3.namespace,
          partition,
          key,
        );
        const sha256 = record?.sha256 ?? null;
        read.set(`${partition.toString()}\u0000${key}`, {
          partition,
          key,
          sha256,
        });
        return sha256;
      },
      holdsRecordsUnder: (prefix) =>
        deps.v3.readModel.holdsRecordsUnder(deps.v3.namespace, prefix),
      recheckUnderLock: (check) => {
        this.#rechecks.push(check);
      },
      now: () => deps.now?.() ?? new Date(),
    };
  }
}

/**
 * A put's bytes: inline, or its blob's chunks once the caller is shown to
 * possess each, so content is never read for a caller who may not have it.
 */
async function readPutBytes(
  deps: ForwardedContentDeps,
  op: PutOp,
): Promise<Uint8Array | ContentRefusal> {
  if ("inline" in op.content) {
    return Uint8Array.from(atob(op.content.inline), (c) => c.charCodeAt(0));
  }
  const blob = op.content.blob;
  if (blob.size > MAX_CHECKED_CONTENT_BYTES) {
    return { message: `${op.key} is too large to check` };
  }
  for (const hash of blob.chunkHashes()) {
    if (!(await deps.possesses(hash))) {
      return {
        message: `${op.key} names a chunk it neither carries nor may read`,
      };
    }
  }
  const namespace = deps.v3.namespace === ""
    ? SOLO_NAMESPACE
    : restoreNamespace(deps.v3.namespace);
  try {
    return new Uint8Array(
      await new Response(
        deps.v3.chunkStore.read(namespace, blob, deps.signal),
      ).arrayBuffer(),
    );
  } catch {
    return {
      message: `${op.key}'s content could not be read from ${
        storageNamespaceOf(namespace)
      }`,
    };
  }
}

/** Parses YAML content to a plain object, or undefined when it is not one. */
export function parseRecord(
  bytes: Uint8Array,
): Record<string, unknown> | undefined {
  try {
    const parsed = parseYaml(new TextDecoder().decode(bytes));
    return parsed !== null && typeof parsed === "object" &&
        !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/** A refusal naming the op's key and why; never content. */
export function refused(op: PutOp, why: string): ContentRefusal {
  return { message: `${op.intent.kind} of ${op.key}: ${why}` };
}

function keyFacts(op: PutOp): KeyFacts {
  const binding = bindKey(op.intent, "put", op.key);
  if (!binding.ok) return {};
  return {
    ...(binding.fileId === undefined ? {} : { fileId: binding.fileId }),
    ...(binding.fileName === undefined ? {} : { fileName: binding.fileName }),
    ...(binding.type === undefined ? {} : { type: binding.type.normalized }),
  };
}

function normalizedType(type: string): string | undefined {
  try {
    return ModelType.create(type).normalized;
  } catch {
    return undefined;
  }
}

/**
 * The prior record a definition put replaces: the record at its key; for a
 * move, the record its commit tombstones under the same intent; for a
 * rename, the old name's record of the same file or of the old name's file.
 */
async function definitionPrior(
  context: ContentCheckContext,
  op: PutOp,
  commit: readonly Op[],
): Promise<PriorRecord> {
  const intent = op.intent;
  if (!("definition" in intent)) return { kind: "absent" };
  const here = await context.prior(context.deps.partition, op.key.toString());
  if (here.kind !== "absent") return here;
  const moved = commit.find((other) =>
    other.kind === "tombstone" && other.intent.kind === intent.kind &&
    !other.key.equals(op.key)
  );
  if (moved !== undefined && moved.kind === "tombstone") {
    return await context.prior(context.deps.partition, moved.key.toString());
  }
  if (intent.kind !== "definition.rename-to") return here;
  const from = partitionOf({
    kind: "config",
    definitionKind: intent.definition.kind,
    name: intent.from,
  });
  const sameKey = await context.prior(from, op.key.toString());
  if (sameKey.kind !== "absent") return sameKey;
  const oldKey = renamedKey(
    op.key.toString(),
    intent.definition.name,
    intent.from,
  );
  if (oldKey === undefined) return { kind: "unreadable" };
  const old = await context.prior(from, oldKey);
  // A rename moves a definition that exists: none to move refuses.
  return old.kind === "absent" ? { kind: "unreadable" } : old;
}

/** The key a name-keyed definition file had under its old name. */
function renamedKey(
  key: string,
  name: string,
  from: string,
): string | undefined {
  const model = `/${name}.yaml`;
  if (key.startsWith("config/models/") && key.endsWith(model)) {
    return `${key.slice(0, -model.length)}/${from}.yaml`;
  }
  const workflow = `config/workflows/workflow-${name}.yaml`;
  if (key === workflow) return `config/workflows/workflow-${from}.yaml`;
  return undefined;
}

/** A behavior, workflow or vault definition put: create, edit or rename. */
async function checkDefinitionPut(
  context: ContentCheckContext,
  op: PutOp,
  commit: readonly Op[],
): Promise<ContentRefusal | undefined> {
  const intent = op.intent;
  if (!("definition" in intent)) return refused(op, "it is not a definition");
  const bytes = await context.bytesOf(op);
  if (!(bytes instanceof Uint8Array)) return bytes;
  const after = parseRecord(bytes);
  if (after === undefined) {
    return refused(op, "its content is not a definition");
  }
  const prior = await definitionPrior(context, op, commit);
  if (prior.kind === "unreadable") {
    return refused(op, "the definition it replaces cannot be read");
  }
  const before = prior.kind === "present"
    ? parseRecord(prior.bytes)
    : undefined;
  if (prior.kind === "present" && before === undefined) {
    return refused(op, "the definition it replaces cannot be parsed");
  }
  switch (intent.definition.kind) {
    case "model":
      return await checkBehaviorDefinition(context, op, after, before);
    case "workflow":
      return await checkWorkflowDefinition(context, op, after, before);
    case "vault":
      return await checkVaultDefinition(context, op, after, before);
  }
  return refused(op, "it is not a known definition kind");
}

/** The model resource an edit of a behavior is decided on. */
function behaviorResource(definition: Definition): AccessResource {
  const type = definition.type ?? "";
  return {
    kind: "model",
    name: definition.name,
    fields: modelTypeFields(
      definition.name,
      normalizedType(type) ?? type,
      definition.tags,
      "model",
    ),
  };
}

function definitionOf(data: Record<string, unknown>): Definition | undefined {
  try {
    return Definition.fromData(
      data as Parameters<typeof Definition.fromData>[0],
    );
  } catch {
    return undefined;
  }
}

function declaredDefinition(definition: Definition): DeclaredIdentity {
  return {
    id: definition.id,
    name: definition.name,
    type: normalizedType(definition.type ?? ""),
  };
}

/**
 * Whether a behavior id may be claimed by a create: no definition of any
 * type holds it, and no record is stored under it, unless the holder is
 * the auto-definition being promoted (same id, type and name).
 */
async function behaviorIdRefusal(
  context: ContentCheckContext,
  declared: DeclaredIdentity,
): Promise<string | undefined> {
  const { ctx } = context.deps;
  const autoPartition = partitionOf({ kind: "definition", id: declared.id });
  const autoHeld = await context.holdsRecordsUnder(autoPartition.toString());
  const holder = await findDefinitionByIdGlobal(
    ctx.repoContext.definitionRepo,
    declared.id,
  );
  const promotion = autoHeld && holder !== null &&
    holder.definition.name === declared.name &&
    holder.type.normalized === declared.type;
  if (holder !== null && !promotion) {
    return "its id is held by another definition";
  }
  if (declared.type !== undefined && !promotion) {
    const data = partitionOf({
      kind: "model",
      type: ModelType.create(declared.type),
      id: declared.id,
    });
    if (await context.holdsRecordsUnder(data.toString())) {
      return "records are still stored under its id";
    }
  }
  return undefined;
}

/**
 * Whether a name is taken by another live definition: of any type for a
 * behavior, as `model create` and a rename refuse, except the
 * auto-definition being promoted.
 */
async function behaviorNameRefusal(
  context: ContentCheckContext,
  declared: DeclaredIdentity,
): Promise<string | undefined> {
  const holder = await context.deps.ctx.repoContext.definitionRepo
    .findByNameGlobal(declared.name);
  if (holder === null || holder.definition.id === declared.id) return undefined;
  return "its name is held by another behavior";
}

async function checkBehaviorDefinition(
  context: ContentCheckContext,
  op: PutOp,
  afterData: Record<string, unknown>,
  beforeData: Record<string, unknown> | undefined,
): Promise<ContentRefusal | undefined> {
  const after = definitionOf(afterData);
  if (after === undefined) {
    return refused(op, "its content is not a behavior definition");
  }
  const before = beforeData === undefined
    ? undefined
    : definitionOf(beforeData);
  if (beforeData !== undefined && before === undefined) {
    return refused(op, "the behavior it replaces cannot be parsed");
  }
  const declared = declaredDefinition(after);
  const identity = identityRefusal(
    op.intent,
    keyFacts(op),
    declared,
    before === undefined ? undefined : declaredDefinition(before),
  );
  if (identity !== undefined) return refused(op, identity);
  if (before === undefined) {
    const id = await behaviorIdRefusal(context, declared);
    if (id !== undefined) return refused(op, id);
    // Two creates claiming one id race: the second to land is checked again.
    context.recheckUnderLock(async () =>
      await behaviorIdRefusal(context, declared) === undefined
    );
  }
  if (before === undefined || before.name !== after.name) {
    const name = await behaviorNameRefusal(context, declared);
    if (name !== undefined) return refused(op, name);
  }
  return await behaviorEditRefusal(context, op, after, before);
}

/**
 * The checks `model edit` applies to an edit of an ordinary behavior, or
 * `model create` to a new one: write on it as the edit leaves it, `tag` for
 * a retag or rename, the expressions it adds, and no literal sensitive
 * global argument. A control-plane or restricted type needs admin, which
 * the commit's base access already decided.
 */
async function behaviorEditRefusal(
  context: ContentCheckContext,
  op: PutOp,
  after: Definition,
  before: Definition | undefined,
): Promise<ContentRefusal | undefined> {
  const { ctx } = context.deps;
  const authority = context.authority;
  const type = declaredDefinition(after).type;
  if (type === undefined) return refused(op, "its type is not a behavior type");
  if (
    !isAdminOnlyModelType(undefined, type, ctx.authConfig.restrictedModelTypes)
  ) {
    const resource = behaviorResource(after);
    if (!authority.allows("write", resource)) {
      return refused(op, `not authorized to write model:${after.name}`);
    }
    const prior = before ?? after;
    const priorTags = before === undefined ? {} : { ...before.tags };
    for (
      const tagged of retagResources({
        prior: (tags) => ({
          ...behaviorResource(prior),
          fields: { ...behaviorResource(prior).fields, tags },
        }),
        after: resource,
        loaded: priorTags,
        stored: priorTags,
        afterTags: { ...after.tags },
      })
    ) {
      if (!authority.allows("tag", tagged)) {
        return refused(op, `not authorized to tag model:${tagged.name}`);
      }
    }
  }
  const beforeData = before?.toData() ?? {};
  const afterData = after.toData();
  const expressions = await authorizeExpressionReferences(
    authority,
    ctx,
    expressionsAddedByEdit(
      analyzeContentExpressions(beforeData),
      analyzeContentExpressions(afterData),
      definitionRetargetSourcesChanged(
        beforeData as unknown as Record<string, unknown>,
        afterData as unknown as Record<string, unknown>,
      ),
    ),
    "allowed",
  );
  if (expressions !== undefined) return refused(op, expressions.message);
  const leaked = await literalSensitiveGlobals(type, afterData.globalArguments);
  if (leaked.length > 0) {
    return refused(
      op,
      `sensitive global arguments ${leaked.join(", ")} hold literal values`,
    );
  }
  return undefined;
}

/**
 * The sensitive global arguments of `type` that `globals` holds as literal
 * values, which the definition repository refuses to persist.
 */
async function literalSensitiveGlobals(
  type: string,
  globals: Record<string, unknown> | undefined,
): Promise<string[]> {
  const modelType = ModelType.create(type);
  await modelRegistry.ensureTypeLoaded(modelType);
  let modelDef = modelRegistry.get(modelType);
  if (!modelDef) {
    await modelRegistry.ensureLoaded();
    await modelRegistry.ensureTypeLoaded(modelType);
    modelDef = modelRegistry.get(modelType);
  }
  return findLiteralSensitiveGlobalArgs(modelDef?.globalArguments, globals);
}

function workflowOf(data: Record<string, unknown>): Workflow | undefined {
  try {
    return Workflow.fromData(data as Parameters<typeof Workflow.fromData>[0]);
  } catch {
    return undefined;
  }
}

async function checkWorkflowDefinition(
  context: ContentCheckContext,
  op: PutOp,
  afterData: Record<string, unknown>,
  beforeData: Record<string, unknown> | undefined,
): Promise<ContentRefusal | undefined> {
  const after = workflowOf(afterData);
  if (after === undefined) return refused(op, "its content is not a workflow");
  const before = beforeData === undefined ? undefined : workflowOf(beforeData);
  if (beforeData !== undefined && before === undefined) {
    return refused(op, "the workflow it replaces cannot be parsed");
  }
  const declared = { id: after.id, name: after.name };
  const identity = identityRefusal(
    op.intent,
    keyFacts(op),
    declared,
    before === undefined ? undefined : { id: before.id, name: before.name },
  );
  if (identity !== undefined) return refused(op, identity);
  const repo = context.deps.ctx.repoContext.workflowRepo;
  if (before === undefined) {
    const idFree = async () =>
      await findWorkflowById(repo, after.id) === null &&
      !(await context.holdsRecordsUnder(runPartitionsPrefix(after.id)));
    if (!(await idFree())) {
      return refused(op, "its id is held by another workflow, or by its runs");
    }
    context.recheckUnderLock(idFree);
  }
  if (before === undefined || before.name !== after.name) {
    const holder = await repo.findByName(after.name);
    if (holder !== null && holder.id !== after.id) {
      return refused(op, "its name is held by another workflow");
    }
  }
  const authority = context.authority;
  const resource = workflowAccessResource(after);
  if (!authority.allows("write", resource)) {
    return refused(op, `not authorized to write workflow:${after.name}`);
  }
  const prior = before ?? after;
  const priorTags = before === undefined ? {} : { ...before.tags };
  for (
    const tagged of retagResources({
      prior: (tags) => workflowAccessResource({ name: prior.name, tags }),
      after: resource,
      loaded: priorTags,
      stored: priorTags,
      afterTags: { ...after.tags },
    })
  ) {
    if (!authority.allows("tag", tagged)) {
      return refused(op, `not authorized to tag workflow:${tagged.name}`);
    }
  }
  // A new workflow is an edit from one with no steps: every step and
  // expression it holds is added.
  const base = before ?? Workflow.create({ id: after.id, name: after.name });
  const steps = await authorizeWorkflowEdit(
    authority,
    context.deps.ctx,
    base,
    after,
  );
  return steps === undefined ? undefined : refused(op, steps);
}

async function checkVaultDefinition(
  context: ContentCheckContext,
  op: PutOp,
  afterData: Record<string, unknown>,
  beforeData: Record<string, unknown> | undefined,
): Promise<ContentRefusal | undefined> {
  const intent = op.intent;
  if (!("definition" in intent)) return refused(op, "it is not a definition");
  const parsedAfter = VaultConfigDataSchema.safeParse(afterData);
  if (!parsedAfter.success) {
    return refused(op, "its content is not a vault config");
  }
  const after = parsedAfter.data;
  const parsedBefore = beforeData === undefined
    ? undefined
    : VaultConfigDataSchema.safeParse(beforeData);
  if (parsedBefore !== undefined && !parsedBefore.success) {
    return refused(op, "the vault config it replaces cannot be parsed");
  }
  const before = parsedBefore?.data;
  const identity = identityRefusal(
    intent,
    keyFacts(op),
    { id: after.id, name: after.name, type: normalizedType(after.type) },
    before === undefined
      ? undefined
      : { id: before.id, name: before.name, type: normalizedType(before.type) },
  );
  if (identity !== undefined) return refused(op, identity);
  const renamed = intent.kind === "definition.rename-to";
  const named = before === undefined || renamed;
  // A vault's storage is found by its name: it must be a single segment,
  // never a reserved one, as `vault create` and a rename require.
  if (named && !isValidVaultName(after.name)) {
    return refused(op, "its name is not a valid vault name");
  }
  if (before !== undefined && before.type !== after.type) {
    return refused(op, "it changes the vault's type");
  }
  const { ctx, caller, requestId } = context.deps;
  for (const vaultName of renamed ? [after.name, intent.from] : [after.name]) {
    if (
      !isCallerVaultAuthorized(caller, requestId, {
        vaultName,
        action: "write",
        existing: vaultAccessResource(vaultName),
      }, ctx)
    ) {
      return refused(op, `not authorized to write vault:${vaultName}`);
    }
  }
  if (named) {
    let holder;
    try {
      holder = await ctx.repoContext.vaultConfigRepo.findByName(
        after.name,
        true,
      );
    } catch {
      // A name whose holder cannot be read cannot be judged free.
      return refused(op, "the vaults holding its name cannot be read");
    }
    if (holder !== null && holder.id !== after.id) {
      return refused(op, "its name is held by another vault");
    }
  }
  if (isLocalEncryptionType(after.type)) {
    // Its key and secrets live on serve, under its name: only vault.edit
    // moves them, so a forwarded rename would strand them.
    if (renamed) {
      return refused(op, "a local_encryption vault is renamed with vault edit");
    }
    const keySource = before === undefined
      ? findNonDefaultKeySourceFields(after.config, ctx.repoDir)
      : findChangedKeySourceFields(after.config, before.config);
    if (keySource.length > 0) {
      return refused(
        op,
        `local_encryption key source fields ${
          keySource.join(", ")
        } are set by serve`,
      );
    }
    if (
      before === undefined &&
      await findLocalEncryptionLeftovers(ctx.repoDir, after.name) !== undefined
    ) {
      return refused(op, "serve still holds secrets stored under its name");
    }
  }
  return undefined;
}

/**
 * The definition direct execution would write for `definition`'s identity:
 * its type, id, name, versions and nothing else but global arguments.
 */
function directlyCreated(definition: Definition): Definition {
  return Definition.create({
    type: definition.type,
    typeVersion: definition.typeVersion,
    id: definition.id,
    name: definition.name,
    version: definition.version,
    globalArguments: definition.globalArguments as Record<string, unknown>,
  });
}

/** A definition as JSON with its global arguments left out. */
function withoutGlobals(definition: Definition): string {
  return canonicalJson({ ...definition.toData(), globalArguments: {} });
}

/**
 * An auto-definition, as direct execution writes one: content that has
 * the shape it creates, or that changes only a stored one's global
 * arguments, needs run as direct execution does, with adoption's guards.
 * Anything else is an edit of the behavior (an auto-definition edited with
 * `model edit` is saved back in place) and needs what an edit needs.
 */
async function checkAutoDefinition(
  context: ContentCheckContext,
  op: PutOp,
): Promise<ContentRefusal | undefined> {
  const bytes = await context.bytesOf(op);
  if (!(bytes instanceof Uint8Array)) return bytes;
  const afterData = parseRecord(bytes);
  const after = afterData === undefined ? undefined : definitionOf(afterData);
  if (after === undefined) {
    return refused(op, "its content is not a behavior definition");
  }
  const prior = await context.prior(context.deps.partition, op.key.toString());
  if (prior.kind === "unreadable") {
    return refused(op, "the auto-definition it replaces cannot be read");
  }
  const beforeData = prior.kind === "present"
    ? parseRecord(prior.bytes)
    : undefined;
  const before = beforeData === undefined
    ? undefined
    : definitionOf(beforeData);
  if (prior.kind === "present" && before === undefined) {
    return refused(op, "the auto-definition it replaces cannot be parsed");
  }
  const declared = declaredDefinition(after);
  const identity = identityRefusal(
    op.intent,
    keyFacts(op),
    declared,
    before === undefined ? undefined : declaredDefinition(before),
  );
  if (identity !== undefined) return refused(op, identity);
  const type = declared.type;
  if (type === undefined) return refused(op, "its type is not a behavior type");
  const { ctx } = context.deps;
  // An adoption copy of a named definition carries its id: direct execution
  // on a named definition with changed globals saves it here. The holder is
  // named when its name's config partition holds a record.
  const holder = await findDefinitionByIdGlobal(
    ctx.repoContext.definitionRepo,
    after.id,
  );
  const namedHolder = holder !== null &&
      await context.holdsRecordsUnder(
        partitionOf({
          kind: "config",
          definitionKind: "model",
          name: holder.definition.name,
        }).toString(),
      )
    ? holder
    : null;
  if (namedHolder !== null) {
    if (
      namedHolder.type.normalized !== type ||
      withoutGlobals(namedHolder.definition) !== withoutGlobals(after)
    ) {
      return refused(op, "its id is held by a named behavior it does not copy");
    }
    if (
      !isAdminOnlyModelType(
        undefined,
        type,
        ctx.authConfig.restrictedModelTypes,
      ) &&
      !context.authority.allows("run", behaviorResource(namedHolder.definition))
    ) {
      return refused(
        op,
        `not authorized to run model:${namedHolder.definition.name}`,
      );
    }
  }
  const directShape =
    withoutGlobals(after) === withoutGlobals(directlyCreated(after)) ||
    (before !== undefined && withoutGlobals(before) === withoutGlobals(after));
  if (!directShape) {
    return await behaviorEditRefusal(context, op, after, before);
  }
  if (
    !isAdminOnlyModelType(
      undefined,
      type,
      ctx.authConfig.restrictedModelTypes,
    ) &&
    !context.authority.allows("run", behaviorResource(after))
  ) {
    return refused(op, `not authorized to run model:${after.name}`);
  }
  const globals = after.globalArguments as Record<string, unknown>;
  const scoped = extractExpressions(globals).filter((e) =>
    isDeferredExpression(e.celExpression)
  );
  if (scoped.length > 0) {
    return refused(
      op,
      "a global argument holds a runtime expression scoped to a workflow run",
    );
  }
  const added = expressionsAddedByEdit(
    analyzeContentExpressions({
      globalArguments: before?.globalArguments ?? {},
    }),
    analyzeContentExpressions({ globalArguments: globals }),
    false,
  );
  const expressions = await authorizeRunInputExpressions(
    context.authority,
    ctx,
    added,
    behaviorResource(after),
  );
  if (expressions !== undefined) return refused(op, expressions.message);
  const leaked = await literalSensitiveGlobals(type, globals);
  if (leaked.length > 0) {
    return refused(
      op,
      `sensitive global arguments ${leaked.join(", ")} hold literal values`,
    );
  }
  return undefined;
}

/**
 * An evaluated definition: bound to the behavior its intent names. Serve
 * never runs a forwarded one (it is not serve's own evaluation), so the
 * binding is all it needs beyond run on the behavior.
 */
async function checkEvaluatedDefinition(
  context: ContentCheckContext,
  op: PutOp,
): Promise<ContentRefusal | undefined> {
  const bytes = await context.bytesOf(op);
  if (!(bytes instanceof Uint8Array)) return bytes;
  let definition: Definition;
  try {
    const cache = parseEvaluatedDefinitionCache(
      new TextDecoder().decode(bytes),
    );
    if (cache === null) {
      return refused(op, "its content is not an evaluated definition");
    }
    definition = cache.definition;
  } catch {
    return refused(op, "its content is not an evaluated definition");
  }
  const identity = identityRefusal(
    op.intent,
    keyFacts(op),
    declaredDefinition(definition),
  );
  if (identity !== undefined) return refused(op, identity);
  // A lookup by name scans every evaluation of the type: one may only
  // declare its own behavior's name.
  const intent = op.intent;
  const stored = "model" in intent
    ? await context.deps.resolver.model(intent.model)
    : undefined;
  return stored !== undefined && stored.definition.name !== definition.name
    ? refused(op, "its declared name is not its behavior's name")
    : undefined;
}

/**
 * An evaluated workflow: bound to the workflow its intent names, by name
 * and, for a file named by an id, by that workflow's id.
 */
async function checkEvaluatedWorkflow(
  context: ContentCheckContext,
  op: PutOp,
): Promise<ContentRefusal | undefined> {
  const intent = op.intent;
  if (!("definition" in intent)) {
    return refused(op, "it is not an evaluated workflow");
  }
  const bytes = await context.bytesOf(op);
  if (!(bytes instanceof Uint8Array)) return bytes;
  let workflow: Workflow;
  try {
    const cache = parseEvaluatedWorkflowCache(new TextDecoder().decode(bytes));
    if (cache === null) {
      return refused(op, "its content is not an evaluated workflow");
    }
    workflow = cache.workflow;
  } catch {
    return refused(op, "its content is not an evaluated workflow");
  }
  const facts = keyFacts(op);
  const identity = identityRefusal(intent, facts, {
    id: workflow.id,
    name: workflow.name,
  });
  if (identity !== undefined) return refused(op, identity);
  if (facts.fileId !== undefined) {
    const stored = await context.deps.ctx.repoContext.workflowRepo.findByName(
      intent.definition.name,
    );
    if (stored === null || stored.id.toLowerCase() !== facts.fileId) {
      return refused(
        op,
        "its file is named by an id that is not its workflow's",
      );
    }
  }
  return undefined;
}
