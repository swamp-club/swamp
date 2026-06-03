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

import { Command } from "@cliffy/command";
import { isAbsolute, join, resolve } from "@std/path";
import {
  consumeStream,
  doctorWorkflows,
  enumeratePulledExtensionDirs,
} from "../../libswamp/mod.ts";
import { createWorkflowDoctorRenderer } from "../../presentation/renderers/workflow_doctor.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { resolveDatastoreForRepo } from "../repo_context.ts";
import { resolveWorkflowsDir } from "../resolve_workflows_dir.ts";
import { resolveModelsDir } from "../resolve_models_dir.ts";
import {
  collectDirsForKind,
  expandSourcePaths,
  readSwampSources,
  resolveSourceExtensionDirs,
} from "../../infrastructure/persistence/swamp_sources_repository.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

async function getSourceWorkflowDirs(repoDir: string): Promise<string[]> {
  const sourcesConfig = await readSwampSources(repoDir);
  if (!sourcesConfig) return [];
  const expanded = await expandSourcePaths(sourcesConfig, repoDir);
  const resolved = await resolveSourceExtensionDirs(expanded);
  return collectDirsForKind(resolved, "workflows");
}

export const doctorWorkflowsCommand = new Command()
  .description(
    "Check that workflow YAML files in this repo load cleanly.",
  )
  .example("Check all workflows", "swamp doctor workflows")
  .example("Machine-readable output for CI", "swamp doctor workflows --json")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(async function (options: AnyOptions) {
    const cliCtx = createContext(options as GlobalOptions, [
      "doctor",
      "workflows",
    ]);
    cliCtx.logger.debug("Executing doctor workflows command");

    const repoDir = resolveRepoDir(options.repoDir);
    const { marker } = await resolveDatastoreForRepo(repoDir);

    const yamlWorkflowsDir = join(repoDir, "workflows");

    const workflowsDirRel = resolveWorkflowsDir(marker);
    const workflowsDir = isAbsolute(workflowsDirRel)
      ? workflowsDirRel
      : resolve(repoDir, workflowsDirRel);

    const sourceWorkflowDirs = await getSourceWorkflowDirs(repoDir);

    const modelsDirRel = resolveModelsDir(marker);
    const modelsDir = isAbsolute(modelsDirRel)
      ? modelsDirRel
      : resolve(repoDir, modelsDirRel);
    const pulledWorkflowDirs = await enumeratePulledExtensionDirs(
      join(modelsDir, "upstream_extensions.json"),
      repoDir,
      "workflows",
    );

    const workflowDirs = [
      yamlWorkflowsDir,
      workflowsDir,
      ...sourceWorkflowDirs,
      ...pulledWorkflowDirs,
    ];

    const controller = new AbortController();
    const renderer = createWorkflowDoctorRenderer(cliCtx.outputMode);

    await consumeStream(
      doctorWorkflows({
        workflowDirs,
        abortSignal: controller.signal,
      }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("doctor workflows command completed");

    if (renderer.overallStatus === "fail") {
      Deno.exit(1);
    }
  });
