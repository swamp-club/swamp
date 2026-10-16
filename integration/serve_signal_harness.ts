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
 * Grants and token-mode contexts for the serve signal tests
 * (swamp-club#3094, #3214), over the serve request harness.
 */

import type { ConnectionContext } from "../src/serve/handlers/shared.ts";
import type { AuditEmitter } from "../src/domain/serve_audit/audit_emitter.ts";
import type { AuditEvent } from "../src/domain/serve_audit/audit_event.ts";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import { GrantBasedAccessDecisionService } from "../src/domain/access/grant_based_access_decision_service.ts";
import { PolicySnapshot } from "../src/domain/access/policy_snapshot.ts";
import type { PolicySnapshotLoader } from "../src/domain/access/policy_snapshot_loader.ts";
import { createConditionEvaluator } from "../src/domain/access/policy_snapshot_loader.ts";
import {
  createServeCtx,
  grant,
  type ServeRepo,
} from "./serve_request_harness.ts";

/** A grant to the caller on the workflows `pattern` matches. */
export function workflowGrant(
  actions: Grant["actions"],
  pattern = "*",
  effect: Grant["effect"] = "allow",
): Grant {
  return grant({ actions, effect, resource: { kind: "workflow", pattern } });
}

/** A token-mode context enforcing `grants`, optionally recording audit events. */
export function ctxWith(
  repo: ServeRepo,
  grants: Grant[],
  options: { runImpliesSignal?: boolean; audit?: AuditEvent[] } = {},
): ConnectionContext {
  const ctx = createServeCtx(repo, grants);
  return {
    ...ctx,
    policySnapshotLoader: {
      decisionService: new GrantBasedAccessDecisionService(
        new PolicySnapshot(grants, [], createConditionEvaluator()),
        { runImpliesSignal: options.runImpliesSignal ?? true },
      ),
    } as unknown as PolicySnapshotLoader,
    ...(options.audit
      ? {
        auditEmitter: {
          emit: (event: AuditEvent) => options.audit!.push(event),
        } as unknown as AuditEmitter,
        instanceId: "test-instance",
      }
      : {}),
  };
}
