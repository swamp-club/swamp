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

import { getLogger } from "@logtape/logtape";
import { UserError } from "../errors.ts";
import { Environment } from "cel-js";
import { registerArithmeticOverloads } from "../../infrastructure/cel/cel_evaluator.ts";
import {
  type ConditionTypeLiteralReader,
  findGrantSpellingIssues,
} from "./grant_spelling.ts";
import type {
  UnifiedDataRepository,
  UnreadableModelRecord,
} from "../data/repositories.ts";
import type { EventBus } from "../events/event_bus.ts";
import type {
  DefinitionCreated,
  DefinitionUpdated,
  ModelCreated,
  ModelUpdated,
} from "../events/types.ts";
import {
  type Grant,
  GRANT_MODEL_TYPE,
  GrantSchema,
} from "../models/access/grant_model.ts";
import {
  type Group,
  GROUP_MODEL_TYPE,
  GroupSchema,
} from "../models/access/group_model.ts";
import { ModelType } from "../models/model_type.ts";
import type { Data } from "../data/data.ts";
import type { PrincipalContext } from "./principal_context.ts";
import type { ConditionEvaluator } from "./policy_snapshot.ts";
import { PolicySnapshot } from "./policy_snapshot.ts";
import type { ResourceKind } from "./resource_selector.ts";
import {
  CONDITION_FIELDS,
  conditionFieldZeroValue,
  MissingConditionFieldError,
  referencedConditionFields,
} from "./condition_fields.ts";
import {
  GrantBasedAccessDecisionService,
  type GrantBasedAccessDecisionServiceOptions,
} from "./grant_based_access_decision_service.ts";

const logger = getLogger(["swamp", "domain", "access", "policy-snapshot"]);

const GRANT_MODEL_TYPE_STR = GRANT_MODEL_TYPE.normalized;
const GROUP_MODEL_TYPE_STR = GROUP_MODEL_TYPE.normalized;

function buildCelEnvironment(kind: ResourceKind): Environment {
  const env = new Environment({ unlistedVariablesAreDyn: false });
  registerArithmeticOverloads(env);
  for (const field of CONDITION_FIELDS[kind]) {
    env.registerVariable(field.name, field.type);
  }
  env.registerVariable("principal", "map");
  return env;
}

/**
 * The evaluator serve decides grant conditions with. Before evaluating, it
 * checks which condition variables the condition references: a request field
 * the request lacks is evaluated as its zero value, and a resource field the
 * resource lacks throws {@link MissingConditionFieldError}, so a deny that
 * needs it fails closed. The check is structural — on the parsed condition —
 * never on the evaluator's error text.
 */
export function createConditionEvaluator(): ConditionEvaluator {
  const environments = new Map<ResourceKind, Environment>();
  const references = new Map<string, string[]>();
  const kinds: ResourceKind[] = [
    "workflow",
    "model",
    "data",
    "access",
    "vault",
  ];
  for (const kind of kinds) {
    environments.set(kind, buildCelEnvironment(kind));
  }

  return (
    condition: string,
    resourceKind: ResourceKind,
    resourceFields: Record<string, unknown>,
    principalContext: PrincipalContext,
  ): boolean => {
    const env = environments.get(resourceKind);
    if (!env) return false;
    const key = `${resourceKind}:${condition}`;
    let referenced = references.get(key);
    if (!referenced) {
      const parsed = env.parse(condition) as unknown as { ast: unknown };
      referenced = referencedConditionFields(parsed.ast, resourceKind);
      references.set(key, referenced);
    }
    const context: Record<string, unknown> = { ...resourceFields };
    const missing: string[] = [];
    for (const field of CONDITION_FIELDS[resourceKind]) {
      if (!referenced.includes(field.name) || field.name in context) continue;
      if (field.role === "request") {
        context[field.name] = conditionFieldZeroValue(field.type);
      } else {
        missing.push(field.name);
      }
    }
    if (missing.length > 0) throw new MissingConditionFieldError(missing);
    context.principal = principalContext;
    const result = env.evaluate(condition, context);
    return result === true;
  };
}

const referenceEnvironments = new Map<ResourceKind, Environment>();

/**
 * Whether grant `condition` on resource kind `kind` references condition
 * variable `field` (structurally, on the parsed condition). A condition that
 * does not parse counts as referencing it, so a caller that skips deciding
 * on that variable never decides on a condition it cannot read.
 */
export function conditionReferencesField(
  condition: string,
  kind: ResourceKind,
  field: string,
): boolean {
  let env = referenceEnvironments.get(kind);
  if (!env) {
    env = buildCelEnvironment(kind);
    referenceEnvironments.set(kind, env);
  }
  try {
    const parsed = env.parse(condition) as unknown as { ast: unknown };
    return referencedConditionFields(parsed.ast, kind).includes(field);
  } catch {
    return true;
  }
}

/**
 * The stored grants whose condition references a variable no handler
 * supplies yet. A deny among them now refuses every request of its kind,
 * so the loader names them.
 */
function grantsReferencingUnsupplied(grants: readonly Grant[]): Grant[] {
  return grants.filter((grant) => {
    if (!grant.condition) return false;
    const kind = grant.resource.kind;
    const unsupplied = CONDITION_FIELDS[kind]
      .filter((f) => !f.supplied)
      .map((f) => f.name);
    if (unsupplied.length === 0) return false;
    try {
      const parsed = buildCelEnvironment(kind).parse(
        grant.condition,
      ) as unknown as {
        ast: unknown;
      };
      return referencedConditionFields(parsed.ast, kind).some((name) =>
        unsupplied.includes(name)
      );
    } catch {
      return false;
    }
  });
}

export type PolicyReloadMode = "manual" | "auto";

/**
 * What a snapshot did with a grant or group record it could not read: kept
 * the deny or the group members an earlier build read, or left it out.
 */
export type UnreadableRecordOutcome =
  | "kept-last-known-deny"
  | "kept-last-known-members"
  | "left-out";

/**
 * A grant or group record that exists but could not be read or parsed by
 * the last build (swamp-club#3386).
 */
export interface UnreadableAccessRecord {
  /** `<model type>/<model id>`. */
  readonly record: string;
  readonly kind: "grant" | "group";
  readonly modelId: string;
  /** The access data the record keeps: `grant-main` or `group-main`. */
  readonly dataName: string;
  /**
   * `corrupt` when its JSON or metadata does not parse; `unrecognised` when
   * its metadata fails this build's schema, as metadata a newer swamp wrote
   * may; neither loads again by itself. `unreadable` when reading it
   * failed, as for a file this process may not read, which a retry can fix.
   */
  readonly cause: "unreadable" | "corrupt" | "unrecognised";
  /**
   * Whether it has no definition (an `@`-prefixed type), so
   * `swamp data delete` cannot reach it.
   */
  readonly orphaned: boolean;
  /** The error's class, which names the failure across retries. */
  readonly errorName: string;
  /** The error's class and message, for logs. */
  readonly error: string;
  readonly outcome: UnreadableRecordOutcome;
}

/** What a record a build could not load is, for messages. */
function problemOf(record: UnreadableAccessRecord): string {
  switch (record.cause) {
    case "corrupt":
      return "is corrupt";
    case "unrecognised":
      return "has metadata this swamp does not recognise";
    case "unreadable":
      return "cannot be read";
  }
}

/** How to fix a record a build could not load. */
function remedyFor(record: UnreadableAccessRecord): string {
  switch (record.cause) {
    case "corrupt":
      return `${
        removalFor(record)
      }, then create the ${record.kind} again if it is still wanted`;
    case "unrecognised":
      return `if a newer swamp wrote it, upgrade this one; otherwise it is corrupt: ${
        removalFor(record)
      }, then create the ${record.kind} again if it is still wanted`;
    case "unreadable":
      return "give this process read access to it (check the owner and mode of its files), then retry";
  }
}

/**
 * How to remove a record's access data: `swamp data delete`, or, for an
 * orphaned record it cannot reach, its directory.
 */
function removalFor(record: UnreadableAccessRecord): string {
  return record.orphaned
    ? `remove its directory, data/${record.record}, from the datastore (it has no definition, so \`swamp data delete\` cannot reach it)`
    : `remove it with \`swamp data delete ${record.modelId} ${record.dataName} -y\``;
}

/**
 * A loader's first build found records it could not read. Before any
 * build has succeeded there is no last-known version to fall back on, so a
 * deny among them would go unenforced; the build fails closed instead, as
 * serve's boot load and the one-shot access commands always have for a
 * content file they could not read.
 */
export class UnreadableAccessRecordsError extends UserError {
  readonly records: readonly UnreadableAccessRecord[];

  constructor(records: readonly UnreadableAccessRecord[]) {
    super(
      `Cannot build the policy snapshot: ${records.length} grant or group record(s) cannot be loaded. A record that cannot be loaded may be a deny, which would go unenforced, so the snapshot is not built until each is fixed:\n${
        records.map((r) =>
          `  - ${r.record} ${problemOf(r)} (${r.error}): ${remedyFor(r)}`
        ).join("\n")
      }`,
      "access_records_unloadable",
    );
    this.name = "UnreadableAccessRecordsError";
    this.records = records;
  }
}

/**
 * The grant a snapshot keeps for a grant record it cannot read: the version
 * an earlier build read if that was an active deny (fail closed), and
 * nothing otherwise. Leaving out an allow is fail safe; a deny never read
 * cannot be kept.
 */
export function retainedUnreadableGrant(
  lastKnown: Grant | undefined,
): Grant | null {
  if (lastKnown?.effect === "deny" && lastKnown.state === "active") {
    return lastKnown;
  }
  return null;
}

/**
 * The grants a snapshot enforces when the groups in `suspendedGroups` could
 * not be read: their last-known members still meet deny grants on them, but
 * an allow grant to such a group is suspended, so a member removed in the
 * version that cannot be read gets no allow through it.
 */
export function withoutAllowsToGroups(
  grants: readonly Grant[],
  suspendedGroups: ReadonlySet<string>,
): Grant[] {
  return grants.filter((grant) =>
    !(grant.effect === "allow" && grant.subject.kind === "group" &&
      suspendedGroups.has(grant.subject.name))
  );
}

/** The contents of a record, or why they could not be read. */
type RecordRead =
  | { attrs: Record<string, unknown> }
  | { error: unknown }
  | null;

/**
 * The record a build could not load. A parse failure (JSON or YAML, which
 * throw SyntaxError) is corrupt; metadata that fails its schema (ZodError)
 * is unrecognised, since a newer swamp may have written it; anything else,
 * such as PermissionDenied or a remote read that failed, is unreadable.
 */
function unreadableRecord(
  kind: "grant" | "group",
  modelType: ModelType,
  modelId: string,
  error: unknown,
  outcome: UnreadableRecordOutcome,
): UnreadableAccessRecord {
  const errorName = error instanceof Error ? error.name : "Error";
  const cause = error instanceof SyntaxError
    ? "corrupt"
    : errorName === "ZodError"
    ? "unrecognised"
    : "unreadable";
  return {
    record: recordKey(modelType, modelId),
    kind,
    modelId,
    dataName: `${kind}-main`,
    cause,
    orphaned: modelType.normalized.startsWith("@"),
    errorName,
    error: error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error),
    outcome,
  };
}

/** What a build's log and retry check compare a record across builds by. */
function reportedAs(record: UnreadableAccessRecord): string {
  return `${record.outcome}|${record.errorName}`;
}

function recordKey(modelType: ModelType, modelId: string): string {
  return `${modelType.normalized}/${modelId}`;
}

/** Identifies the grants and groups a build loaded, in any order. */
function snapshotSignature(
  grants: readonly Grant[],
  groups: readonly Group[],
): string {
  return JSON.stringify([
    grants.map((grant) => JSON.stringify(grant)).sort(),
    groups.map((group) => JSON.stringify(group)).sort(),
  ]);
}

export class PolicySnapshotLoader {
  readonly #dataRepo: UnifiedDataRepository;
  readonly #unsubscribers: (() => void)[] = [];
  readonly #conditionEvaluator: ConditionEvaluator;
  #snapshot: PolicySnapshot = PolicySnapshot.empty();
  #pendingRebuild: Promise<void> = Promise.resolve();
  #rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  #cachedDecisionService: GrantBasedAccessDecisionService | null = null;
  readonly #decisionOptions: GrantBasedAccessDecisionServiceOptions;
  /**
   * The grants and groups the last successful build parsed, by record, so a
   * record that later cannot be read keeps a deny or members it had.
   */
  #lastKnownGrants = new Map<string, Grant>();
  #lastKnownGroups = new Map<string, Group>();
  /** The records the last successful build could not read. */
  #unreadable: readonly UnreadableAccessRecord[] = [];
  /**
   * Each unreadable record already logged at error, with the error and
   * outcome it was logged as, so a reload that finds it the same logs at
   * debug instead of repeating the error.
   */
  #reportedUnreadable = new Map<string, string>();
  /** Whether a build has succeeded, so last-known versions exist. */
  #built = false;
  /** The grants and groups the last successful build loaded. */
  #loadedSignature = "";
  /**
   * Each active grant already checked for spellings, by id, with the effect,
   * selector and condition it was checked as, so a reload neither repeats
   * its findings nor parses its condition again.
   */
  readonly #checkedSpellings = new Map<string, string>();
  readonly #readTypeLiterals: ConditionTypeLiteralReader | undefined;

  /**
   * `readTypeLiterals` lets the loader report condition literals no type is
   * spelled as; without it only selectors are checked.
   */
  constructor(
    dataRepo: UnifiedDataRepository,
    eventBus: EventBus,
    mode: PolicyReloadMode = "auto",
    decisionOptions: GrantBasedAccessDecisionServiceOptions = {},
    readTypeLiterals?: ConditionTypeLiteralReader,
  ) {
    this.#dataRepo = dataRepo;
    this.#readTypeLiterals = readTypeLiterals;
    this.#decisionOptions = decisionOptions;
    this.#conditionEvaluator = createConditionEvaluator();

    if (mode === "auto") {
      this.#unsubscribers.push(
        eventBus.subscribe<ModelCreated>("ModelCreated", (event) => {
          if (this.#isAccessModel(event.modelType)) {
            this.#scheduleRebuild();
          }
        }),
      );

      this.#unsubscribers.push(
        eventBus.subscribe<ModelUpdated>("ModelUpdated", (event) => {
          if (this.#isAccessModel(event.modelType)) {
            this.#scheduleRebuild();
          }
        }),
      );

      this.#unsubscribers.push(
        eventBus.subscribe<DefinitionCreated>("DefinitionCreated", (event) => {
          if (this.#isAccessModel(event.modelType)) {
            this.#scheduleRebuild();
          }
        }),
      );

      this.#unsubscribers.push(
        eventBus.subscribe<DefinitionUpdated>("DefinitionUpdated", (event) => {
          if (this.#isAccessModel(event.modelType)) {
            this.#scheduleRebuild();
          }
        }),
      );
    }
  }

  get snapshot(): PolicySnapshot {
    return this.#snapshot;
  }

  /**
   * The grant and group records the last successful build could not read.
   * Empty when the snapshot is whole; otherwise a caller that can reload
   * (the access data poller) retries until it is.
   */
  get unreadable(): readonly UnreadableAccessRecord[] {
    return this.#unreadable;
  }

  get decisionService(): GrantBasedAccessDecisionService {
    if (
      !this.#cachedDecisionService ||
      this.#cachedDecisionService.snapshot !== this.#snapshot
    ) {
      this.#cachedDecisionService = new GrantBasedAccessDecisionService(
        this.#snapshot,
        this.#decisionOptions,
      );
    }
    return this.#cachedDecisionService;
  }

  async load(): Promise<PolicySnapshot> {
    const result = await this.#buildSnapshotWithCounts();
    this.#snapshot = result.snapshot;
    this.#cachedDecisionService = null;
    return this.#snapshot;
  }

  async loadWithCounts(): Promise<{
    snapshot: PolicySnapshot;
    grantCount: number;
    groupCount: number;
  }> {
    const result = await this.#buildSnapshotWithCounts();
    this.#snapshot = result.snapshot;
    this.#cachedDecisionService = null;
    return result;
  }

  async dispose(): Promise<void> {
    if (this.#rebuildTimer) {
      clearTimeout(this.#rebuildTimer);
      this.#rebuildTimer = null;
    }
    for (const unsub of this.#unsubscribers) {
      unsub();
    }
    this.#unsubscribers.length = 0;
    await this.#pendingRebuild;
  }

  #isAccessModel(modelType: string): boolean {
    return modelType === GRANT_MODEL_TYPE_STR ||
      modelType === GROUP_MODEL_TYPE_STR;
  }

  /**
   * Builds the snapshot. A record that cannot be read never fails the
   * build (swamp-club#3386): an active deny or the group members an earlier
   * build read stay in force, and anything else is left out. The first
   * build has nothing to fall back on, so it throws
   * {@link UnreadableAccessRecordsError} instead. The records' last-known
   * versions and the unreadable list are committed only when the build
   * succeeds, so a build that throws leaves them as they were.
   */
  async #buildSnapshotWithCounts(): Promise<{
    snapshot: PolicySnapshot;
    grantCount: number;
    groupCount: number;
  }> {
    const unreadableGrants: UnreadableModelRecord[] = [];
    const unreadableGroups: UnreadableModelRecord[] = [];
    const [grantDataItems, groupDataItems] = await Promise.all([
      this.#findAllIncludingOrphaned(GRANT_MODEL_TYPE, unreadableGrants),
      this.#findAllIncludingOrphaned(GROUP_MODEL_TYPE, unreadableGroups),
    ]);

    const lastKnownGrants = new Map<string, Grant>();
    const lastKnownGroups = new Map<string, Group>();
    const unreadable: UnreadableAccessRecord[] = [];

    let grants: Grant[] = [];
    for (const { data, modelType, modelId } of grantDataItems) {
      if (data.name !== "grant-main") continue;
      const read = await this.#readRecord(modelType, modelId, data.name);
      if (!read) continue;
      if ("error" in read) {
        unreadableGrants.push({ modelType, modelId, error: read.error });
        continue;
      }
      const parsed = GrantSchema.safeParse(read.attrs);
      if (!parsed.success) continue;
      lastKnownGrants.set(recordKey(modelType, modelId), parsed.data);
      if (parsed.data.state === "active") grants.push(parsed.data);
    }
    for (const { modelType, modelId, error } of unreadableGrants) {
      const record = recordKey(modelType, modelId);
      const last = this.#lastKnownGrants.get(record);
      if (last) lastKnownGrants.set(record, last);
      const kept = retainedUnreadableGrant(last);
      if (kept) grants.push(kept);
      unreadable.push(
        unreadableRecord(
          "grant",
          modelType,
          modelId,
          error,
          kept ? "kept-last-known-deny" : "left-out",
        ),
      );
    }

    const groups: Group[] = [];
    const suspendedGroups = new Set<string>();
    for (const { data, modelType, modelId } of groupDataItems) {
      if (data.name !== "group-main") continue;
      const read = await this.#readRecord(modelType, modelId, data.name);
      if (!read) continue;
      if ("error" in read) {
        unreadableGroups.push({ modelType, modelId, error: read.error });
        continue;
      }
      const parsed = GroupSchema.safeParse(read.attrs);
      if (!parsed.success) continue;
      lastKnownGroups.set(recordKey(modelType, modelId), parsed.data);
      groups.push(parsed.data);
    }
    for (const { modelType, modelId, error } of unreadableGroups) {
      const record = recordKey(modelType, modelId);
      const last = this.#lastKnownGroups.get(record);
      if (last) {
        lastKnownGroups.set(record, last);
        groups.push(last);
        suspendedGroups.add(last.name);
      }
      unreadable.push(
        unreadableRecord(
          "group",
          modelType,
          modelId,
          error,
          last ? "kept-last-known-members" : "left-out",
        ),
      );
    }
    grants = withoutAllowsToGroups(grants, suspendedGroups);
    if (!this.#built && unreadable.length > 0) {
      throw new UnreadableAccessRecordsError(unreadable);
    }

    // The poller rebuilds every cycle while records cannot be read; a build
    // that finds them as the last one did is a retry, logged at debug.
    // It must also load the same grants and groups: a peer's change in the
    // same cycle is logged, and warned about, as usual.
    const loaded = snapshotSignature(grants, groups);
    const retry = unreadable.length > 0 &&
      loaded === this.#loadedSignature &&
      unreadable.length === this.#reportedUnreadable.size &&
      unreadable.every((u) =>
        this.#reportedUnreadable.get(u.record) === reportedAs(u)
      );
    if (retry) {
      logger
        .debug`Loaded policy snapshot: ${grants.length} active grant(s), ${groups.length} group(s)`;
    } else {
      logger
        .info`Loaded policy snapshot: ${grants.length} active grant(s), ${groups.length} group(s)`;
    }
    for (const grant of retry ? [] : grantsReferencingUnsupplied(grants)) {
      logger
        .warn`Grant ${grant.id} has a condition on collective or owner, which serve does not supply yet: as a deny it refuses every ${grant.resource.kind} request of its subject, and as an allow it never matches (${grant.condition})`;
    }
    this.#reportSpellings(grants);
    const snapshot = new PolicySnapshot(
      grants,
      groups,
      this.#conditionEvaluator,
    );
    this.#reportUnreadable(unreadable, lastKnownGrants, lastKnownGroups);
    this.#lastKnownGrants = lastKnownGrants;
    this.#lastKnownGroups = lastKnownGroups;
    this.#unreadable = unreadable;
    this.#loadedSignature = loaded;
    this.#built = true;
    return {
      snapshot,
      grantCount: grants.length,
      groupCount: groups.length,
    };
  }

  /**
   * Logs each unreadable record at error the first time it is found with a
   * given error and outcome, at debug while it stays that way, and at info
   * once it is no longer found unreadable.
   */
  #reportUnreadable(
    unreadable: readonly UnreadableAccessRecord[],
    lastKnownGrants: ReadonlyMap<string, Grant>,
    lastKnownGroups: ReadonlyMap<string, Group>,
  ): void {
    const reported = new Map<string, string>();
    for (const entry of unreadable) {
      const { record, error, outcome } = entry;
      reported.set(record, reportedAs(entry));
      if (this.#reportedUnreadable.get(record) === reported.get(record)) {
        logger
          .debug`Access record ${record} still cannot be read (${error}): ${outcome}`;
        continue;
      }
      if (entry.kind === "grant") {
        const last = lastKnownGrants.get(record);
        if (outcome === "kept-last-known-deny") {
          logger
            .error`Grant record ${record} cannot be read (${error}): its last-known deny ${last?.id} stays in force until it can be read again`;
        } else if (last) {
          logger
            .error`Grant record ${record} cannot be read (${error}): its ${last.effect} grant ${last.id} (${last.state}) is left out until it can be read again`;
        } else {
          logger
            .error`Grant record ${record} cannot be read (${error}) and was never read by this process: it is not enforced, so if it is a deny, what it denies is allowed until it can be read`;
        }
      } else {
        const last = lastKnownGroups.get(record);
        if (last) {
          logger
            .error`Group record ${record} cannot be read (${error}): group ${last.name} keeps its last-known members for deny grants, and allow grants to the group are suspended, until it can be read again. Allow conditions that test membership of the group still see those members`;
        } else {
          logger
            .error`Group record ${record} cannot be read (${error}) and was never read by this process: deny grants on its group do not apply until it can be read`;
        }
      }
      if (entry.cause !== "unreadable") {
        logger
          .error`Access record ${record} ${
          problemOf(entry)
        } and will not load again by itself: ${remedyFor(entry)}`;
      }
    }
    for (const record of this.#reportedUnreadable.keys()) {
      if (!reported.has(record)) {
        logger.info`Access record ${record} is no longer unreadable`;
      }
    }
    this.#reportedUnreadable = reported;
  }

  /**
   * Names each active grant whose type spelling matches no type as written,
   * once per grant and spelling (swamp-club#3130). The grant keeps working
   * as it did: a deny matches its type in any spelling, an allow or a
   * condition literal only as written.
   */
  #reportSpellings(grants: readonly Grant[]): void {
    // Forget grants no longer active, so the map stays bounded by the
    // policy, and a grant that comes back is reported again.
    const active = new Set(grants.map((grant) => grant.id));
    for (const id of this.#checkedSpellings.keys()) {
      if (!active.has(id)) this.#checkedSpellings.delete(id);
    }
    for (const grant of grants) {
      const checkedAs = JSON.stringify([
        grant.effect,
        grant.resource,
        grant.condition ?? null,
      ]);
      if (this.#checkedSpellings.get(grant.id) === checkedAs) continue;
      this.#checkedSpellings.set(grant.id, checkedAs);
      for (
        const finding of findGrantSpellingIssues(
          grant,
          this.#readTypeLiterals,
        )
      ) {
        logger
          .warn`Grant ${grant.id} (${grant.effect}, source ${grant.source}): ${finding.message}`;
      }
    }
  }

  /**
   * A record's parsed JSON, null when it has no content, or the error that
   * kept it from being read or parsed.
   */
  async #readRecord(
    modelType: ModelType,
    modelId: string,
    dataName: string,
  ): Promise<RecordRead> {
    let content: Uint8Array | null;
    try {
      content = await this.#dataRepo.getContent(modelType, modelId, dataName);
    } catch (error) {
      return { error };
    }
    if (!content) return null;
    try {
      const text = new TextDecoder().decode(content);
      return { attrs: JSON.parse(text) as Record<string, unknown> };
    } catch (error) {
      return { error };
    }
  }

  async #findAllIncludingOrphaned(
    type: ModelType,
    unreadable: UnreadableModelRecord[],
  ): Promise<Array<{ data: Data; modelType: ModelType; modelId: string }>> {
    const canonical = await this.#dataRepo.findAllForType(type, {
      unreadable,
    });
    const orphanedType = ModelType.create(`@${type.normalized}`);
    let orphaned: Array<{ data: Data; modelType: ModelType; modelId: string }>;
    try {
      orphaned = await this.#dataRepo.findAllForType(orphanedType, {
        unreadable,
      });
    } catch {
      orphaned = [];
    }
    return [...canonical, ...orphaned];
  }

  #scheduleRebuild(): void {
    if (this.#rebuildTimer) clearTimeout(this.#rebuildTimer);
    this.#rebuildTimer = setTimeout(() => {
      this.#rebuildTimer = null;
      this.#pendingRebuild = this.#pendingRebuild.then(() => this.#rebuild());
    }, 500);
  }

  async #rebuild(): Promise<void> {
    try {
      const result = await this.#buildSnapshotWithCounts();
      this.#snapshot = result.snapshot;
      this.#cachedDecisionService = null;
    } catch (error) {
      logger.error`Failed to rebuild policy snapshot: ${error}`;
    }
  }
}
