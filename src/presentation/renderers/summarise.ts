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
import type { EventHandlers, SummariseEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import type { Verbosity } from "../../cli/context.ts";
import {
  getSwampLogger,
  writeOutput,
} from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import type { ActivitySummary } from "../../domain/summary/summary_types.ts";

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

function renderMethodExecutions(
  summary: ActivitySummary,
  verbose: boolean,
): void {
  const models = summary.methodExecutions;
  if (models.length === 0) {
    writeOutput(dim("Direct Model Method Executions: none"));
    writeOutput("");
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
  writeOutput(bold(header));

  for (const model of models) {
    writeOutput(`  Model: ${bold(model.modelName)} ${dim(`(${model.type})`)}`);

    const maxMethod = Math.max(...model.methods.map((m) => m.method.length));

    for (const method of model.methods) {
      const label = method.method.padEnd(maxMethod + 3);
      const parts: string[] = [];
      if (method.succeeded > 0) parts.push(green(`\u2713 ${method.succeeded}`));
      if (method.failed > 0) parts.push(red(`\u2717 ${method.failed}`));
      writeOutput(`    ${label}${parts.join("  ")}`);

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
          writeOutput(
            `      ${dim(time)}  ${statusStr}  ${dur}  ${trigger}${errStr}`,
          );
        }
      } else if (method.failed > 0) {
        // Show the most recent error message in compact mode
        const lastFailed = [...method.runs]
          .reverse()
          .find((r) => r.status === "failed" && r.error);
        if (lastFailed?.error) {
          writeOutput(
            `    ${"".padEnd(maxMethod + 3)}${
              red(`last error: "${lastFailed.error}"`)
            }`,
          );
        }
      }
    }
  }
  writeOutput("");
}

function renderWorkflowRuns(
  summary: ActivitySummary,
  verbose: boolean,
): void {
  const groups = summary.workflows;
  if (groups.length === 0) {
    writeOutput(dim("Workflow Runs: none"));
    writeOutput("");
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
  writeOutput(bold(header));

  const maxLabel = Math.max(...groups.map((g) => g.workflowName.length));

  for (const group of groups) {
    const label = group.workflowName.padEnd(maxLabel + 2);
    const parts: string[] = [];
    if (group.succeeded > 0) parts.push(green(`\u2713 ${group.succeeded}`));
    if (group.failed > 0) parts.push(red(`\u2717 ${group.failed}`));
    writeOutput(`  ${label} ${parts.join("  ")}`);

    if (verbose) {
      for (const run of group.runs) {
        const time = formatDateTime(run.startedAt);
        const statusStr = run.status === "failed"
          ? red(run.status)
          : dim(run.status);
        const failedAt = run.firstFailedStep
          ? `  ${red(`at ${run.firstFailedStep}`)}`
          : "";
        writeOutput(`    ${dim(time)}  ${statusStr}${failedAt}`);

        for (const step of run.steps) {
          const model = step.modelName ? ` (${step.modelName})` : "";
          const dur = step.durationMs !== undefined
            ? `  ${formatDuration(step.durationMs)}`
            : "";
          const stepStatus = step.status === "failed"
            ? red(step.status)
            : dim(step.status);
          const errStr = step.error ? `  ${red(step.error)}` : "";
          writeOutput(
            `      ${step.jobName} > ${step.stepName}${model}  ${stepStatus}${dur}${errStr}`,
          );
        }
      }
    } else if (group.failed > 0) {
      // Show the most recent failed run's error in compact mode
      const lastFailedRun = [...group.runs]
        .reverse()
        .find((r) => r.status === "failed");
      if (lastFailedRun) {
        const failedStep = lastFailedRun.steps.find(
          (s) => s.status === "failed" && s.error,
        );
        if (failedStep?.error) {
          writeOutput(
            `  ${"".padEnd(maxLabel + 2)} ${
              red(`last error: "${failedStep.error}"`)
            }`,
          );
        }
      }
    }
  }
  writeOutput("");
}

function renderDataSummary(
  summary: ActivitySummary,
  verbose: boolean,
): void {
  const { totalItems, totalVersions, uniqueModels, byModelType } = summary.data;
  if (totalItems === 0) {
    writeOutput(dim("Data: none"));
    return;
  }

  writeOutput(
    bold("Data") +
      ` (${totalItems} items, ${totalVersions} versions, ${uniqueModels} models)`,
  );

  if (verbose && byModelType.length > 0) {
    for (const group of byModelType) {
      writeOutput(
        `  ${
          group.modelType.padEnd(30)
        } ${group.items} items, ${group.versions} versions`,
      );
    }
  }
}

function renderLogSummary(
  summary: ActivitySummary,
  sinceLabel: string,
  verbosity: Verbosity,
): void {
  const verbose = verbosity === "verbose";

  writeOutput(bold(`Activity summary (last ${sinceLabel})`));
  writeOutput("");

  renderMethodExecutions(summary, verbose);
  renderWorkflowRuns(summary, verbose);
  renderDataSummary(summary, verbose);
}

class LogSummariseRenderer implements Renderer<SummariseEvent> {
  readonly #verbosity: Verbosity;

  constructor(verbosity: Verbosity) {
    this.#verbosity = verbosity;
  }

  handlers(): EventHandlers<SummariseEvent> {
    const logger = getSwampLogger(["summarise"]);
    return {
      completed: (e) => {
        const data = e.data;
        if (data.status === "no_activity") {
          logger.info(`No activity found in the last ${data.sinceLabel}.`);
        } else {
          renderLogSummary(data.summary, data.sinceLabel, this.#verbosity);
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

class JsonSummariseRenderer implements Renderer<SummariseEvent> {
  handlers(): EventHandlers<SummariseEvent> {
    return {
      completed: (e) => {
        const data = e.data;
        if (data.status === "no_activity") {
          console.log(
            JSON.stringify({ message: "No activity found." }, null, 2),
          );
        } else {
          console.log(JSON.stringify(data.summary, null, 2));
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }
}

export function createSummariseRenderer(
  mode: OutputMode,
  verbosity: Verbosity,
): Renderer<SummariseEvent> {
  switch (mode) {
    case "json":
      return new JsonSummariseRenderer();
    case "log":
      return new LogSummariseRenderer(verbosity);
  }
}
