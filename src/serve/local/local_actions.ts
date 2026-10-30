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
 * The local dashboard's actions. A workspace's dashboard process opens its
 * repo read-only, so it never holds a v3 datastore's writer lock and never
 * writes a remote datastore's cache without syncing it. The actions the
 * page can take (approve, reject, resume, cancel) instead run as the CLI
 * command a user would type, in the workspace's folder: each takes its
 * locks and syncs like any other CLI write, on every datastore.
 */

/** The request types the hub runs as CLI commands instead of forwarding. */
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
 * The read requests the hub forwards to a workspace's child: exactly what
 * the dashboard reads. Anything else (a write such as `workflow.run`,
 * `vault.put` or `data.delete`, or a read it never makes such as
 * `vault.get`) is refused, so the read-only child only ever reads.
 */
export const FORWARDED_READS: ReadonlySet<string> = new Set([
  "audit.query",
  "audit.subscribe",
  "audit.unsubscribe",
  "cluster.instances",
  "data.get",
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

/** The error for a request the local dashboard neither forwards nor runs. */
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

/** The CLI command for an action, or why the request can't become one. */
export type ActionCommand =
  | {
    readonly kind: "command";
    /** Arguments after `swamp`. */
    readonly args: readonly string[];
    /**
     * Resume runs the rest of the workflow: it runs on its own, so it
     * outlives the dashboard, and the page follows it until it starts.
     */
    readonly detached: boolean;
    readonly runId: string;
  }
  | { readonly kind: "invalid"; readonly message: string };

const RUN_ID = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/;

/**
 * A name the page sent, as a CLI argument. It must not read as a flag, and
 * it must not be empty.
 */
function argument(value: unknown, what: string): string | { error: string } {
  if (typeof value !== "string" || value.trim() === "") {
    return { error: `The request has no ${what}.` };
  }
  if (value.startsWith("-")) {
    return { error: `The ${what} "${value}" can't start with "-".` };
  }
  return value;
}

/** Builds the CLI command for an action the page sent. */
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
      // One argv element, so the text can never read as another flag
      // (swamp-club#3697).
      const reason = typeof p.reason === "string" && p.reason.trim() !== ""
        ? [`--reason=${p.reason}`]
        : [];
      return {
        kind: "command",
        args: ["workflow", verb, workflow, step, run, ...reason, "--json"],
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

/** The protocol frames the hub sends back for an action. */
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

/** The error code serve uses for a failed action, e.g. `workflow_approve_failed`. */
export function actionErrorCode(type: DelegatedAction): string {
  return `${type.replace(".", "_")}_failed`;
}

/**
 * The reply to an attached action from the CLI's exit code and output:
 * its JSON as the result's `data`, or its error message.
 */
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
