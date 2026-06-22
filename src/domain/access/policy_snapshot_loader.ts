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
import type { DataRecord } from "../data/data_record.ts";
import type { DataQueryService } from "../data/data_query_service.ts";
import type { EventBus } from "../events/event_bus.ts";
import type { ModelCreated, ModelUpdated } from "../events/types.ts";
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
import type { PrincipalContext } from "./principal_context.ts";
import type { ConditionEvaluator } from "./policy_snapshot.ts";
import { PolicySnapshot } from "./policy_snapshot.ts";
import type { ResourceKind } from "./resource_selector.ts";
import { GrantBasedAccessDecisionService } from "./grant_based_access_decision_service.ts";

const logger = getLogger(["swamp", "domain", "access", "policy-snapshot"]);

const GRANT_MODEL_TYPE_STR = GRANT_MODEL_TYPE.normalized;
const GROUP_MODEL_TYPE_STR = GROUP_MODEL_TYPE.normalized;

const RESOURCE_FIELDS: Record<ResourceKind, string[]> = {
  workflow: ["name", "tags", "collective"],
  model: ["name", "modelType", "tags", "collective"],
  data: ["name", "ns", "tags", "owner"],
  access: ["name"],
};

function buildCelEnvironment(kind: ResourceKind): Environment {
  const env = new Environment({ unlistedVariablesAreDyn: false });
  registerArithmeticOverloads(env);

  for (const field of RESOURCE_FIELDS[kind]) {
    env.registerVariable(
      field,
      field === "tags" || field === "owner"
        ? "map"
        : field === "name" || field === "ns" || field === "modelType" ||
            field === "collective"
        ? "string"
        : "dyn",
    );
  }

  env.registerVariable("principal", "map");
  return env;
}

function buildConditionEvaluator(): ConditionEvaluator {
  const environments = new Map<ResourceKind, Environment>();
  const kinds: ResourceKind[] = ["workflow", "model", "data", "access"];
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
    const context: Record<string, unknown> = { ...resourceFields };
    context.principal = principalContext;
    const result = env.evaluate(condition, context);
    return result === true;
  };
}

export type PolicyReloadMode = "manual" | "auto";

export class PolicySnapshotLoader {
  readonly #dataQueryService: DataQueryService;
  readonly #unsubscribers: (() => void)[] = [];
  readonly #conditionEvaluator: ConditionEvaluator;
  #snapshot: PolicySnapshot = PolicySnapshot.empty();
  #pendingRebuild: Promise<void> = Promise.resolve();
  #rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  #cachedDecisionService: GrantBasedAccessDecisionService | null = null;

  constructor(
    dataQueryService: DataQueryService,
    eventBus: EventBus,
    mode: PolicyReloadMode = "auto",
  ) {
    this.#dataQueryService = dataQueryService;
    this.#conditionEvaluator = buildConditionEvaluator();

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
    const [grantRecords, groupRecords] = await Promise.all([
      this.#dataQueryService.query(
        `modelType == "${GRANT_MODEL_TYPE_STR}"`,
        { loadAttributes: true },
      ),
      this.#dataQueryService.query(
        `modelType == "${GROUP_MODEL_TYPE_STR}"`,
        { loadAttributes: true },
      ),
    ]);

    const grants: Grant[] = [];
    for (const record of grantRecords) {
      const attrs = (record as DataRecord).attributes;
      const parsed = GrantSchema.safeParse(attrs);
      if (parsed.success && parsed.data.state === "active") {
        grants.push(parsed.data);
      }
    }

    const groups: Group[] = [];
    for (const record of groupRecords) {
      const attrs = (record as DataRecord).attributes;
      const parsed = GroupSchema.safeParse(attrs);
      if (parsed.success) {
        groups.push(parsed.data);
      }
    }

    logger
      .info`Loaded policy snapshot: ${grants.length} active grant(s), ${groups.length} group(s)`;
    return {
      snapshot: new PolicySnapshot(grants, groups, this.#conditionEvaluator),
      grantCount: grants.length,
      groupCount: groups.length,
    };
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
