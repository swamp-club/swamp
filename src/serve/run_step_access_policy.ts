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

import type {
  AccessPrincipal,
  AccessResource,
} from "../domain/access/access_decision_service.ts";
import type { Action } from "../domain/access/action.ts";
import { workflowAccessResource } from "../domain/access/access_resources.ts";
import type {
  StepAccessDecision,
  StepAccessTarget,
  StepPrincipalPolicy,
} from "../domain/vaults/run_step_access.ts";
import { isAdminOnlyModelType } from "./handlers/shared.ts";
import type {
  RunVaultDecisionService,
  ServeRunVaultPolicy,
} from "./run_vault_access_policy.ts";

export interface StepRules {
  readonly stepsRequireExplicitGrant: boolean;
  readonly restrictedModelTypes: readonly string[];
}

export interface RunStepPolicyDeps {
  readonly policySnapshotLoader?: {
    readonly decisionService: RunVaultDecisionService;
  };
  /** read on every decision, so a reload applies to a run's next step */
  readonly stepRules: () => StepRules;
}

export class ServeRunStepPolicy implements StepPrincipalPolicy {
  readonly #deps: RunStepPolicyDeps;
  readonly #principalOf: ServeRunVaultPolicy;

  constructor(deps: RunStepPolicyDeps, principalOf: ServeRunVaultPolicy) {
    this.#deps = deps;
    this.#principalOf = principalOf;
  }

  get principal(): string {
    return this.#principalOf.principal;
  }

  active(): boolean {
    return this.#deps.stepRules().stepsRequireExplicitGrant;
  }

  async decide(target: StepAccessTarget): Promise<StepAccessDecision> {
    const rules = this.#deps.stepRules();
    if (!rules.stepsRequireExplicitGrant) {
      return { allowed: true, reason: "steps-require-explicit-grant is off" };
    }
    const service = this.#deps.policySnapshotLoader?.decisionService;
    if (!service) {
      return { allowed: false, reason: "no policy snapshot is loaded" };
    }
    const principal = await this.#principalOf.accessPrincipal();
    if (principal === null) {
      return {
        allowed: false,
        reason:
          `the run's principal cannot be judged: ${this.#principalOf.unavailableReason}`,
      };
    }
    for (const [action, resource] of requirements(target, rules)) {
      const decision = decideOne(service, principal, action, resource);
      if (!decision.allowed) return decision;
    }
    return { allowed: true, reason: "allowed" };
  }
}

function requirements(
  target: StepAccessTarget,
  rules: StepRules,
): Array<readonly [Action, AccessResource]> {
  if (target.kind === "workflow") {
    return [["run", workflowAccessResource(target)]];
  }
  const fields = {
    name: target.name,
    modelType: target.modelType,
    tags: { ...target.tags },
    methodName: target.methodName,
  };
  if (
    isAdminOnlyModelType(
      target.typeExecution ? target.modelType : undefined,
      target.modelType,
      rules.restrictedModelTypes,
    )
  ) {
    return [["admin", { kind: "access", name: "*", fields }]];
  }
  const needed: Array<readonly [Action, AccessResource]> = [
    ["run", { kind: "model", name: target.name, fields }],
  ];
  if (target.typeExecution) {
    // every field present, so a conditional deny decides rather than fails closed
    needed.push(["run", {
      kind: "model",
      name: target.modelType,
      fields: {
        name: target.modelType,
        modelType: target.modelType,
        tags: {},
        methodName: target.methodName,
      },
    }]);
  }
  return needed;
}

function decideOne(
  service: RunVaultDecisionService,
  principal: AccessPrincipal,
  action: Action,
  resource: AccessResource,
): StepAccessDecision {
  const decision = service.decide(principal, action, resource);
  if (decision?.effect === "allow") {
    return { allowed: true, grantId: decision.grantId, reason: "allowed" };
  }
  const on = `${resource.kind}:${resource.name}`;
  const required = { action, kind: resource.kind, name: resource.name };
  if (decision?.effect === "deny") {
    return {
      allowed: false,
      grantId: decision.grantId,
      reason: `explicitly denied '${action}' on ${on}`,
      required,
    };
  }
  return {
    allowed: false,
    reason: `does not have '${action}' on ${on}`,
    required,
  };
}
