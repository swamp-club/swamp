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
 * the dashboard process opens its repo read-only and never holds a v3 writer
 * lock, so write actions run as CLI commands in the workspace folder, taking
 * locks and syncing like any CLI write
 */

export const DELEGATED_ACTIONS = [
  "workflow.approve",
  "workflow.reject",
  "workflow.resume",
  "workflow.cancel",
] as const;

export type DelegatedAction = typeof DELEGATED_ACTIONS[number];

export function isDelegatedAction(type: unknown): type is DelegatedAction {
  return (DELEGATED_ACTIONS as readonly unknown[]).includes(type);
}

/**
 * anything else, a write or a read the dashboard never makes, is refused so the
 * read-only child only ever reads
 */
export const FORWARDED_READS: ReadonlySet<string> = new Set([
  "audit.query",
  "audit.subscribe",
  "audit.unsubscribe",
  "cluster.instances",
  "data.get",
  "data.query",
  "data.search",
  "data.versions",
  "datastore.status",
  "extension.list",
  "model.get",
  "model.output.search",
  "model.usage.summary",
  "model.search",
  "serve.config",
  "vault.audit-trail",
  "vault.describe",
  "vault.list-keys",
  "vault.search",
  "worker.list",
  "workflow.approvals",
  "workflow.get",
  "workflow.history.get",
  "workflow.history.logs",
  "workflow.run.search",
  "workflow.run.summary",
  "workflow.search",
  "workflow.trigger.get",
  "workflow.waits",
]);

export function notAvailableLocally(id: string, type: string): ActionFrame {
  return {
    type: "error",
    id,
    error: {
      code: "not_available_locally",
      message:
        `${type} is not available on the local dashboard. Run it with the swamp CLI, or through swamp serve.`,
    },
  };
}

export type ActionCommand =
  | {
    readonly kind: "command";
    readonly args: readonly string[];
    /**
     * resume runs on its own so it outlives the dashboard, and the page follows
     * it until it starts
     */
    readonly detached: boolean;
    readonly runId: string;
  }
  | { readonly kind: "invalid"; readonly message: string };

const RUN_ID = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/;

/** a name from the page must not be empty or read as a flag */
function argument(value: unknown, what: string): string | { error: string } {
  if (typeof value !== "string" || value.trim() === "") {
    return { error: `The request has no ${what}.` };
  }
  if (value.startsWith("-")) {
    return { error: `The ${what} "${value}" can't start with "-".` };
  }
  return value;
}

export function actionCommand(
  type: DelegatedAction,
  payload: unknown,
): ActionCommand {
  const p = (payload ?? {}) as Record<string, unknown>;
  const workflow = argument(p.workflowIdOrName, "workflow");
  if (typeof workflow !== "string") {
    return { kind: "invalid", message: workflow.error };
  }
  const runId = typeof p.runId === "string" ? p.runId : "";
  if (!RUN_ID.test(runId)) {
    return { kind: "invalid", message: "The request has no valid run id." };
  }
  const run = `--run=${runId}`;
  switch (type) {
    case "workflow.approve":
    case "workflow.reject": {
      const step = argument(p.stepName, "step");
      if (typeof step !== "string") {
        return { kind: "invalid", message: step.error };
      }
      const verb = type === "workflow.approve" ? "approve" : "reject";
      // one argv element, so the text can never read as another flag
      const reason = typeof p.reason === "string" && p.reason.trim() !== ""
        ? [`--reason=${p.reason}`]
        : [];
      if (
        p.suspendedAt !== undefined && (typeof p.suspendedAt !== "string" ||
          Number.isNaN(Date.parse(p.suspendedAt)))
      ) {
        return { kind: "invalid", message: "The request's time is not valid." };
      }
      const attempt = p.suspendedAt !== undefined
        ? [`--suspended-at=${p.suspendedAt}`]
        : [];
      return {
        kind: "command",
        args: [
          "workflow",
          verb,
          workflow,
          step,
          run,
          ...reason,
          ...attempt,
          "--json",
        ],
        detached: false,
        runId,
      };
    }
    case "workflow.resume":
      return {
        kind: "command",
        args: ["workflow", "resume", workflow, run, "--json"],
        detached: true,
        runId,
      };
    case "workflow.cancel":
      return {
        kind: "command",
        args: ["workflow", "cancel", workflow, run, "--json"],
        detached: false,
        runId,
      };
  }
}

export type ActionFrame =
  | {
    readonly type: DelegatedAction;
    readonly id: string;
    readonly payload: { readonly data: unknown };
  }
  | { readonly type: "event"; readonly id: string; readonly payload: unknown }
  | { readonly type: "done"; readonly id: string }
  | {
    readonly type: "error";
    readonly id: string;
    readonly error: { readonly code: string; readonly message: string };
  };

export function actionErrorCode(type: DelegatedAction): string {
  return `${type.replace(".", "_")}_failed`;
}

export function attachedReply(
  type: DelegatedAction,
  id: string,
  result: { code: number; stdout: string; stderr: string },
): ActionFrame {
  const parsed = parseJson(result.stdout);
  if (result.code === 0) {
    return { type, id, payload: { data: parsed ?? {} } };
  }
  const message = errorMessage(parsed) ?? lastLine(result.stderr) ??
    `swamp ${type.replace(".", " ")} failed (exit ${result.code}).`;
  return {
    type: "error",
    id,
    error: { code: actionErrorCode(type), message },
  };
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function errorMessage(value: unknown): string | null {
  if (value && typeof value === "object") {
    const error = (value as { error?: unknown }).error;
    if (typeof error === "string" && error !== "") return error;
    if (error && typeof error === "object") {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message !== "") return message;
    }
  }
  return null;
}

function lastLine(text: string): string | null {
  // deno-lint-ignore no-control-regex
  const lines = text.replace(/\x1b\[[0-9;]*m/g, "").split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  return lines.at(-1) ?? null;
}
