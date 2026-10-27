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

import { join } from "@std/path";
import type { ExtensionManifest } from "../../domain/extensions/extension_manifest.ts";
import {
  planSourceArchive,
  type SourceArchivePlan,
} from "../../domain/extensions/source_archive_plan.ts";
import type { ExtensionPushPrepareInput } from "./push.ts";
import type { ResolvedBareImport } from "../../domain/extensions/bare_import_resolution.ts";
import {
  readConfigImports,
  resolveBareImport,
} from "../../domain/extensions/dependency_resolution/import_map.ts";
import { scanImportSites } from "../../domain/extensions/dependency_resolution/import_sites.ts";
import { isBareSpecifier } from "../../domain/extensions/dependency_resolution/specifier.ts";

/**
 * The bare-import resolutions the module graph would report for `files`
 * under a config with only top-level `imports`, without running deno: each
 * bare import each file writes, resolved through the `imports` of the
 * config at `denoConfigPath`. Unit tests use it in place of a real graph.
 */
export async function topLevelBareImports(
  files: string[],
  denoConfigPath: string,
): Promise<ResolvedBareImport[]> {
  const imports = await readConfigImports(denoConfigPath) ?? {};
  const found: ResolvedBareImport[] = [];
  for (const importer of files) {
    const source = await Deno.readTextFile(importer);
    for (const { specifier } of scanImportSites(source, importer) ?? []) {
      if (!isBareSpecifier(specifier)) continue;
      const target = resolveBareImport(specifier, imports);
      found.push(
        target === undefined
          ? { importer, specifier }
          : { importer, specifier, target },
      );
    }
  }
  return found;
}

/**
 * The source plan push builds for files that all sit inside their kind's
 * directory and import nothing outside it: each file at
 * `<kind>/<path relative to the kind directory>`, byte for byte.
 */
export function kindDirectorySourcePlan(
  input: Omit<ExtensionPushPrepareInput, "sourcePlan">,
): SourceArchivePlan {
  return planSourceArchive({
    kinds: [
      {
        kind: "models",
        // A behaviors: manifest's entries resolve from the behaviors dir,
        // and models-dir files beside them still pack under models/
        // (swamp-club#3338), as the resolver plans them.
        dir: input.behaviorsDir ?? input.modelsDir,
        ...(input.behaviorsDir !== undefined &&
            input.behaviorsDir !== input.modelsDir
          ? { extraDirs: [input.modelsDir] }
          : {}),
        modules: input.allModelFiles,
      },
      { kind: "vaults", dir: input.vaultsDir, modules: input.allVaultFiles },
      {
        kind: "datastores",
        dir: input.datastoresDir,
        modules: input.allDatastoreFiles,
      },
      { kind: "reports", dir: input.reportsDir, modules: input.allReportFiles },
      {
        kind: "webhooks",
        dir: input.webhooksDir,
        modules: input.allWebhookFiles,
      },
    ],
    graph: { modules: [], edges: [], missing: [] },
    extensionsRoot: input.repoDir,
    // Fixtures may keep a kind's directory outside repoDir.
    allowedRoots: [
      input.repoDir,
      input.modelsDir,
      ...(input.behaviorsDir !== undefined ? [input.behaviorsDir] : []),
      input.vaultsDir,
      input.datastoresDir,
      input.reportsDir,
      input.webhooksDir,
    ],
  });
}

/**
 * Builds a prepare input for tests. Every typed directory sits under
 * `repoDir`, the manifest's directory is `repoDir` unless overridden, and a
 * dry run collects registry checks while a real push enforces them, as the
 * CLI does. Tests in this repository build prepare inputs through this
 * helper so a new required field is added in one place.
 */
export function buildPrepareInput(
  manifest: ExtensionManifest,
  repoDir: string,
  overrides: Partial<ExtensionPushPrepareInput> = {},
): ExtensionPushPrepareInput {
  const dryRun = overrides.dryRun ?? true;
  const input: Omit<ExtensionPushPrepareInput, "sourcePlan"> = {
    manifest,
    repoDir,
    bareImports: [],
    graphDependencies: { packageVersions: {}, unaudited: [] },
    manifestDir: repoDir,
    modelsDir: join(repoDir, "models"),
    allModelFiles: [],
    modelEntryPoints: [],
    vaultsDir: join(repoDir, "vaults"),
    allVaultFiles: [],
    vaultEntryPoints: [],
    datastoresDir: join(repoDir, "datastores"),
    allDatastoreFiles: [],
    datastoreEntryPoints: [],
    reportsDir: join(repoDir, "reports"),
    allReportFiles: [],
    reportEntryPoints: [],
    webhooksDir: join(repoDir, "webhooks"),
    allWebhookFiles: [],
    webhookEntryPoints: [],
    workflowFiles: [],
    skillDirs: [],
    allSkillFiles: [],
    includeFilePaths: [],
    additionalFilePaths: [],
    binaryFilePaths: [],
    dryRun,
    registryChecks: dryRun ? "collect" : "enforce",
    ...overrides,
  };
  return {
    ...input,
    sourcePlan: overrides.sourcePlan ?? kindDirectorySourcePlan(input),
  };
}
