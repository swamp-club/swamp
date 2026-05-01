// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import { UserError } from "../../errors.ts";
import type { AiTool } from "../../repo/repo_service.ts";

/**
 * Types and ports for the `swamp doctor audit` preflight diagnostic.
 *
 * Each preflight check is an independent unit that inspects one aspect of
 * the audit integration for the configured AI tool. Checks never short-
 * circuit each other — a failure in one check does not prevent later
 * checks from running.
 */

// TODO(windows-ga): add a sibling `swamp doctor vault` surface that runs
// `checkFileNotBroadlyReadable` against each configured local-encryption
// vault key file (and the auto-generated `.key` file) and reports what
// the platform check covers vs. what it skips. On POSIX the disclosure
// should list the `(stat.mode & 0o077) !== 0` rule. On Windows it should
// list the broad principals checked (Everyone, Authenticated Users,
// Anonymous Logon, BUILTIN\Users) and call out the bits we explicitly
// don't evaluate (deny ACEs, full inheritance traversal, alternate data
// streams, nested group membership). Keep it a separate command surface
// — don't fold it into `doctor audit`.

/** The canonical set of preflight check names. */
export type PreflightCheckName =
  | "binary-on-path"
  | "swamp-binary-on-path"
  | "agent-config-loadable"
  | "default-agent-set"
  | "recording-smoke-test";

/** Outcome of a single preflight check. */
export type CheckStatus = "pass" | "fail" | "skip";

/** Result of running one preflight check. */
export interface CheckResult {
  name: PreflightCheckName;
  status: CheckStatus;
  /** Short human-readable summary of what the check observed. */
  message: string;
  /** Actionable remediation hint, populated on fail. */
  hint?: string;
  /** Structured payload for JSON consumers. */
  details?: Record<string, unknown>;
}

/**
 * Subprocess invocation port.
 *
 * The production implementation spawns the swamp binary to run
 * `audit record --from-hook`. Tests inject fakes so unit tests never
 * subprocess-out to a real swamp binary.
 *
 * `signal` lets the caller terminate an in-flight child when the doctor
 * receives SIGINT. Without it, killing the doctor parent reparents the
 * child to init/launchd instead of terminating it.
 */
export type SpawnFn = (
  args: string[],
  stdin: string,
  env?: Record<string, string>,
  signal?: AbortSignal,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** Context passed to every preflight check. */
export interface CheckContext {
  /** Absolute path to the swamp-initialized repository. */
  repoPath: string;
  /** Absolute path to the `.swamp/audit` directory inside the repo. */
  auditDir: string;
  /** The AI tool whose integration is under test. */
  tool: AiTool;
  /** Cancellation signal for long-running checks. */
  abortSignal: AbortSignal;
  /** Spawn the swamp binary. Production wires the real binary; tests inject a fake. */
  spawnSwamp: SpawnFn;
}

/** A single preflight check. */
export interface PreflightCheck {
  readonly name: PreflightCheckName;
  readonly description: string;
  /** Whether this check applies to the given AI tool. */
  appliesTo(tool: AiTool): boolean;
  /** Execute the check. Must not throw — return a `fail` result instead. */
  run(ctx: CheckContext): Promise<CheckResult>;
}

/** Overall status of an audit-doctor report. */
export type OverallStatus = "pass" | "warn" | "fail";

/** The aggregated result of running every applicable preflight check. */
export interface AuditDoctorReport {
  tool: AiTool;
  overallStatus: OverallStatus;
  checks: CheckResult[];
}

/**
 * Typed error emitted when neither `--tool` nor `.swamp.yaml` specify a tool.
 *
 * Extends `UserError` so `renderError` in `main.ts` renders the hint cleanly
 * (no stack trace) — this is expected first-run UX, not a bug.
 */
export class NoToolConfiguredError extends UserError {
  constructor() {
    super(
      "No AI tool enrolled in .swamp.yaml (`tools` is empty) and no " +
        "--tool flag provided. Pass --tool <name> to audit a specific " +
        "tool (claude | cursor | kiro | opencode | codex | copilot), or " +
        "enroll a tool with `swamp repo upgrade --tool <name>` and try " +
        "again. Repos initialized with `--tool none` are not auditable " +
        "until a tool is enrolled.",
    );
    this.name = "NoToolConfiguredError";
  }
}
