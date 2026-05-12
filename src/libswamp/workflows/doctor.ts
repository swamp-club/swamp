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

import { basename } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import {
  Workflow,
  type WorkflowData,
} from "../../domain/workflows/workflow.ts";
import type { SwampError } from "../errors.ts";

/** Per-file result: pass means the file loaded cleanly. */
export interface DoctorWorkflowResult {
  file: string;
  name: string | null;
  status: "pass" | "fail";
  error?: string;
}

/** Final report shape. */
export interface DoctorWorkflowsReport {
  overallStatus: "pass" | "fail";
  workflows: DoctorWorkflowResult[];
  totalPassed: number;
  totalFailed: number;
}

export type DoctorWorkflowsEvent =
  | { kind: "workflow-checked"; result: DoctorWorkflowResult }
  | { kind: "completed"; report: DoctorWorkflowsReport }
  | { kind: "error"; error: SwampError };

/** Dependencies injected by the CLI command. */
export interface DoctorWorkflowsDeps {
  workflowDirs: string[];
  abortSignal: AbortSignal;
}

/**
 * Attempts to extract the workflow name from raw YAML content.
 * Falls back to the filename if the content cannot be parsed far enough
 * to read a `name` field.
 */
function tryExtractName(content: string, filePath: string): string | null {
  try {
    const data = parseYaml(content) as { name?: string };
    return data?.name ?? null;
  } catch {
    return fallbackName(filePath);
  }
}

function fallbackName(filePath: string): string | null {
  const filename = basename(filePath);
  const stripped = filename.replace(/\.yaml$/, "");
  return stripped || null;
}

/**
 * Walks every supplied workflow directory and attempts to load each
 * `*.yaml` file through the same YAML + Workflow.fromData() path
 * the workflow loader uses. Reports parse and construction errors
 * instead of silently skipping them.
 */
export async function* doctorWorkflows(
  deps: DoctorWorkflowsDeps,
): AsyncIterable<DoctorWorkflowsEvent> {
  const results: DoctorWorkflowResult[] = [];

  for (const dir of deps.workflowDirs) {
    if (deps.abortSignal.aborted) break;

    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const entry of Deno.readDir(dir)) {
        entries.push(entry);
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }

    const yamlFiles = entries
      .filter((e) => e.isFile && e.name.endsWith(".yaml"))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of yamlFiles) {
      if (deps.abortSignal.aborted) break;

      const filePath = `${dir}/${entry.name}`;
      let content: string;
      try {
        content = await Deno.readTextFile(filePath);
      } catch (readError) {
        const error = readError instanceof Error
          ? readError.message
          : String(readError);
        const result: DoctorWorkflowResult = {
          file: filePath,
          name: fallbackName(filePath),
          status: "fail",
          error,
        };
        results.push(result);
        yield { kind: "workflow-checked", result };
        continue;
      }

      const name = tryExtractName(content, filePath);

      try {
        const data = parseYaml(content) as WorkflowData;
        Workflow.fromData(data);
        const result: DoctorWorkflowResult = {
          file: filePath,
          name: name ?? data.name ?? null,
          status: "pass",
        };
        results.push(result);
        yield { kind: "workflow-checked", result };
      } catch (parseError) {
        const error = parseError instanceof Error
          ? parseError.message
          : String(parseError);
        const result: DoctorWorkflowResult = {
          file: filePath,
          name,
          status: "fail",
          error,
        };
        results.push(result);
        yield { kind: "workflow-checked", result };
      }
    }
  }

  const totalPassed = results.filter((r) => r.status === "pass").length;
  const totalFailed = results.length - totalPassed;

  yield {
    kind: "completed",
    report: {
      overallStatus: totalFailed > 0 ? "fail" : "pass",
      workflows: results,
      totalPassed,
      totalFailed,
    },
  };
}
