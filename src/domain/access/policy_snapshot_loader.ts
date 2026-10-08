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
import { Environment } from "cel-js";
import { registerArithmeticOverloads } from "../../infrastructure/cel/cel_evaluator.ts";
import {
  type ConditionTypeLiteralReader,
  findGrantSpellingIssues,
} from "./grant_spelling.ts";
import type { UnifiedDataRepository } from "../data/repositories.ts";
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

export class PolicySnapshotLoader {
  readonly #dataRepo: UnifiedDataRepository;
  readonly #unsubscribers: (() => void)[] = [];
  readonly #conditionEvaluator: ConditionEvaluator;
  #snapshot: PolicySnapshot = PolicySnapshot.empty();
  #pendingRebuild: Promise<void> = Promise.resolve();
  #rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  #cachedDecisionService: GrantBasedAccessDecisionService | null = null;
  readonly #decisionOptions: GrantBasedAccessDecisionServiceOptions;
  /** Spelling findings already reported, so a reload does not repeat them. */
  readonly #reportedSpellings = new Set<string>();
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

  async #buildSnapshotWithCounts(): Promise<{
    snapshot: PolicySnapshot;
    grantCount: number;
    groupCount: number;
  }> {
    const [grantDataItems, groupDataItems] = await Promise.all([
      this.#findAllIncludingOrphaned(GRANT_MODEL_TYPE),
      this.#findAllIncludingOrphaned(GROUP_MODEL_TYPE),
    ]);

    const grants: Grant[] = [];
    for (const { data, modelType, modelId } of grantDataItems) {
      if (data.name !== "grant-main") continue;
      const attrs = await this.#readAttributes(modelType, modelId, data.name);
      if (!attrs) continue;
      const parsed = GrantSchema.safeParse(attrs);
      if (parsed.success && parsed.data.state === "active") {
        grants.push(parsed.data);
      }
    }

    const groups: Group[] = [];
    for (const { data, modelType, modelId } of groupDataItems) {
      if (data.name !== "group-main") continue;
      const attrs = await this.#readAttributes(modelType, modelId, data.name);
      if (!attrs) continue;
      const parsed = GroupSchema.safeParse(attrs);
      if (parsed.success) {
        groups.push(parsed.data);
      }
    }

    logger
      .info`Loaded policy snapshot: ${grants.length} active grant(s), ${groups.length} group(s)`;
    for (const grant of grantsReferencingUnsupplied(grants)) {
      logger
        .warn`Grant ${grant.id} has a condition on collective or owner, which serve does not supply yet: as a deny it refuses every ${grant.resource.kind} request of its subject, and as an allow it never matches (${grant.condition})`;
    }
    this.#reportSpellings(grants);
    return {
      snapshot: new PolicySnapshot(grants, groups, this.#conditionEvaluator),
      grantCount: grants.length,
      groupCount: groups.length,
    };
  }

  /**
   * Names each active grant whose type spelling matches no type as written,
   * once per grant and spelling (swamp-club#3130). The grant keeps working
   * as it did: a deny matches its type in any spelling, an allow or a
   * condition literal only as written.
   */
  #reportSpellings(grants: readonly Grant[]): void {
    // Forget grants no longer active, so the set stays bounded by the
    // policy, and a grant that comes back is reported again.
    const active = new Set(grants.map((grant) => grant.id));
    for (const key of this.#reportedSpellings) {
      if (!active.has(key.slice(0, key.indexOf("|")))) {
        this.#reportedSpellings.delete(key);
      }
    }
    for (const grant of grants) {
      for (
        const finding of findGrantSpellingIssues(
          grant,
          this.#readTypeLiterals,
        )
      ) {
        const key = `${grant.id}|${finding.part}|${finding.written}`;
        if (this.#reportedSpellings.has(key)) continue;
        this.#reportedSpellings.add(key);
        logger
          .warn`Grant ${grant.id} (${grant.effect}, source ${grant.source}): ${finding.message}`;
      }
    }
  }

  async #readAttributes(
    modelType: ModelType,
    modelId: string,
    dataName: string,
  ): Promise<Record<string, unknown> | null> {
    const content = await this.#dataRepo.getContent(
      modelType,
      modelId,
      dataName,
    );
    if (!content) return null;
    try {
      const text = new TextDecoder().decode(content);
      return JSON.parse(text) as Record<string, unknown>;
    } catch (error) {
      logger
        .warn`Skipping ${modelType.normalized}/${modelId}/${dataName}: failed to parse JSON content: ${error}`;
      return null;
    }
  }

  async #findAllIncludingOrphaned(
    type: ModelType,
  ): Promise<Array<{ data: Data; modelType: ModelType; modelId: string }>> {
    const canonical = await this.#dataRepo.findAllForType(type);
    const orphanedType = ModelType.create(`@${type.normalized}`);
    let orphaned: Array<{ data: Data; modelType: ModelType; modelId: string }>;
    try {
      orphaned = await this.#dataRepo.findAllForType(orphanedType);
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
