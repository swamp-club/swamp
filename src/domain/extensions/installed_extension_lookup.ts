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

import { join } from "@std/path";
import { UserError } from "../errors.ts";
import {
  type ExtensionManifest,
  parseExtensionManifest,
} from "./extension_manifest.ts";

/** Shape of a per-entry record in upstream_extensions.json. */
interface UpstreamExtensionEntry {
  version: string;
}

const SCOPED_NAME_PATTERN = /^@[a-z0-9_-]+\/[a-z0-9_-]+(\/[a-z0-9_-]+)*$/;

/**
 * Reads the read-only manifest copy written by `swamp extension pull` at
 * `<pulledExtRoot>/<name>/manifest.yaml`. Returns null when the extension
 * has never been pulled (file not present).
 *
 * The caller resolves `pulledExtRoot` (typically `swampPath(repoDir,
 * "pulled-extensions")`) — this module does not touch infrastructure
 * paths so tests stay hermetic.
 */
export async function loadInstalledExtensionManifest(
  pulledExtRoot: string,
  name: string,
): Promise<ExtensionManifest | null> {
  validateExtensionName(name);
  const manifestPath = join(pulledExtRoot, name, "manifest.yaml");
  let content: string;
  try {
    content = await Deno.readTextFile(manifestPath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
  return parseExtensionManifest(content);
}

/**
 * Looks up the installed version of `name` in the upstream_extensions.json
 * lockfile. Returns null when the extension has no entry.
 *
 * The caller resolves `lockfilePath` — typically
 * `<models-dir>/upstream_extensions.json`, mirroring how
 * `extension_pull.ts` assembles the path.
 */
export async function readInstalledExtensionVersion(
  lockfilePath: string,
  name: string,
): Promise<string | null> {
  let content: string;
  try {
    content = await Deno.readTextFile(lockfilePath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
  const map = JSON.parse(content) as Record<
    string,
    UpstreamExtensionEntry | undefined
  >;
  return map[name]?.version ?? null;
}

/**
 * Extracts the collective slug from a scoped extension name.
 * `@adam/cfgmgmt` → `adam`; `@foo/bar/baz` → `foo`.
 *
 * Throws UserError for malformed names via {@link validateExtensionName}.
 */
export function extractCollective(name: string): string {
  validateExtensionName(name);
  const slashIdx = name.indexOf("/");
  // validateExtensionName guarantees the shape @collective/name[/...].
  return name.slice(1, slashIdx);
}

/** True when the extension's collective is the `@swamp` organization. */
export function isSwampCollective(name: string): boolean {
  return extractCollective(name) === "swamp";
}

/**
 * Validates a scoped extension name. Mirrors the check used by
 * `swamp extension pull` so error messages stay consistent across
 * commands.
 */
export function validateExtensionName(name: string): void {
  if (!SCOPED_NAME_PATTERN.test(name)) {
    throw new UserError(
      `Invalid extension name: "${name}". Must match @collective/name pattern (lowercase, alphanumeric, hyphens, underscores, additional /segments allowed).`,
    );
  }
}
