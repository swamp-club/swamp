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

import { basename, dirname, join, resolve } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import {
  Workflow,
  type WorkflowData,
} from "../../domain/workflows/workflow.ts";
import { isWorkflowDocument } from "../../domain/workflows/workflow_document.ts";
import {
  extensionWorkflowFiles,
  type ExtensionWorkflowRepository,
} from "../../infrastructure/persistence/extension_workflow_repository.ts";
import {
  isPrimaryWorkflowFileName,
  type YamlWorkflowRepository,
} from "../../infrastructure/persistence/yaml_workflow_repository.ts";
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
  /**
   * Repo-owned workflow dirs, read like `YamlWorkflowRepository`: top level
   * only. `workflow-*.yaml` files must load as workflows; any other `*.yaml`
   * or `*.yml` file there fails, because the loader never reads it.
   */
  workflowDirs: string[];
  /**
   * Extension-provided workflow dirs (the extension workflows dir, sources,
   * pulled extensions), read like `ExtensionWorkflowRepository`: `*.yaml` and
   * `*.yml` at any depth. These hold other YAML too, so manifests and YAML
   * without a top-level `jobs` key are skipped rather than reported.
   */
  extensionWorkflowDirs?: string[];
  abortSignal: AbortSignal;
}

/** The workflow repositories doctor takes its directories from. */
export interface DoctorWorkflowRepos {
  yamlWorkflowRepo: Pick<YamlWorkflowRepository, "getWorkflowsDir">;
  extensionWorkflowRepo:
    | Pick<ExtensionWorkflowRepository, "getWorkflowDirs">
    | null;
}

/**
 * Returns the directories the workflow loader reads, split by how each is
 * read, so doctor checks exactly what the repositories load.
 */
export function doctorWorkflowDirs(
  repos: DoctorWorkflowRepos,
): Pick<DoctorWorkflowsDeps, "workflowDirs" | "extensionWorkflowDirs"> {
  return {
    workflowDirs: [repos.yamlWorkflowRepo.getWorkflowsDir()],
    extensionWorkflowDirs: [
      ...(repos.extensionWorkflowRepo?.getWorkflowDirs() ?? []),
    ],
  };
}

/** How a file is checked: the loader rule that reads it, or none. */
type CheckMode = "repo" | "extension" | "not-loaded";

function fallbackName(filePath: string): string | null {
  const filename = basename(filePath);
  const stripped = filename.replace(/\.ya?ml$/, "");
  return stripped || null;
}

/**
 * Lists the YAML files in one directory: every top-level `*.yaml` / `*.yml`
 * file for a repo dir, or the extension loader's file set for an extension
 * dir. A missing dir yields nothing. An unreadable dir or subdir is warned
 * about and the files found before it are still returned — unlike the
 * extension loader, which fails on it, so the report covers what is readable.
 */
async function listYamlFiles(
  dir: string,
  extension: boolean,
  abortSignal: AbortSignal,
): Promise<string[]> {
  const files: string[] = [];
  try {
    if (extension) {
      for await (const path of extensionWorkflowFiles(dir)) {
        if (abortSignal.aborted) break;
        files.push(path);
      }
    } else {
      for await (const entry of Deno.readDir(dir)) {
        if (abortSignal.aborted) break;
        if (entry.isFile && /\.ya?ml$/.test(entry.name)) {
          files.push(join(dir, entry.name));
        }
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.PermissionDenied) {
      logger.warn`Skipping inaccessible workflow directory ${dir}: ${
        error instanceof Error ? error.message : String(error)
      }`;
    } else if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

/**
 * Loads one file the way the loader would and reports the outcome, or
 * returns null for an extension file that is not a workflow.
 */
async function checkWorkflowFile(
  filePath: string,
  mode: CheckMode,
): Promise<DoctorWorkflowResult | null> {
  let content: string;
  try {
    content = await Deno.readTextFile(filePath);
  } catch (readError) {
    return {
      file: filePath,
      name: fallbackName(filePath),
      status: "fail",
      error: readError instanceof Error ? readError.message : String(readError),
    };
  }

  const nameFromContent = (): string | null => {
    try {
      return (parseYaml(content) as { name?: string })?.name ?? null;
    } catch {
      return fallbackName(filePath);
    }
  };

  if (mode === "not-loaded") {
    // Log mode labels a result by its YAML name, so the message carries the
    // full path; renaming is only advised for a file that is a workflow.
    const looksLikeWorkflow = (() => {
      try {
        return isWorkflowDocument(parseYaml(content));
      } catch {
        return false;
      }
    })();
    const rule = `swamp only reads files named workflow-<name>.yaml in ${
      dirname(filePath)
    }.`;
    return {
      file: filePath,
      name: nameFromContent(),
      status: "fail",
      error: looksLikeWorkflow
        ? `Not loaded: ${rule} Rename ${filePath} to workflow-<name>.yaml, ` +
          `or remove it if it is a stale copy of a workflow that already loads.`
        : `Not loaded: ${rule} ${filePath} is not a workflow; move it out of ` +
          `that directory, or rename it to workflow-<name>.yaml if it is ` +
          `meant to be one.`,
    };
  }

  try {
    const data = parseYaml(content) as WorkflowData;
    if (mode === "extension" && !isWorkflowDocument(data)) {
      logger
        .debug`Skipping ${filePath}: not a workflow (no top-level jobs key)`;
      return null;
    }
    Workflow.fromData(data);
    return {
      file: filePath,
      name: data.name ?? fallbackName(filePath),
      status: "pass",
    };
  } catch (parseError) {
    return {
      file: filePath,
      name: nameFromContent(),
      status: "fail",
      error: parseError instanceof Error
        ? parseError.message
        : String(parseError),
    };
  }
}

/**
 * Checks every file the workflow loader reads from the supplied directories,
 * attempting to load each through the same YAML + Workflow.fromData() path,
 * and reports parse and construction errors instead of silently skipping
 * them. Each file is checked under the rule of the loader that reads it: the
 * repo rule for `workflow-*.yaml` in a repo dir, the extension rule for files
 * an extension dir yields. A YAML file in a repo dir that no loader reads
 * fails. A file reached through more than one dir is reported once.
 */
export async function* doctorWorkflows(
  deps: DoctorWorkflowsDeps,
): AsyncIterable<DoctorWorkflowsEvent> {
  const results: DoctorWorkflowResult[] = [];
  const dirs = [
    ...deps.workflowDirs.map((dir) => ({ dir, extension: false })),
    ...(deps.extensionWorkflowDirs ?? []).map((dir) => ({
      dir,
      extension: true,
    })),
  ];

  const scans: { files: string[]; extension: boolean }[] = [];
  for (const { dir, extension } of dirs) {
    if (deps.abortSignal.aborted) break;
    const files = await listYamlFiles(dir, extension, deps.abortSignal);
    scans.push({ files, extension });
  }
  // A misnamed file in a repo dir is still loaded when an extension dir
  // covers it (an extension workflows dir configured as the repo dir).
  const extensionRead = new Set(
    scans.filter((s) => s.extension).flatMap((s) =>
      s.files.map((f) => resolve(f))
    ),
  );

  const checked = new Set<string>();
  for (const { files, extension } of scans) {
    for (const filePath of files) {
      if (deps.abortSignal.aborted) break;
      const key = resolve(filePath);
      if (checked.has(key)) continue;
      checked.add(key);

      const mode: CheckMode =
        !extension && isPrimaryWorkflowFileName(basename(filePath))
          ? "repo"
          : extensionRead.has(key)
          ? "extension"
          : "not-loaded";
      const result = await checkWorkflowFile(filePath, mode);
      if (!result) continue;
      results.push(result);
      yield { kind: "workflow-checked", result };
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
