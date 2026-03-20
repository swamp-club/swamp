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
import { CalVer } from "../models/calver.ts";
import { UserError } from "../errors.ts";

/** Scoped name pattern: @collective/name or @collective/name/subname/... */
const SCOPED_NAME_PATTERN = /^@[a-z0-9_-]+\/[a-z0-9_-]+(\/[a-z0-9_-]+)*$/;

const ExtensionManifestSchemaV1 = z.object({
  manifestVersion: z.literal(1),
  name: z.string().refine(
    (name) => SCOPED_NAME_PATTERN.test(name),
    {
      message:
        "Extension name must be scoped: @collective/name (lowercase, alphanumeric, hyphens, underscores, additional /segments allowed)",
    },
  ),
  version: z.string().refine(CalVer.isValid, {
    message: "Version must be valid CalVer format: YYYY.MM.DD.MICRO",
  }),
  description: z.string().optional(),
  repository: z.string().url().optional(),
  workflows: z.array(z.string()).optional(),
  models: z.array(z.string()).optional(),
  vaults: z.array(z.string()).optional(),
  drivers: z.array(z.string()).optional(),
  datastores: z.array(z.string()).optional(),
  reports: z.array(z.string()).optional(),
  additionalFiles: z.array(z.string()).optional(),
  platforms: z.array(z.string().min(1)).optional(),
  labels: z.array(z.string().min(1)).optional(),
  releaseNotes: z.string().max(5000).optional(),
  dependencies: z.array(
    z.string().refine((dep) => dep.includes("/"), {
      message: "Dependencies must include a slash (e.g., @collective/name)",
    }),
  ).optional(),
}).refine(
  (data) =>
    (data.models && data.models.length > 0) ||
    (data.workflows && data.workflows.length > 0) ||
    (data.vaults && data.vaults.length > 0) ||
    (data.drivers && data.drivers.length > 0) ||
    (data.datastores && data.datastores.length > 0) ||
    (data.reports && data.reports.length > 0),
  {
    message:
      "Extension must include at least one model, workflow, vault, driver, or datastore",
  },
);

/** Parsed and validated extension manifest. */
export interface ExtensionManifest {
  manifestVersion: 1;
  name: string;
  version: string;
  description: string | undefined;
  repository: string | undefined;
  workflows: string[];
  models: string[];
  vaults: string[];
  drivers: string[];
  datastores: string[];
  reports: string[];
  additionalFiles: string[];
  platforms: string[];
  labels: string[];
  releaseNotes: string | undefined;
  dependencies: string[];
}

/**
 * Parses a YAML string into a validated ExtensionManifest.
 *
 * @throws UserError for missing/unsupported manifest version or validation failures
 */
export function parseExtensionManifest(content: string): ExtensionManifest {
  const raw = parseYaml(content);

  if (typeof raw !== "object" || raw === null) {
    throw new UserError("Extension manifest must be a YAML object.");
  }

  const obj = raw as Record<string, unknown>;

  // Check manifestVersion first with specific error messages
  if (!("manifestVersion" in obj) || obj.manifestVersion === undefined) {
    throw new UserError(
      "Extension manifest is missing 'manifestVersion'. Add 'manifestVersion: 1' to your manifest.",
    );
  }

  if (obj.manifestVersion !== 1) {
    throw new UserError(
      `Unsupported manifest version: ${obj.manifestVersion}. Only version 1 is supported.`,
    );
  }

  const result = ExtensionManifestSchemaV1.safeParse(raw);

  if (!result.success) {
    const messages = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `  - ${path}${issue.message}`;
    });
    throw new UserError(
      `Invalid extension manifest:\n${messages.join("\n")}`,
    );
  }

  return {
    manifestVersion: result.data.manifestVersion,
    name: result.data.name,
    version: result.data.version,
    description: result.data.description,
    repository: result.data.repository,
    workflows: result.data.workflows ?? [],
    models: result.data.models ?? [],
    vaults: result.data.vaults ?? [],
    drivers: result.data.drivers ?? [],
    datastores: result.data.datastores ?? [],
    reports: result.data.reports ?? [],
    additionalFiles: result.data.additionalFiles ?? [],
    platforms: result.data.platforms ?? [],
    labels: result.data.labels ?? [],
    releaseNotes: result.data.releaseNotes,
    dependencies: result.data.dependencies ?? [],
  };
}
