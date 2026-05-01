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

import type { SwampError } from "../../../libswamp/errors.ts";
import type { AiTool } from "../../repo/repo_service.ts";
import type {
  AuditDoctorReport,
  CheckResult,
  OverallStatus,
  PreflightCheck,
  PreflightCheckName,
  SpawnFn,
} from "./check.ts";
import { agentConfigLoadableCheck } from "./checks/agent_config_loadable.ts";
import { makeBinaryOnPathCheck } from "./checks/binary_on_path.ts";
import { defaultAgentSetCheck } from "./checks/default_agent_set.ts";
import { recordingSmokeTestCheck } from "./checks/recording_smoke.ts";
import type { ResolveBinary } from "./checks/resolve_binary.ts";
import { makeSwampBinaryOnPathCheck } from "./checks/swamp_binary_on_path.ts";

/**
 * Streaming events from the doctor audit pipeline. The `error` variant is
 * required by the libswamp stream-protocol type system (`HasTerminals<E>`)
 * and is available for future failure modes that need to short-circuit
 * the stream mid-run.
 */
export type AuditDoctorEvent =
  | { kind: "check-started"; name: PreflightCheckName }
  | { kind: "check-completed"; result: CheckResult }
  | { kind: "completed"; report: AuditDoctorReport }
  | { kind: "error"; error: SwampError };

/** Deps for running the doctor. */
export interface AuditDoctorDeps {
  repoPath: string;
  auditDir: string;
  tool: AiTool;
  spawnSwamp: SpawnFn;
  abortSignal: AbortSignal;
  /**
   * Cross-platform PATH resolver. The CLI layer wires in
   * `defaultCommandResolver()` from `infrastructure/process`; tests pass a
   * fake. Required when `checks` is not supplied (the default check order
   * uses it for the binary-on-PATH checks).
   */
  resolveBinary?: ResolveBinary;
  /** Override the default check set (tests only). */
  checks?: readonly PreflightCheck[];
}

/**
 * Canonical check run order. Fixed so the UI output is stable and so a
 * reviewer can see that later checks depend on earlier ones passing in
 * practice (e.g. smoke-test requires swamp on PATH).
 *
 * `resolveBinary` is injected so the domain layer doesn't import the
 * cross-platform `which`/`where` helper from infrastructure — the CLI
 * passes `defaultCommandResolver()` in.
 */
export function defaultCheckOrder(
  resolveBinary: ResolveBinary,
): readonly PreflightCheck[] {
  return [
    makeBinaryOnPathCheck({ resolveBinary }),
    makeSwampBinaryOnPathCheck({ resolveBinary }),
    agentConfigLoadableCheck,
    defaultAgentSetCheck,
    recordingSmokeTestCheck,
  ];
}

function overallStatus(checks: CheckResult[]): OverallStatus {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.every((c) => c.status === "skip")) return "warn";
  return "pass";
}

function buildDefaultChecks(deps: AuditDoctorDeps): readonly PreflightCheck[] {
  if (!deps.resolveBinary) {
    throw new Error(
      "auditDoctor: deps.resolveBinary is required when deps.checks is not " +
        "supplied — pass `defaultCommandResolver().resolve` (from " +
        "infrastructure/process/resolve_command.ts) at the CLI layer.",
    );
  }
  return defaultCheckOrder(deps.resolveBinary);
}

/**
 * Runs preflight checks against the audit integration for the given tool.
 *
 * For tools without audit hooks (codex, copilot, none), emits a single
 * skip result and returns a `warn` report.
 */
export async function* auditDoctor(
  deps: AuditDoctorDeps,
): AsyncIterable<AuditDoctorEvent> {
  const { tool, abortSignal } = deps;

  // Tools without audit hook integration: short-circuit cleanly.
  if (tool === "codex" || tool === "copilot" || tool === "none") {
    const skipResult: CheckResult = {
      name: "recording-smoke-test",
      status: "skip",
      message: `tool \`${tool}\` does not have audit hooks; nothing to check`,
    };
    yield { kind: "check-completed", result: skipResult };
    const report: AuditDoctorReport = {
      tool,
      overallStatus: "warn",
      checks: [skipResult],
    };
    yield { kind: "completed", report };
    return;
  }

  const checks = deps.checks ?? buildDefaultChecks(deps);
  const results: CheckResult[] = [];

  for (const check of checks) {
    if (abortSignal.aborted) break;
    if (!check.appliesTo(tool)) {
      const skipResult: CheckResult = {
        name: check.name,
        status: "skip",
        message: `does not apply to ${tool}`,
      };
      results.push(skipResult);
      yield { kind: "check-completed", result: skipResult };
      continue;
    }
    yield { kind: "check-started", name: check.name };
    let result: CheckResult;
    try {
      result = await check.run({
        repoPath: deps.repoPath,
        auditDir: deps.auditDir,
        tool,
        abortSignal,
        spawnSwamp: deps.spawnSwamp,
      });
    } catch (error) {
      result = {
        name: check.name,
        status: "fail",
        message: `check threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
        hint:
          "This is a doctor implementation bug; please file an issue with the output.",
        details: { error: String(error) },
      };
    }
    results.push(result);
    yield { kind: "check-completed", result };
  }

  const report: AuditDoctorReport = {
    tool,
    overallStatus: overallStatus(results),
    checks: results,
  };
  yield { kind: "completed", report };
}
