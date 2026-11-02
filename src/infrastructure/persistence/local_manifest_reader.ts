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

import { getLogger } from "@logtape/logtape";
import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";

const logger = getLogger(["swamp", "persistence", "local-manifest-reader"]);

/**
 * both name and version must be present to override the synthetic @local
 * default; if either is missing the manifest declares no identity
 */
export interface LocalManifestIdentity {
  readonly name: string;
  readonly version: string;
}

export function readLocalManifestIdentity(
  repoRoot: string,
): LocalManifestIdentity | null {
  const manifestPath = join(repoRoot, "extensions", "manifest.yaml");
  return readManifestIdentityAt(manifestPath);
}

export function readManifestIdentityAt(
  manifestPath: string,
): LocalManifestIdentity | null {
  const obj = readManifestObjectAt(manifestPath);
  if (obj === null) return null;
  const name = obj.name;
  const version = obj.version;

  if (typeof name !== "string" || name.length === 0) {
    if (version !== undefined) {
      logger
        .warn`Manifest at ${manifestPath} declares version but not name — both are required to override synthetic identity`;
    }
    return null;
  }

  if (typeof version !== "string" || version.length === 0) {
    logger
      .warn`Manifest at ${manifestPath} declares name but not version — both are required to override synthetic identity`;
    return null;
  }

  return { name, version };
}

/**
 * does not validate the full manifest schema, so an older installed manifest
 * never blocks a caller
 */
export function readManifestDependenciesAt(manifestPath: string): string[] {
  const obj = readManifestObjectAt(manifestPath);
  if (obj === null || !Array.isArray(obj.dependencies)) return [];
  return obj.dependencies.filter((dep): dep is string =>
    typeof dep === "string"
  );
}

function readManifestObjectAt(
  manifestPath: string,
): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = Deno.readTextFileSync(manifestPath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    logger.warn`Failed to read ${manifestPath}: ${error}`;
    return null;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    logger.warn`Malformed YAML in ${manifestPath}: ${error}`;
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    logger.warn`Expected object in ${manifestPath}, got ${typeof parsed}`;
    return null;
  }

  return parsed as Record<string, unknown>;
}
