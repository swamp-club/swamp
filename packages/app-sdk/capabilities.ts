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

/** A read an app can ask an operator for. */
export const APP_READ_CAPABILITIES = [
  "runs:read",
  "data:read",
  "catalog:read",
  "health:read",
  "workers:read",
] as const;

export type AppReadCapability = typeof APP_READ_CAPABILITIES[number];

/**
 * Reads behind an experimental gate. Serve accepts one in `app.yaml` only
 * while the gate is on, so a grant never carries it otherwise.
 */
export const GATED_APP_READ_CAPABILITIES = ["federation:read"] as const;

export type GatedAppReadCapability = typeof GATED_APP_READ_CAPABILITIES[number];

/** Requests each capability lets through; anything absent is refused. */
export const CAPABILITY_REQUESTS: Readonly<
  Record<AppReadCapability | GatedAppReadCapability, readonly string[]>
> = {
  "runs:read": [
    "workflow.run.search",
    "workflow.run.summary",
    "workflow.history.get",
    "workflow.history.logs",
    "workflow.history.search",
    "model.usage.summary",
    // live events of a run serve already lets the viewer start
    "run.attach",
  ],
  "data:read": [
    "data.get",
    "data.query",
    "data.search",
    "data.versions",
    "model.output.search",
    // only changes to data the viewer could read anyway, never content
    "data.subscribe",
  ],
  "catalog:read": [
    "workflow.search",
    "workflow.get",
    "model.search",
    "model.get",
  ],
  "health:read": [],
  "workers:read": ["worker.list"],
  "federation:read": ["federation.member.list", "federation.member.get"],
};

/** The one write an app can be granted, for the workflows it names. */
export const RUN_REQUEST = "workflow.run";

/** The other write: methods of the behaviors it names. */
export const METHOD_REQUEST = "model.method.run";

/** Stops following a request, not the run; allowed for an app's own requests. */
export const CANCEL_REQUEST = "cancel";

/** Answers the version handshake, which names nothing. */
export const ALWAYS_ALLOWED_REQUESTS: readonly string[] = ["server.version"];

/** The type is pinned: a request can name its own type, and `command/shell` under a listed name would run anything. */
export interface AppMethodGrant {
  readonly behavior: string;
  readonly type: string;
  readonly methods: readonly string[];
}

export interface AppGrant {
  readonly capabilities: readonly string[];
  readonly run: readonly string[];
  readonly methods: readonly AppMethodGrant[];
}

export type RequestDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export function isAppReadCapability(
  value: string,
): value is AppReadCapability {
  return (APP_READ_CAPABILITIES as readonly string[]).includes(value);
}

/** A gated read, which `app.yaml` may name only while its gate is on. */
export function isGatedAppReadCapability(
  value: string,
): value is GatedAppReadCapability {
  return (GATED_APP_READ_CAPABILITIES as readonly string[]).includes(value);
}

/** Every request type some capability can reach, for the fitness tests. */
export function exposedRequestTypes(
  options: { readonly gated?: boolean } = {},
): ReadonlySet<string> {
  const capabilities: readonly (AppReadCapability | GatedAppReadCapability)[] =
    options.gated === true
      ? [...APP_READ_CAPABILITIES, ...GATED_APP_READ_CAPABILITIES]
      : APP_READ_CAPABILITIES;
  return new Set([
    ...capabilities.flatMap((capability) => CAPABILITY_REQUESTS[capability]),
    ...ALWAYS_ALLOWED_REQUESTS,
    RUN_REQUEST,
    METHOD_REQUEST,
  ]);
}

/** `${{` starts an expression, which serve evaluates as the viewer. */
// iterative, so input nested past the stack cannot throw instead of refusing
export function holdsExpression(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    if (typeof next === "string") {
      if (next.includes("${{")) return true;
    } else if (Array.isArray(next)) {
      for (const item of next) pending.push(item);
    } else if (next !== null && typeof next === "object") {
      for (const [key, entry] of Object.entries(next)) {
        pending.push(key, entry);
      }
    }
  }
  return false;
}

function decideMethod(grant: AppGrant, payload: unknown): RequestDecision {
  const { modelIdOrName, methodName, typeArg, definitionName } =
    (payload ?? {}) as {
      modelIdOrName?: unknown;
      methodName?: unknown;
      typeArg?: unknown;
      definitionName?: unknown;
    };
  const allowed = grant.methods.find((entry) =>
    entry.behavior === modelIdOrName
  );
  if (
    allowed !== undefined &&
    (typeArg === undefined || typeArg === allowed.type) &&
    (definitionName === undefined || definitionName === allowed.behavior)
  ) {
    if (
      typeof methodName === "string" && allowed.methods.includes(methodName)
    ) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `This app may not run ${String(methodName)} on ${
        String(modelIdOrName)
      }.`,
    };
  }
  return {
    allowed: false,
    reason: `This app may not run methods of ${String(modelIdOrName)}.`,
  };
}

/** Decides one request an app sent, against what the operator approved. */
export function decideAppRequest(
  grant: AppGrant,
  type: string,
  payload: unknown,
): RequestDecision {
  if (ALWAYS_ALLOWED_REQUESTS.includes(type)) return { allowed: true };
  if (type === METHOD_REQUEST) return decideMethod(grant, payload);
  if (type === RUN_REQUEST) {
    const { inputs } = (payload ?? {}) as { inputs?: unknown };
    if (holdsExpression(inputs)) {
      return {
        allowed: false,
        reason: "An app may not send expressions in a workflow's inputs.",
      };
    }
    const target = (payload as { workflowIdOrName?: unknown } | undefined)
      ?.workflowIdOrName;
    if (typeof target === "string" && grant.run.includes(target)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: `This app may not start the workflow ${String(target)}.`,
    };
  }
  for (const capability of grant.capabilities) {
    // own keys only, so a name like __proto__ reaches nothing
    if (
      Object.hasOwn(CAPABILITY_REQUESTS, capability) &&
      CAPABILITY_REQUESTS[capability as keyof typeof CAPABILITY_REQUESTS]
        .includes(type)
    ) {
      return { allowed: true };
    }
  }
  return {
    allowed: false,
    reason: `This app has no capability that allows ${type}.`,
  };
}
