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

import { dirname, SEPARATOR } from "@std/path";
import { walk } from "@std/fs";
import { parse as parseYaml } from "@std/yaml";
import { getLogger } from "@logtape/logtape";
import type { ExtensionKind } from "../repo/swamp_sources.ts";

const logger = getLogger(["swamp", "extensions", "manifest-discovery"]);

const MANIFEST_FILENAMES = new Set(["manifest.yaml", "manifest.yml"]);
const MANIFEST_MAX_DEPTH = 3;
const MANIFEST_MAX_BYTES = 64 * 1024;

const MANIFEST_KIND_KEYS: readonly ExtensionKind[] = [
  "models",
  "vaults",
  "drivers",
  "datastores",
  "reports",
];

/**
 * Scans known kind directories for `manifest.yaml` files that use
 * `paths.base: manifest`. For each manifest that declares components
 * of a *different* kind, the manifest's directory is returned as an
 * additional directory for that kind.
 *
 * This closes the dev/prod parity gap where `paths.base: manifest`
 * extensions load fully when published but only partially from source
 * (the kind matching the parent directory loads; co-located components
 * of other kinds do not).
 *
 * @param kindDirs Map of extension kind to the directories already
 *   resolved for that kind (repo-local dirs, source dirs, etc.).
 *   Only these directories are scanned — no new filesystem roots are
 *   introduced.
 * @returns Map of extension kind to additional directories discovered
 *   from manifests. Directories already present in `kindDirs` for the
 *   target kind are excluded.
 */
export async function discoverManifestCrossKindDirs(
  kindDirs: Map<ExtensionKind, string[]>,
): Promise<Map<ExtensionKind, string[]>> {
  const result = new Map<ExtensionKind, string[]>();

  const seenManifests = new Set<string>();

  for (const [_sourceKind, dirs] of kindDirs) {
    for (const dir of dirs) {
      try {
        await Deno.stat(dir);
      } catch {
        continue;
      }

      for await (
        const entry of walk(dir, {
          maxDepth: MANIFEST_MAX_DEPTH,
          includeDirs: false,
          match: [/manifest\.ya?ml$/],
        })
      ) {
        if (!MANIFEST_FILENAMES.has(entry.name)) continue;
        if (seenManifests.has(entry.path)) continue;
        seenManifests.add(entry.path);

        const crossKinds = await extractManifestCrossKinds(entry.path);
        if (!crossKinds) continue;

        const manifestDir = dirname(entry.path);
        for (const kind of crossKinds) {
          if (isSubdirOfAny(manifestDir, kindDirs.get(kind))) {
            continue;
          }

          let list = result.get(kind);
          if (!list) {
            list = [];
            result.set(kind, list);
          }
          if (!list.includes(manifestDir)) {
            list.push(manifestDir);
            logger
              .debug`Manifest cross-kind discovery: ${entry.path} contributes ${kind} dir ${manifestDir}`;
          }
        }
      }
    }
  }

  return result;
}

function isSubdirOfAny(
  candidate: string,
  dirs: string[] | undefined,
): boolean {
  if (!dirs) return false;
  for (const dir of dirs) {
    if (candidate === dir) return true;
    if (candidate.startsWith(dir + SEPARATOR)) return true;
  }
  return false;
}

/**
 * Reads a manifest file and returns the extension kinds it declares
 * entries for, if and only if `paths.base` is `"manifest"`. Returns
 * `null` if the manifest is not manifest-based, unparseable, or too
 * large.
 */
async function extractManifestCrossKinds(
  manifestPath: string,
): Promise<ExtensionKind[] | null> {
  try {
    const stat = await Deno.stat(manifestPath);
    if (stat.size > MANIFEST_MAX_BYTES) return null;

    const content = await Deno.readTextFile(manifestPath);
    const raw = parseYaml(content);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

    const obj = raw as Record<string, unknown>;
    if (obj.manifestVersion !== 1) return null;

    const paths = obj.paths;
    if (
      !paths || typeof paths !== "object" || Array.isArray(paths) ||
      (paths as Record<string, unknown>).base !== "manifest"
    ) {
      return null;
    }

    const kinds: ExtensionKind[] = [];
    for (const kind of MANIFEST_KIND_KEYS) {
      const entries = obj[kind];
      if (Array.isArray(entries) && entries.length > 0) {
        kinds.push(kind);
      }
    }

    return kinds.length > 0 ? kinds : null;
  } catch {
    logger.debug`Failed to read manifest at ${manifestPath}, skipping`;
    return null;
  }
}
