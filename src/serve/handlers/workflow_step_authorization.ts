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
 * Authorizes the steps a workflow edit adds against the writer. A run of a
 * workflow invokes its steps' models and nested workflows under only the
 * workflow's own `run` grant, so whoever adds a step must be allowed to run
 * what it targets. Steps already stored are not re-checked, so users running
 * a workflow an admin wrote are unaffected.
 */

import type { AccessResource } from "../../domain/access/access_decision_service.ts";
import type { Principal } from "../../domain/access/principal.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import {
  isComputedStepTarget,
  type StepTarget,
} from "../../domain/workflows/step_targets.ts";
import { findWorkflowByIdOrName } from "../../domain/workflows/workflow_lookup.ts";
import {
  modelAccessResource,
  unresolvedAccessResource,
  workflowAccessResource,
} from "./resource_resolution.ts";
import {
  type ConnectionContext,
  isAdminOnlyModelType,
  isAuthorized,
  isAuthorizedForAll,
} from "./shared.ts";

/**
 * Checks each target against `principal`. Returns a refusal message for the
 * first one the principal may not run, worded the same whether the target
 * exists or is denied, or undefined when all are allowed. Refusals are
 * audited; nothing is sent.
 */
export async function authorizeStepTargets(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
  ctx: ConnectionContext,
  targets: readonly StepTarget[],
  runsComputedModel = false,
): Promise<string | undefined> {
  // An expression that runs a model it computes (`model.method(inputs.m,
  // ...)`) can run any model, as a computed step target can.
  if (
    runsComputedModel &&
    !isAuthorized(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields: {},
    }, ctx)
  ) {
    return "Access denied: an expression added here runs a model method " +
      "it computes, which needs admin";
  }
  for (const target of targets) {
    if (!await stepAllowed(socket, requestId, principal, ctx, target)) {
      return `Access denied: a workflow step added here runs ${
        describe(target)
      }`;
    }
  }
  return undefined;
}

function describe(target: StepTarget): string {
  switch (target.kind) {
    case "model":
      return `model ${target.modelIdOrName} method ${target.methodName}`;
    case "direct":
      return `model ${target.modelName} (${target.modelType}) method ${target.methodName}`;
    case "workflow":
      return `workflow ${target.workflowIdOrName}`;
  }
}

async function stepAllowed(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
  ctx: ConnectionContext,
  target: StepTarget,
): Promise<boolean> {
  const allowed = (action: "run" | "admin", resource: AccessResource) =>
    isAuthorized(socket, requestId, principal, action, resource, ctx);
  const restricted = ctx.authConfig.restrictedModelTypes;

  if (isComputedStepTarget(target)) {
    // The run decides the target. A nested workflow needs run on every
    // workflow; a model can be any model, a restricted or control-plane one
    // included, which the engine does not gate, so it needs admin.
    return target.kind === "workflow"
      ? isAuthorizedForAll(
        socket,
        requestId,
        principal,
        "run",
        "workflow",
        ctx,
      )
      : allowed("admin", { kind: "access", name: "*", fields: {} });
  }

  if (target.kind === "workflow") {
    let workflow = null;
    try {
      workflow = await findWorkflowByIdOrName(
        ctx.repoContext.workflowRepo,
        target.workflowIdOrName,
      );
    } catch {
      // A target whose fields cannot be read cannot be judged; refuse.
      return false;
    }
    return allowed(
      "run",
      workflow
        ? workflowAccessResource(workflow)
        : unresolvedAccessResource("workflow", target.workflowIdOrName),
    );
  }

  const name = target.kind === "model"
    ? target.modelIdOrName
    : target.modelName;
  let definition = null;
  try {
    definition = await findDefinitionByIdOrName(
      ctx.repoContext.definitionRepo,
      name,
    );
  } catch {
    // A target whose fields cannot be read cannot be judged; refuse.
    return false;
  }
  const typeArg = target.kind === "direct" ? target.modelType : undefined;
  const base = definition
    ? modelAccessResource(definition, "model")
    : target.kind === "direct"
    ? {
      kind: "model" as const,
      name,
      fields: { name, modelType: normalizedType(target.modelType), tags: {} },
    }
    : unresolvedAccessResource("model", name);
  const resource: AccessResource = {
    ...base,
    fields: { ...base.fields, methodName: target.methodName },
  };
  if (
    isAdminOnlyModelType(typeArg, definition?.type.normalized, restricted)
  ) {
    return allowed("admin", {
      kind: "access",
      name: "*",
      fields: resource.fields,
    });
  }
  if (!allowed("run", resource)) return false;
  if (typeArg) {
    const type = normalizedType(typeArg);
    return allowed("run", {
      kind: "model",
      name: type,
      fields: {
        name: type,
        modelType: type,
        tags: {},
        methodName: target.methodName,
      },
    });
  }
  return true;
}

function normalizedType(typeArg: string): string {
  try {
    return ModelType.create(typeArg).normalized;
  } catch {
    return typeArg;
  }
}
