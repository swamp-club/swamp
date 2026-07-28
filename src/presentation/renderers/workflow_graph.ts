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

import { renderMermaidAscii } from "@vercel/beautiful-mermaid";
import type { WorkflowGetData } from "../../libswamp/mod.ts";

const ASCII_OPTIONS = { paddingX: 2, paddingY: 1, boxBorderPadding: 0 };

function taskLabel(task: { type: string; [key: string]: unknown }): string {
  switch (task.type) {
    case "model_method":
      return "model";
    case "workflow":
      return "workflow";
    case "manual_approval":
      return "approval";
    case "assert":
      return "assert";
    default:
      return task.type;
  }
}

function buildJobDiagram(data: WorkflowGetData): string {
  const lines = ["graph TD"];
  const ids = new Map<string, string>();
  for (const [i, job] of data.jobs.entries()) {
    const id = `j${i}`;
    ids.set(job.name, id);
    lines.push(`  ${id}[${job.name}]`);
  }
  for (const job of data.jobs) {
    for (const dep of job.dependsOn) {
      const fromId = ids.get(dep.job);
      const toId = ids.get(job.name);
      if (fromId && toId) {
        lines.push(`  ${fromId} --> ${toId}`);
      }
    }
  }
  return lines.join("\n");
}

function buildStepDiagram(job: WorkflowGetData["jobs"][number]): string {
  const lines = ["graph TD"];
  const ids = new Map<string, string>();
  for (const [i, step] of job.steps.entries()) {
    const id = `s${i}`;
    const label = `${step.name} - ${taskLabel(step.task)}`;
    ids.set(step.name, id);
    lines.push(`  ${id}[${label}]`);
  }
  for (const step of job.steps) {
    for (const dep of step.dependsOn) {
      const fromId = ids.get(dep.step);
      const toId = ids.get(step.name);
      if (fromId && toId) {
        lines.push(`  ${fromId} --> ${toId}`);
      }
    }
  }
  return lines.join("\n");
}

export function renderWorkflowGraph(
  data: WorkflowGetData,
): string {
  const lines: string[] = [];

  const jobCount = data.jobs.length;
  const stepCount = data.jobs.reduce((n, j) => n + j.steps.length, 0);
  lines.push(
    `Workflow: ${data.name} (${jobCount} ${
      jobCount === 1 ? "job" : "jobs"
    }, ${stepCount} ${stepCount === 1 ? "step" : "steps"})`,
  );

  const hasJobDeps = data.jobs.some((j) => j.dependsOn.length > 0);
  if (hasJobDeps) {
    lines.push("");
    lines.push("Jobs:");
    lines.push(renderMermaidAscii(buildJobDiagram(data), ASCII_OPTIONS));
  }

  for (const job of data.jobs) {
    if (job.steps.length <= 1) continue;
    const hasStepDeps = job.steps.some((s) => s.dependsOn.length > 0);
    if (!hasStepDeps) continue;
    lines.push("");
    lines.push(`Job: ${job.name}`);
    lines.push(renderMermaidAscii(buildStepDiagram(job), ASCII_OPTIONS));
  }

  return lines.join("\n");
}
