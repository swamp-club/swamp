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

const logger = getLogger(["swamp", "domain", "access", "policy-snapshot"]);

const GRANT_MODEL_TYPE_STR = GRANT_MODEL_TYPE.normalized;
const GROUP_MODEL_TYPE_STR = GROUP_MODEL_TYPE.normalized;

const RESOURCE_FIELDS: Record<ResourceKind, string[]> = {
  workflow: ["name", "tags", "collective"],
  model: ["modelType", "collective"],
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

export class PolicySnapshotLoader {
  readonly #dataQueryService: DataQueryService;
  readonly #unsubscribers: (() => void)[] = [];
  readonly #conditionEvaluator: ConditionEvaluator;
  #snapshot: PolicySnapshot = PolicySnapshot.empty();

  constructor(dataQueryService: DataQueryService, eventBus: EventBus) {
    this.#dataQueryService = dataQueryService;
    this.#conditionEvaluator = buildConditionEvaluator();

    this.#unsubscribers.push(
      eventBus.subscribe<ModelCreated>("ModelCreated", (event) => {
        if (this.#isAccessModel(event.modelType)) {
          this.#rebuild();
        }
      }),
    );

    this.#unsubscribers.push(
      eventBus.subscribe<ModelUpdated>("ModelUpdated", (event) => {
        if (this.#isAccessModel(event.modelType)) {
          this.#rebuild();
        }
      }),
    );
  }

  get snapshot(): PolicySnapshot {
    return this.#snapshot;
  }

  async load(): Promise<PolicySnapshot> {
    this.#snapshot = await this.#buildSnapshot();
    return this.#snapshot;
  }

  dispose(): void {
    for (const unsub of this.#unsubscribers) {
      unsub();
    }
    this.#unsubscribers.length = 0;
  }

  #isAccessModel(modelType: string): boolean {
    return modelType === GRANT_MODEL_TYPE_STR ||
      modelType === GROUP_MODEL_TYPE_STR;
  }

  async #buildSnapshot(): Promise<PolicySnapshot> {
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
    return new PolicySnapshot(grants, groups, this.#conditionEvaluator);
  }

  async #rebuild(): Promise<void> {
    try {
      this.#snapshot = await this.#buildSnapshot();
    } catch (error) {
      logger.error`Failed to rebuild policy snapshot: ${error}`;
    }
  }
}
