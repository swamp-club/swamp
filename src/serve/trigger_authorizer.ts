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
import type { Workflow } from "../domain/workflows/workflow.ts";
import { createWorkflowId } from "../domain/workflows/workflow_id.ts";
import { workflowAccessFields } from "./handlers/workflow_handlers.ts";

const logger = getSwampLogger(["serve", "trigger-authorizer"]);

export interface TriggerAuthorization {
  readonly allowed: boolean;
  /**
   * the configured value itself: execution resolves it name-first then by id,
   * as the authorizer did, so it reaches the decided workflow; running the
   * resolved name could reach a different workflow that shadows it
   */
  readonly workflowIdOrName: string;
  readonly workflowId?: string;
  readonly resource: AccessResource;
  readonly decision: AccessDecision | null;
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
 * follows the WebSocket path's rules without a socket: a service principal has
 * no collectives or IdP groups, and its local groups still resolve in the
 * decision service
 */
export function createTriggerAuthorizer(
  deps: TriggerAuthorizerDeps,
): TriggerAuthorizer {
  return async (principal, configured) => {
    // a workflow that does not exist is decided on the configured value and
    // fails in execution as before; a lookup that throws refuses, since
    // deciding without the name and tags would skip denies written against them
    let workflow: Workflow | null = null;
    let lookupError: string | undefined;
    try {
      workflow = await deps.workflowRepo.findByName(configured) ??
        await deps.workflowRepo.findById(createWorkflowId(configured));
    } catch (error) {
      lookupError = error instanceof Error ? error.message : String(error);
    }
    // Resolved in the same order execution uses (findByName, then findById).
    const workflowIdOrName = configured;
    const workflowId = workflow?.id;
    const resource: AccessResource = {
      kind: "workflow",
      name: workflow?.name ?? configured,
      fields: workflow
        ? workflowAccessFields({ name: workflow.name, tags: workflow.tags })
        : { name: configured },
    };
    const refuse = (reason: string, decision: AccessDecision | null) => ({
      allowed: false,
      workflowIdOrName,
      workflowId,
      resource,
      decision,
      reason,
    });

    if (deps.authMode === "none") {
      return {
        allowed: true,
        workflowIdOrName,
        workflowId,
        resource,
        decision: null,
      };
    }
    if (lookupError !== undefined) {
      logger.error(
        "Looking up {workflow} failed, refusing the run: {error}",
        { workflow: configured, error: lookupError },
      );
      return refuse(`authorization_error: ${lookupError}`, null);
    }
    const loader = deps.policySnapshotLoader;
    if (!loader) {
      return refuse(
        "authorization is enabled but no policy snapshot is loaded",
        null,
      );
    }

    try {
      const accessPrincipal = {
        principal,
        collectives: [],
        groups: [],
        client: undefined,
        delegation: undefined,
      };
      const decision = loader.decisionService.decide(
        accessPrincipal,
        "run",
        resource,
      );
      if (decision) {
        return decision.effect === "allow"
          ? { allowed: true, workflowIdOrName, workflowId, resource, decision }
          : refuse(`denied by grant ${decision.grantId}`, decision);
      }
      const admin = loader.decisionService.decide(
        accessPrincipal,
        "admin",
        { kind: "access", name: "*", fields: {} },
      );
      return admin?.effect === "allow"
        ? {
          allowed: true,
          workflowIdOrName,
          workflowId,
          resource,
          decision: admin,
        }
        : refuse("no grant allows it", null);
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
