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
 * the serve layer implements the policy from the triggering principal's
 * grants; the domain never sees grants. Carried by the run's RunVaultAccess
 * scope, so every entry site that holds a run to its principal holds its steps
 */

import { UserError } from "../errors.ts";

export type StepAccessTarget =
  | {
    readonly kind: "behavior";
    /** the name a grant selects: the authored one, never a per-worker copy's */
    readonly name: string;
    readonly modelType: string;
    readonly tags: Readonly<Record<string, string>>;
    readonly methodName: string;
    /** a step that names a type to execute is judged on the type as well */
    readonly typeExecution: boolean;
  }
  | {
    readonly kind: "workflow";
    readonly name: string;
    readonly tags: Readonly<Record<string, string>>;
  };

export interface StepAccessDecision {
  readonly allowed: boolean;
  readonly grantId?: string;
  readonly reason: string;
}

export interface StepPrincipalPolicy {
  readonly principal: string;
  /** a policy that would allow every step lets the run skip building targets */
  active?(): boolean;
  decide(
    target: StepAccessTarget,
  ): StepAccessDecision | Promise<StepAccessDecision>;
}

export interface StepAccessDenial {
  readonly target: StepAccessTarget;
  readonly principal: string;
  readonly grantId?: string;
  readonly reason: string;
}

export type StepAccessDeniedHook = (
  denial: StepAccessDenial,
) => void | Promise<void>;

export class StepAccessDeniedError extends UserError {
  constructor(readonly denial: StepAccessDenial) {
    super(describeStepDenial(denial), "step_access_denied");
    this.name = "StepAccessDeniedError";
  }
}

export function stepTargetLabel(target: StepAccessTarget): string {
  return target.kind === "behavior"
    ? `behavior '${target.name}' (method '${target.methodName}')`
    : `workflow '${target.name}'`;
}

function describeStepDenial(denial: StepAccessDenial): string {
  return `Running ${
    stepTargetLabel(denial.target)
  } is refused for ${denial.principal}: ${denial.reason}`;
}
