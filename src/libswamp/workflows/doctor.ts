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

/**
 * Per-file result: pass means the file loaded cleanly; warn means it is not
 * broken but no workflow loader reads it.
 */
export interface DoctorWorkflowResult {
  file: string;
  name: string | null;
  status: "pass" | "warn" | "fail";
  error?: string;
  warning?: string;
}

/**
 * Final report shape. Overall status is fail if any file failed, else warn
 * if any file warned, else pass.
 */
export interface DoctorWorkflowsReport {
  overallStatus: "pass" | "warn" | "fail";
  workflows: DoctorWorkflowResult[];
  totalPassed: number;
  totalWarnings: number;
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
   * only. `workflow-*.yaml` files must load as workflows. Any other `*.yaml`
   * or `*.yml` file there is never loaded and is reported as a warning, unless
   * it is a `*.yaml` file that fails to load, which fails as it always has.
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

/** The outcome of loading one file, with its parsed YAML when it parsed. */
interface LoadedWorkflowFile {
  result: DoctorWorkflowResult;
  parsed?: unknown;
}

/**
 * Loads one file the way the loader would and reports the outcome, parsing
 * its YAML once, or returns null for an extension file that is not a
 * workflow.
 */
async function loadWorkflowFile(
  filePath: string,
  extension: boolean,
): Promise<LoadedWorkflowFile | null> {
  const fail = (error: unknown, name: string | null): DoctorWorkflowResult => ({
    file: filePath,
    name,
    status: "fail",
    error: error instanceof Error ? error.message : String(error),
  });

  let parsed: unknown;
  try {
    parsed = parseYaml(await Deno.readTextFile(filePath));
  } catch (error) {
    return { result: fail(error, fallbackName(filePath)) };
  }

  if (extension && !isWorkflowDocument(parsed)) {
    logger.debug`Skipping ${filePath}: not a workflow (no top-level jobs key)`;
    return null;
  }
  const yamlName = (parsed as { name?: string } | null)?.name;
  try {
    Workflow.fromData(parsed as WorkflowData);
    return {
      result: {
        file: filePath,
        name: yamlName ?? fallbackName(filePath),
        status: "pass",
      },
      parsed,
    };
  } catch (error) {
    return { result: fail(error, yamlName ?? null), parsed };
  }
}

/**
 * Explains why a file in a repo workflows dir is not loaded. Log mode labels
 * a result by its YAML name, so the message carries the full path; renaming
 * is only advised for a file that is a workflow.
 */
function notLoadedMessage(filePath: string, parsed: unknown): string {
  const rule = `swamp only reads files named workflow-<name>.yaml in ${
    dirname(filePath)
  }.`;
  return isWorkflowDocument(parsed)
    ? `Not loaded: ${rule} Rename ${filePath} to workflow-<name>.yaml, ` +
      `or remove it if it is a stale copy of a workflow that already loads.`
    : `Not loaded: ${rule} ${filePath} is not a workflow; move it out of ` +
      `that directory, or rename it to workflow-<name>.yaml if it is ` +
      `meant to be one.`;
}

/**
 * Checks one file under its mode, or returns null for an extension file that
 * is not a workflow.
 *
 * A file no loader reads must not get a worse outcome than doctor gave it
 * before it knew the loader's rule: a `*.yaml` file in a repo dir was always
 * loaded strictly, so one that fails still fails; one that loads, and any
 * `*.yml` file, which was never checked, only warn that it is not loaded.
 */
async function checkWorkflowFile(
  filePath: string,
  mode: CheckMode,
): Promise<DoctorWorkflowResult | null> {
  const loaded = await loadWorkflowFile(filePath, mode === "extension");
  if (!loaded || mode !== "not-loaded") return loaded?.result ?? null;

  const { result, parsed } = loaded;
  const notLoaded = notLoadedMessage(filePath, parsed);
  if (result.status === "fail" && !filePath.endsWith(".yml")) {
    // The note leads, on the line log mode indents; a load error can span
    // several lines.
    return {
      ...result,
      error: `${notLoaded} It also fails to load: ${result.error}`,
    };
  }
  return {
    file: result.file,
    name: result.name,
    status: "warn",
    warning: notLoaded,
  };
}

/**
 * Checks every file the workflow loader reads from the supplied directories,
 * attempting to load each through the same YAML + Workflow.fromData() path,
 * and reports parse and construction errors instead of silently skipping
 * them. Each file is checked under the rule of the loader that reads it: the
 * repo rule for `workflow-*.yaml` in a repo dir, the extension rule for files
 * an extension dir yields. A YAML file in a repo dir that no loader reads
 * warns, or fails if it is a `*.yaml` file that fails to load. A file
 * reached through more than one dir is reported once.
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
  const totalWarnings = results.filter((r) => r.status === "warn").length;
  const totalFailed = results.filter((r) => r.status === "fail").length;

  yield {
    kind: "completed",
    report: {
      overallStatus: totalFailed > 0
        ? "fail"
        : totalWarnings > 0
        ? "warn"
        : "pass",
      workflows: results,
      totalPassed,
      totalWarnings,
      totalFailed,
    },
  };
}
