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
  AccessDecision,
  AccessResource,
} from "../domain/access/access_decision_service.ts";
import type { PolicySnapshotLoader } from "../domain/access/policy_snapshot_loader.ts";
import type { Principal } from "../domain/access/principal.ts";
import type { AuthMode } from "../domain/access/serve_auth_config.ts";
import type { WorkflowRepository } from "../domain/workflows/repositories.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import {
  resolveWorkflow,
  workflowAccessFields,
} from "./handlers/workflow_handlers.ts";

const logger = getSwampLogger(["serve", "trigger-authorizer"]);

/** The outcome of authorizing a scheduled or webhook run. */
export interface TriggerAuthorization {
  readonly allowed: boolean;
  /**
   * The workflow the decision was made on. The caller runs exactly this
   * value, so authorization and execution share one identity: the canonical
   * workflow name when it resolved, the configured value otherwise.
   */
  readonly workflowIdOrName: string;
  readonly resource: AccessResource;
  readonly decision: AccessDecision | null;
  /** Why the run was refused; unset when allowed. */
  readonly reason?: string;
}

/**
 * Decides whether a service principal may run a workflow. Never throws: an
 * internal failure is a denial carrying its reason.
 */
export type TriggerAuthorizer = (
  principal: Principal,
  workflowIdOrName: string,
) => Promise<TriggerAuthorization>;

export interface TriggerAuthorizerDeps {
  readonly authMode: AuthMode;
  readonly policySnapshotLoader?: Pick<PolicySnapshotLoader, "decisionService">;
  readonly workflowRepo: WorkflowRepository;
}

/**
 * Builds the authorizer for runs no client connection stands behind. It
 * follows the WebSocket path's rules (auth mode none allows, a missing
 * policy snapshot refuses, admin on access:* is the fallback) without a
 * socket: a service principal has no collectives or IdP groups, and its
 * local groups still resolve inside the decision service.
 */
export function createTriggerAuthorizer(
  deps: TriggerAuthorizerDeps,
): TriggerAuthorizer {
  return async (principal, configured) => {
    // A workflow that does not resolve is decided on the configured value and
    // then fails in execution exactly as it did before authorization existed.
    const workflow = await resolveWorkflow(deps.workflowRepo, configured);
    const workflowIdOrName = workflow?.name ?? configured;
    const resource: AccessResource = {
      kind: "workflow",
      name: workflowIdOrName,
      fields: workflow
        ? workflowAccessFields({ name: workflow.name, tags: workflow.tags })
        : { name: configured },
    };
    const refuse = (reason: string, decision: AccessDecision | null) => ({
      allowed: false,
      workflowIdOrName,
      resource,
      decision,
      reason,
    });

    if (deps.authMode === "none") {
      return { allowed: true, workflowIdOrName, resource, decision: null };
    }
    const loader = deps.policySnapshotLoader;
    if (!loader) return refuse("access_not_configured", null);

    try {
      const accessPrincipal = { principal, collectives: [], groups: [] };
      const decision = loader.decisionService.decide(
        accessPrincipal,
        "run",
        resource,
      );
      if (decision) {
        return decision.effect === "allow"
          ? { allowed: true, workflowIdOrName, resource, decision }
          : refuse("denied", decision);
      }
      const admin = loader.decisionService.decide(
        accessPrincipal,
        "admin",
        { kind: "access", name: "*", fields: {} },
      );
      return admin?.effect === "allow"
        ? { allowed: true, workflowIdOrName, resource, decision: admin }
        : refuse("denied", null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        "Authorizing {workflow} failed, refusing the run: {error}",
        { workflow: workflowIdOrName, error: message },
      );
      return refuse(`authorization_error: ${message}`, null);
    }
  };
}
