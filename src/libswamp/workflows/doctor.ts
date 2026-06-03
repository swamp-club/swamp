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

import { basename, join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import {
  Workflow,
  type WorkflowData,
} from "../../domain/workflows/workflow.ts";
import type { SwampError } from "../errors.ts";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["doctor-workflows"]);

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
      if (error instanceof Deno.errors.PermissionDenied) {
        logger.warn`Skipping inaccessible workflow directory ${dir}: ${
          error instanceof Error ? error.message : String(error)
        }`;
        continue;
      }
      throw error;
    }

    const yamlFiles = entries
      .filter((e) => e.isFile && e.name.endsWith(".yaml"))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of yamlFiles) {
      if (deps.abortSignal.aborted) break;

      const filePath = join(dir, entry.name);
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

      try {
        const data = parseYaml(content) as WorkflowData;
        Workflow.fromData(data);
        const result: DoctorWorkflowResult = {
          file: filePath,
          name: data.name ?? fallbackName(filePath),
          status: "pass",
        };
        results.push(result);
        yield { kind: "workflow-checked", result };
      } catch (parseError) {
        const name = (() => {
          try {
            return (parseYaml(content) as { name?: string })?.name ?? null;
          } catch {
            return fallbackName(filePath);
          }
        })();
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
