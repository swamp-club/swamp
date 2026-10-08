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
import { shown } from "./expression_reference_authorization.ts";

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
  computedModelRun?: { raw: string; unanalyzable: boolean },
): Promise<string | undefined> {
  // An expression that runs a model it computes (`model.method(inputs.m,
  // ...)`) can run any model, as a computed step target can.
  if (
    computedModelRun !== undefined &&
    !isAuthorized(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields: {},
    }, ctx)
  ) {
    return computedModelRun.unanalyzable
      ? `Access denied: expression ${
        shown(computedModelRun.raw)
      } could not be analyzed, and one that may run a model method needs ` +
        `admin`
      : `Access denied: expression ${
        shown(computedModelRun.raw)
      } runs a model method it computes, which needs admin`;
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

/**
 * Checks the stored steps an edit changes. A run of the workflow invokes a
 * step's model with whatever inputs the step holds, so changing a stored
 * step that runs a restricted or control-plane model changes what that
 * model runs with, and needs admin as adding it does (swamp-club#3131). A
 * changed step whose model is computed may run any model, so it needs admin
 * too. Other changed steps need nothing more: their target was checked when
 * added. Returns a refusal message, or undefined when all are allowed.
 */
export async function authorizeChangedSteps(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
  ctx: ConnectionContext,
  targets: readonly StepTarget[],
): Promise<string | undefined> {
  for (const target of targets) {
    if (target.kind === "workflow") continue;
    const fields = await adminOnlyStepFields(ctx, target);
    if (
      fields &&
      !isAuthorized(socket, requestId, principal, "admin", {
        kind: "access",
        name: "*",
        fields,
      }, ctx)
    ) {
      return `Access denied: a workflow step changed here runs ${
        describe(target)
      }, which needs admin`;
    }
  }
  return undefined;
}

/**
 * The fields to judge admin on when a model step needs it — a computed
 * target, an unreadable definition, or a restricted or control-plane type —
 * or undefined when it does not.
 */
async function adminOnlyStepFields(
  ctx: ConnectionContext,
  target: Exclude<StepTarget, { kind: "workflow" }>,
): Promise<Record<string, unknown> | undefined> {
  if (isComputedStepTarget(target)) return {};
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
    // A target whose fields cannot be read cannot be judged; require admin.
    return {};
  }
  const typeArg = target.kind === "direct" ? target.modelType : undefined;
  if (
    !isAdminOnlyModelType(
      typeArg,
      definition?.type.normalized,
      ctx.authConfig.restrictedModelTypes,
    )
  ) return undefined;
  // Without a definition only a direct step's type can restrict it.
  const base = definition
    ? modelAccessResource(definition, "model").fields
    : { name, modelType: normalizedType(typeArg ?? name), tags: {} };
  return { ...base, methodName: target.methodName };
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
