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
import { workflowNotLoadedMessage } from "./broken_workflow.ts";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["doctor-workflows"]);

export interface DoctorWorkflowResult {
  file: string;
  name: string | null;
  status: "pass" | "warn" | "fail";
  error?: string;
  warning?: string;
}

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

export interface DoctorWorkflowsDeps {
  /**
   * repo-owned dirs, read like YamlWorkflowRepository (top level only):
   * workflow-*.yaml must load; any other YAML there is never loaded and warns,
   * unless it is a *.yaml that fails to load, which fails
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

export interface DoctorWorkflowRepos {
  yamlWorkflowRepo: Pick<YamlWorkflowRepository, "getWorkflowsDir">;
  extensionWorkflowRepo:
    | Pick<ExtensionWorkflowRepository, "getWorkflowDirs">
    | null;
}

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

type CheckMode = "repo" | "extension" | "not-loaded";

function fallbackName(filePath: string): string | null {
  const filename = basename(filePath);
  const stripped = filename.replace(/\.ya?ml$/, "");
  return stripped || null;
}

/**
 * an unreadable dir or subdir is warned about and the files found before it are
 * still returned, unlike the extension loader which fails, so the report covers
 * what is readable
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

interface LoadedWorkflowFile {
  result: DoctorWorkflowResult;
  parsed?: unknown;
}

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
 * a file no loader reads must not get a worse outcome than a warning: a failing
 * *.yaml in a repo dir still fails; one that loads, and any *.yml, only warns
 * that it is not loaded
 */
async function checkWorkflowFile(
  filePath: string,
  mode: CheckMode,
): Promise<DoctorWorkflowResult | null> {
  const loaded = await loadWorkflowFile(filePath, mode === "extension");
  if (!loaded || mode !== "not-loaded") return loaded?.result ?? null;

  const { result, parsed } = loaded;
  // Log mode labels a result by its YAML name, so the file is named by its
  // full path.
  const notLoaded = workflowNotLoadedMessage(
    filePath,
    dirname(filePath),
    parsed,
  );
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
