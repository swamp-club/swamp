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

import { bold, dim, green, red } from "@std/fmt/colors";
import type { OutputMode } from "./output.ts";
import type { Verbosity } from "../../cli/context.ts";
import { getSwampLogger } from "../logging.ts";
import type { ActivitySummary } from "../../domain/summary/summary_types.ts";

const logger = getSwampLogger(["summarise"]);

/**
 * Renders an activity summary in json or log mode.
 */
export function renderSummary(
  summary: ActivitySummary,
  sinceLabel: string,
  mode: OutputMode,
  verbosity: Verbosity,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  renderLogMode(summary, sinceLabel, verbosity);
}

/**
 * Renders a message when there is no activity to summarise.
 */
export function renderNoActivity(
  sinceLabel: string,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify({ message: "No activity found." }, null, 2));
  } else {
    logger.info(`No activity found in the last ${sinceLabel}.`);
  }
}

function renderLogMode(
  summary: ActivitySummary,
  sinceLabel: string,
  verbosity: Verbosity,
): void {
  const verbose = verbosity === "verbose";

  console.log(bold(`Activity summary (last ${sinceLabel})`));
  console.log();

  // ── Method Executions ─────────────────────────────────────────
  renderMethodExecutions(summary, verbose);

  // ── Workflow Runs ─────────────────────────────────────────────
  renderWorkflowRuns(summary, verbose);

  // ── Data ──────────────────────────────────────────────────────
  renderDataSummary(summary, verbose);
}

function renderMethodExecutions(
  summary: ActivitySummary,
  verbose: boolean,
): void {
  const models = summary.methodExecutions;
  if (models.length === 0) {
    console.log(dim("Direct Model Method Executions: none"));
    console.log();
    return;
  }

  const totalAll = models.reduce((s, m) => s + m.total, 0);
  const succeededAll = models.reduce((s, m) => s + m.succeeded, 0);
  const failedAll = models.reduce((s, m) => s + m.failed, 0);

  let header =
    `Direct Model Method Executions (${totalAll} total: ${succeededAll} succeeded`;
  if (failedAll > 0) {
    header += `, ${failedAll} failed`;
  }
  header += ")";
  console.log(bold(header));

  for (const model of models) {
    console.log(`  Model: ${bold(model.modelName)} ${dim(`(${model.type})`)}`);

    for (const method of model.methods) {
      const parts: string[] = [];
      if (method.succeeded > 0) parts.push(green(`✓ ${method.succeeded}`));
      if (method.failed > 0) parts.push(red(`✗ ${method.failed}`));
      console.log(`    ${method.method}   ${parts.join("  ")}`);

      if (verbose) {
        for (const run of method.runs) {
          const time = formatDateTime(run.startedAt);
          const dur = run.durationMs !== undefined
            ? formatDuration(run.durationMs)
            : "";
          const trigger = dim(run.triggeredBy);
          const statusStr = run.status === "failed"
            ? red(run.status)
            : dim(run.status);
          const errStr = run.error ? `  ${red(run.error)}` : "";
          console.log(
            `      ${dim(time)}  ${statusStr}  ${dur}  ${trigger}${errStr}`,
          );
        }
      }
    }
  }
  console.log();
}

function renderWorkflowRuns(
  summary: ActivitySummary,
  verbose: boolean,
): void {
  const groups = summary.workflows;
  if (groups.length === 0) {
    console.log(dim("Workflow Runs: none"));
    console.log();
    return;
  }

  const totalAll = groups.reduce((s, g) => s + g.total, 0);
  const succeededAll = groups.reduce((s, g) => s + g.succeeded, 0);
  const failedAll = groups.reduce((s, g) => s + g.failed, 0);

  let header = `Workflow Runs (${totalAll} total: ${succeededAll} succeeded`;
  if (failedAll > 0) {
    header += `, ${failedAll} failed`;
  }
  header += ")";
  console.log(bold(header));

  const maxLabel = Math.max(...groups.map((g) => g.workflowName.length));

  for (const group of groups) {
    const label = group.workflowName.padEnd(maxLabel + 2);
    const parts: string[] = [];
    if (group.succeeded > 0) parts.push(green(`✓ ${group.succeeded}`));
    if (group.failed > 0) parts.push(red(`✗ ${group.failed}`));
    console.log(`  ${label} ${parts.join("  ")}`);

    if (verbose) {
      for (const run of group.runs) {
        const time = formatDateTime(run.startedAt);
        const statusStr = run.status === "failed"
          ? red(run.status)
          : dim(run.status);
        const failedAt = run.firstFailedStep
          ? `  ${red(`at ${run.firstFailedStep}`)}`
          : "";
        console.log(`    ${dim(time)}  ${statusStr}${failedAt}`);

        for (const step of run.steps) {
          const model = step.modelName ? ` (${step.modelName})` : "";
          const dur = step.durationMs !== undefined
            ? `  ${formatDuration(step.durationMs)}`
            : "";
          const stepStatus = step.status === "failed"
            ? red(step.status)
            : dim(step.status);
          const errStr = step.error ? `  ${red(step.error)}` : "";
          console.log(
            `      ${step.jobName} > ${step.stepName}${model}  ${stepStatus}${dur}${errStr}`,
          );
        }
      }
    }
  }
  console.log();
}

function renderDataSummary(
  summary: ActivitySummary,
  verbose: boolean,
): void {
  const { totalItems, totalVersions, uniqueModels, byModelType } = summary.data;
  if (totalItems === 0) {
    console.log(dim("Data: none"));
    return;
  }

  console.log(
    bold("Data") +
      ` (${totalItems} items, ${totalVersions} versions, ${uniqueModels} models)`,
  );

  if (verbose && byModelType.length > 0) {
    for (const group of byModelType) {
      console.log(
        `  ${
          group.modelType.padEnd(30)
        } ${group.items} items, ${group.versions} versions`,
      );
    }
  }
}

function formatDateTime(iso?: string): string {
  if (!iso) return "unknown";
  try {
    const d = new Date(iso);
    return d.toISOString().replace("T", " ").substring(0, 16);
  } catch {
    return iso;
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
