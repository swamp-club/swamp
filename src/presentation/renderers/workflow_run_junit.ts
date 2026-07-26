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

import {
  type AssertSeverity,
  type EventHandlers,
  severityAtOrAbove,
  type WorkflowRunEvent,
} from "../../libswamp/mod.ts";
import type { WorkflowRunRenderer } from "./workflow_run.ts";
import { UserError } from "../../domain/errors.ts";

interface AssertRecord {
  jobId: string;
  stepId: string;
  passed: boolean;
  message: string;
  severity: AssertSeverity;
  expr: string;
  duration?: number;
}

export function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export class JUnitWorkflowRunRenderer implements WorkflowRunRenderer {
  private workflowName = "";
  private failOnSeverity: AssertSeverity;
  private outFile: string | undefined;
  private asserts: AssertRecord[] = [];
  private stepStartTimes = new Map<string, number>();
  private _failed = false;
  private totalDuration = 0;

  constructor(opts: {
    failOnSeverity?: AssertSeverity;
    outFile?: string;
  }) {
    this.failOnSeverity = opts.failOnSeverity ?? "low";
    this.outFile = opts.outFile;
  }

  handlers(): EventHandlers<WorkflowRunEvent> {
    return {
      validating_inputs: () => {},
      evaluating_workflow: () => {},
      started: (e) => {
        this.workflowName = e.workflowName;
      },
      job_started: () => {},
      job_completed: () => {},
      job_skipped: () => {},
      step_started: (e) => {
        this.stepStartTimes.set(`${e.jobId}:${e.stepId}`, Date.now());
      },
      step_completed: () => {},
      step_skipped: () => {},
      step_queued: () => {},
      step_failed: () => {},
      approval_requested: () => {},
      model_resolved: () => {},
      env_var_warning: () => {},
      method_executing: () => {},
      method_output: () => {},
      method_event: () => {},
      assert_result: (e) => {
        const key = `${e.jobId}:${e.stepId}`;
        const startTime = this.stepStartTimes.get(key);
        const duration = startTime ? (Date.now() - startTime) / 1000 : 0;
        this.asserts.push({
          jobId: e.jobId,
          stepId: e.stepId,
          passed: e.passed,
          message: e.message,
          severity: e.severity,
          expr: e.expr,
          duration,
        });
      },
      report_started: () => {},
      report_completed: () => {},
      report_failed: () => {},
      completed: (e) => {
        this.totalDuration = (e.run.duration ?? 0) / 1000;
        const failedAboveThreshold = this.asserts.filter(
          (a) =>
            !a.passed && severityAtOrAbove(a.severity, this.failOnSeverity),
        ).length;
        if (failedAboveThreshold > 0 || e.run.status === "failed") {
          this._failed = true;
        }
        this.writeJUnit();
      },
      cancelled: () => {
        this._failed = true;
        this.writeJUnit();
      },
      suspended: () => {
        this.writeJUnit();
      },
      error: (e) => {
        throw new UserError(e.error.message, e.error.code);
      },
    };
  }

  workflowFailed(): boolean {
    return this._failed;
  }

  private writeJUnit(): void {
    const xml = this.buildXml();
    if (this.outFile) {
      Deno.writeTextFileSync(this.outFile, xml);
    } else {
      console.log(xml);
    }
  }

  private buildXml(): string {
    const totalTests = this.asserts.length;
    const totalFailures = this.asserts.filter((a) => !a.passed).length;

    // Group by job
    const byJob = new Map<string, AssertRecord[]>();
    for (const a of this.asserts) {
      let group = byJob.get(a.jobId);
      if (!group) {
        group = [];
        byJob.set(a.jobId, group);
      }
      group.push(a);
    }

    const lines: string[] = [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<testsuites name="${
        escapeXml(this.workflowName)
      }" tests="${totalTests}" failures="${totalFailures}" time="${
        this.totalDuration.toFixed(1)
      }">`,
    ];

    for (const [jobId, records] of byJob) {
      const suiteFailures = records.filter((r) => !r.passed).length;
      const suiteTime = records.reduce((s, r) => s + (r.duration ?? 0), 0);
      lines.push(
        `  <testsuite name="${
          escapeXml(jobId)
        }" tests="${records.length}" failures="${suiteFailures}" time="${
          suiteTime.toFixed(1)
        }">`,
      );

      for (const r of records) {
        const classname = `${escapeXml(this.workflowName)}.${escapeXml(jobId)}`;
        if (r.passed) {
          lines.push(
            `    <testcase name="${
              escapeXml(r.stepId)
            }" classname="${classname}" time="${
              (r.duration ?? 0).toFixed(1)
            }"/>`,
          );
        } else {
          lines.push(
            `    <testcase name="${
              escapeXml(r.stepId)
            }" classname="${classname}" time="${
              (r.duration ?? 0).toFixed(1)
            }">`,
          );
          lines.push(
            `      <failure message="${escapeXml(r.message)}" type="${
              escapeXml(r.severity)
            }">`,
          );
          lines.push(`expr: ${escapeXml(r.expr)}`);
          lines.push(`      </failure>`);
          lines.push(`    </testcase>`);
        }
      }

      lines.push(`  </testsuite>`);
    }

    lines.push(`</testsuites>`);
    return lines.join("\n");
  }
}
