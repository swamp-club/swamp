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

import type {
  EventHandlers,
  WorkflowRunEvent,
  WorkflowRunView,
} from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import {
  getRunLogger,
  getWorkflowRunLogger,
  writeOutput,
} from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";
import { renderMarkdownToTerminal } from "../markdown_renderer.ts";
import { InkWorkflowRunRenderer } from "./workflow_run_tree/mod.ts";

function isStdoutTty(): boolean {
  try {
    return Deno.stdout.isTerminal();
  } catch {
    return false;
  }
}

export interface WorkflowRunRenderOpts {
  workflowName: string;
  forceLog?: boolean;
}

export interface WorkflowRunRenderer extends Renderer<WorkflowRunEvent> {
  workflowFailed(): boolean;
}

class LogWorkflowRunRenderer implements WorkflowRunRenderer {
  private workflowName: string;
  private _failed = false;

  constructor(opts: WorkflowRunRenderOpts) {
    this.workflowName = opts.workflowName;
  }

  handlers(): EventHandlers<WorkflowRunEvent> {
    return {
      validating_inputs: () => {},
      evaluating_workflow: () => {},
      started: (e) => {
        this.workflowName = e.workflowName;
        getWorkflowRunLogger(e.workflowName).info("Starting workflow");
      },
      job_started: (e) => {
        getWorkflowRunLogger(this.workflowName, e.jobId).info("Job started");
      },
      job_completed: (e) => {
        getWorkflowRunLogger(this.workflowName, e.jobId).info("Job completed");
      },
      job_skipped: (e) => {
        getWorkflowRunLogger(this.workflowName, e.jobId).info("Job skipped");
      },
      step_started: (e) => {
        getWorkflowRunLogger(this.workflowName, e.jobId, e.stepId).info(
          "Step started",
        );
      },
      step_completed: (e) => {
        getWorkflowRunLogger(this.workflowName, e.jobId, e.stepId).info(
          "Step completed",
        );
      },
      step_skipped: (e) => {
        getWorkflowRunLogger(this.workflowName, e.jobId, e.stepId).info(
          "Step skipped",
        );
      },
      step_failed: (e) => {
        getWorkflowRunLogger(this.workflowName, e.jobId, e.stepId).error(
          "Step failed: {error}",
          { error: e.error },
        );
      },
      model_resolved: (e) => {
        getRunLogger(e.modelName, e.methodName).info(
          "Found model {name} ({type})",
          { name: e.modelName, type: e.modelType },
        );
      },
      env_var_warning: (e) => {
        const logger = getWorkflowRunLogger(
          this.workflowName,
          e.jobId,
          e.stepId,
        );
        logger.warn("Environment variables detected in model definition");
        for (const detail of e.envVars) {
          logger.warn("  {path} uses {envVar}", {
            path: detail.path,
            envVar: detail.envVar,
          });
        }
        logger.warn(e.message);
      },
      method_executing: (e) => {
        getRunLogger(e.modelName, e.methodName).info(
          "Executing method {method}",
          { method: e.methodName },
        );
      },
      method_output: (e) => {
        const logger = getRunLogger(e.modelName, e.methodName);
        if (e.stream === "stderr") {
          logger.warn(e.line);
        } else {
          logger.info(e.line);
        }
      },
      method_event: (e) => {
        const logger = getRunLogger(e.modelName, e.methodName);
        switch (e.event.type) {
          case "vault_secret_stored":
            logger.info(
              "Stored sensitive field '{fieldPath}' in vault '{vaultName}'",
              {
                fieldPath: e.event.fieldPath,
                vaultName: e.event.vaultName,
              },
            );
            break;
          case "schema_validation_warning":
            logger.warn(
              "Resource '{specName}' (instance '{instanceName}') data does not match schema: {error}",
              {
                specName: e.event.specName,
                instanceName: e.event.instanceName,
                error: e.event.error,
              },
            );
            break;
        }
      },
      report_started: () => {},
      report_completed: (e) => {
        const logger = getWorkflowRunLogger(this.workflowName);
        logger.info('Running report: "{reportName}"', {
          reportName: e.reportName,
        });
        const separator = "\u2500".repeat(60);
        writeOutput(
          `\u2500\u2500 Report: ${e.reportName} ${separator}\n${
            renderMarkdownToTerminal(e.markdown)
          }\n${separator}`,
        );
      },
      report_failed: (e) => {
        getWorkflowRunLogger(this.workflowName).warn(
          "Running report: {reportName} \u2192 \u2717 {error}",
          { reportName: e.reportName, error: e.error },
        );
      },
      completed: (e) => {
        const wfLogger = getWorkflowRunLogger(this.workflowName);
        if (e.run.status === "failed") {
          this._failed = true;
          wfLogger.error("Workflow {status}", { status: e.run.status });
        } else {
          wfLogger.with({ summary: true }).info("Workflow {status}", {
            status: e.run.status,
          });
          this.renderDataArtifactHints(e.run, wfLogger);
        }
      },
      error: (e) => {
        throw new UserError(e.error.message, e.error.code);
      },
    };
  }

  workflowFailed(): boolean {
    return this._failed;
  }

  private renderDataArtifactHints(
    run: WorkflowRunView,
    logger: ReturnType<typeof getWorkflowRunLogger>,
  ): void {
    const artifactNames = new Set<string>();
    for (const job of run.jobs) {
      for (const step of job.steps) {
        if (step.dataArtifacts) {
          for (const artifact of step.dataArtifacts) {
            artifactNames.add(artifact.name);
          }
        }
      }
    }
    if (run.workflowDataArtifacts) {
      for (const artifact of run.workflowDataArtifacts) {
        artifactNames.add(artifact.name);
      }
    }

    if (artifactNames.size > 0) {
      logger.info("");
      logger.info("View produced data:");
      logger.info(
        "  swamp data list --workflow {workflowName}",
        { workflowName: run.workflowName },
      );
      for (const name of artifactNames) {
        logger.info(
          "  swamp data get --workflow {workflowName} {artifactName}",
          { workflowName: run.workflowName, artifactName: name },
        );
      }
    }
  }
}

class JsonWorkflowRunRenderer implements WorkflowRunRenderer {
  private _failed = false;

  handlers(): EventHandlers<WorkflowRunEvent> {
    return {
      validating_inputs: () => {},
      evaluating_workflow: () => {},
      started: () => {},
      job_started: () => {},
      job_completed: () => {},
      job_skipped: () => {},
      step_started: () => {},
      step_completed: () => {},
      step_skipped: () => {},
      step_failed: () => {},
      model_resolved: () => {},
      env_var_warning: () => {},
      method_executing: () => {},
      method_output: () => {},
      method_event: () => {},
      report_started: () => {},
      report_completed: () => {},
      report_failed: () => {},
      completed: (e) => {
        if (e.run.status === "failed") this._failed = true;
        console.log(JSON.stringify(e.run, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message, e.error.code);
      },
    };
  }

  workflowFailed(): boolean {
    return this._failed;
  }
}

export function createWorkflowRunRenderer(
  mode: OutputMode,
  opts: WorkflowRunRenderOpts,
): WorkflowRunRenderer {
  switch (mode) {
    case "json":
      return new JsonWorkflowRunRenderer();
    case "log":
      if (!opts.forceLog && isStdoutTty()) {
        return new InkWorkflowRunRenderer(opts);
      }
      return new LogWorkflowRunRenderer(opts);
  }
}
