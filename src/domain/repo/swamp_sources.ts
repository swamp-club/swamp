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

import { z } from "zod";
import { parse as parseYaml } from "@std/yaml";
import { UserError } from "../errors.ts";

/**
 * The kinds of extensions that a source can provide.
 */
export type ExtensionKind =
  | "models"
  | "vaults"
  | "drivers"
  | "datastores"
  | "reports"
  | "workflows";

export const EXTENSION_KINDS: readonly ExtensionKind[] = [
  "models",
  "vaults",
  "drivers",
  "datastores",
  "reports",
  "workflows",
] as const;

/**
 * A single source entry from `.swamp-sources.yaml`.
 */
export interface SwampSource {
  /** Filesystem path (may contain `~`, `$VAR`, or glob patterns). */
  path: string;
  /** Optional filter — only load these extension kinds from this source. */
  only?: ExtensionKind[];
}

/**
 * The parsed contents of `.swamp-sources.yaml`.
 */
export interface SwampSourcesConfig {
  sources: SwampSource[];
}

/**
 * Resolved extension directories for a single source.
 * Each field is an absolute directory path, or undefined if not applicable
 * (either the directory doesn't exist or is filtered out by `only`).
 */
export interface ResolvedSourceDirs {
  /** The original source path (for diagnostics). */
  sourcePath: string;
  modelsDir?: string;
  vaultsDir?: string;
  driversDir?: string;
  datastoresDir?: string;
  reportsDir?: string;
  workflowsDir?: string;
}

const ExtensionKindSchema = z.enum([
  "models",
  "vaults",
  "drivers",
  "datastores",
  "reports",
  "workflows",
]);

const SwampSourceSchema = z.object({
  path: z.string().min(1, "Source path must not be empty"),
  only: z.array(ExtensionKindSchema).optional(),
});

const SwampSourcesConfigSchema = z.object({
  sources: z.array(SwampSourceSchema).min(1, "At least one source is required"),
});

/**
 * Parses and validates YAML content as a `.swamp-sources.yaml` file.
 *
 * @param yamlContent - Raw YAML string
 * @returns Validated sources config
 * @throws UserError if the YAML is invalid or does not match the schema
 */
export function parseSwampSources(yamlContent: string): SwampSourcesConfig {
  const raw = parseYaml(yamlContent);

  if (typeof raw !== "object" || raw === null) {
    throw new UserError(
      ".swamp-sources.yaml must be a YAML object with a 'sources' array.",
    );
  }

  const result = SwampSourcesConfigSchema.safeParse(raw);

  if (!result.success) {
    const messages = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `  - ${path}${issue.message}`;
    });
    throw new UserError(
      `Invalid .swamp-sources.yaml:\n${messages.join("\n")}`,
    );
  }

  return result.data;
}

/**
 * Checks whether a path string contains glob characters.
 */
export function isGlobPattern(path: string): boolean {
  return /[*?{]/.test(path);
}

/**
 * Mapping from extension kind to the `export const <name>` identifiers a
 * loader will accept. Must stay in sync with each loader's pre-bundle regex
 * (e.g. `UserModelLoader` checks for `model|extension`, `UserVaultLoader`
 * checks for `vault`). The content pre-scan in
 * `resolveExtensionKindsForSource` uses this map so pre-scan detection
 * equals loader acceptance — avoid silent divergence.
 *
 * Workflows are YAML files, not TS modules, so this map has no entry for
 * them — workflow detection is filename-based (`.yaml`/`.yml` with a
 * top-level `jobs:` key).
 */
export const EXTENSION_EXPORT_NAMES: Record<
  Exclude<ExtensionKind, "workflows">,
  readonly string[]
> = {
  models: ["model", "extension"],
  vaults: ["vault"],
  drivers: ["driver"],
  datastores: ["datastore"],
  reports: ["report"],
} as const;

/**
 * Examines a `.ts` file's source text and returns the extension kind it
 * declares, or undefined if no known extension export is present. Uses the
 * same `export\s+const\s+<name>\s*[=:]` shape the loaders use for their
 * pre-bundle skip check so detection matches load-time acceptance.
 *
 * Returns the first matching kind encountered — files that declare more
 * than one extension kind in a single module are malformed and outside the
 * pre-scan's responsibility; the loader catches that downstream.
 */
export function detectKindFromSource(
  sourceText: string,
): Exclude<ExtensionKind, "workflows"> | undefined {
  for (const [kind, names] of Object.entries(EXTENSION_EXPORT_NAMES)) {
    for (const name of names) {
      const pattern = new RegExp(`export\\s+const\\s+${name}\\s*[=:]`);
      if (pattern.test(sourceText)) {
        return kind as Exclude<ExtensionKind, "workflows">;
      }
    }
  }
  return undefined;
}
