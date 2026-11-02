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

import { z } from "zod";
import { parse as parseYaml } from "@std/yaml";
import { UserError } from "../errors.ts";
import {
  BEHAVIOR_EXTENSION_KIND,
  MODEL_EXTENSION_KIND,
} from "../terminology/behavior_aliases.ts";

export type ExtensionKind =
  | "models"
  | "vaults"
  | "datastores"
  | "reports"
  | "webhooks"
  | "workflows";

export const EXTENSION_KINDS: readonly ExtensionKind[] = [
  "models",
  "vaults",
  "datastores",
  "reports",
  "webhooks",
  "workflows",
] as const;

/** behaviors is stored as models; every other value is returned unchanged */
export function canonicalExtensionKind(kind: string): string {
  return kind === BEHAVIOR_EXTENSION_KIND ? MODEL_EXTENSION_KIND : kind;
}

/**
 * a list with no behaviors comes back unchanged; otherwise behaviors becomes
 * models and repeats are dropped
 */
export function canonicalExtensionKinds(kinds: readonly string[]): string[] {
  if (!kinds.includes(BEHAVIOR_EXTENSION_KIND)) return [...kinds];
  return [...new Set(kinds.map(canonicalExtensionKind))];
}

export interface SwampSource {
  path: string;
  only?: ExtensionKind[];
  installedSkills?: string[];
}

export interface SwampSourcesConfig {
  sources: SwampSource[];
}

export interface ResolvedSourceDirs {
  sourcePath: string;
  modelsDir?: string;
  /**
   * the source's extensions/behaviors/, the behavior-spelled sibling of its
   * models directory; loaded as models
   */
  behaviorsDir?: string;
  vaultsDir?: string;
  datastoresDir?: string;
  reportsDir?: string;
  webhooksDir?: string;
  workflowsDir?: string;
}

const ExtensionKindSchema = z.enum([
  "models",
  "vaults",
  "datastores",
  "reports",
  "webhooks",
  "workflows",
]);

const safeSkillName = z.string().refine(
  (name) =>
    name.length > 0 && !name.includes("/") && !name.includes("\\") &&
    !name.includes(".."),
  { message: "Skill name must not contain path separators or '..' components" },
);

const SwampSourceSchema = z.object({
  path: z.string().min(1, "Source path must not be empty"),
  only: z.array(ExtensionKindSchema).optional(),
  installedSkills: z.array(safeSkillName).optional(),
});

const SwampSourcesConfigSchema = z.object({
  sources: z.array(SwampSourceSchema).min(1, "At least one source is required"),
});

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

export function isGlobPattern(path: string): boolean {
  return /[*?{]/.test(path);
}

/**
 * must stay in sync with each loader's pre-bundle regex so pre-scan detection
 * equals loader acceptance; workflows are YAML, detected by filename and a
 * top-level jobs: key
 */
export const EXTENSION_EXPORT_NAMES: Record<
  Exclude<ExtensionKind, "workflows">,
  readonly string[]
> = {
  // behavior is the other spelling of model
  models: ["model", "behavior", "extension"],
  vaults: ["vault"],
  datastores: ["datastore"],
  reports: ["report"],
  webhooks: ["webhook"],
} as const;

/**
 * uses the loaders' export shape so detection matches load-time acceptance;
 * returns the first match, since a module declaring several kinds is malformed
 * and the loader catches it downstream
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
