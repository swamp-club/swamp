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
