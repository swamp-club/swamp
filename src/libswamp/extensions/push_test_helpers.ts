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
import type { ExtensionPushPrepareInput } from "./push.ts";

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
  return {
    manifest,
    repoDir,
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
}
