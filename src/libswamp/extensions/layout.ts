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

import { SWAMP_DATA_DIR } from "../../infrastructure/persistence/paths.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";

/**
 * gen-1 is extensions/<type>/…, gen-2 is the flat
 * .swamp/pulled-extensions/<type>/… where filenames collide across extensions,
 * current is the per-extension .swamp/pulled-extensions/<@scope>/<name>/<type>/…
 */
export type ExtensionLayoutGeneration = "gen-1" | "gen-2" | "current";

export interface LegacyFileEntry {
  extensionName: string;
  file: string;
  generation: "gen-1" | "gen-2";
}

/**
 * classifyExtensionFile uses it to detect gen-1 and gen-2 shapes, which decides
 * what needsInstallOrMigration re-pulls and sweepLegacyPaths removes
 */
export const PULLED_TYPE_DIRS: ReadonlySet<string> = new Set([
  "models",
  "workflows",
  "vaults",
  "datastores",
  "reports",
  "webhooks",
  "skills",
  "files",
]);

/**
 * pull always creates these under .swamp/pulled-extensions/<name>/ but the
 * lockfile does not track them, so extension rm must enumerate them to prune
 * empty ones; keep in sync with installExtension
 */
export const PER_EXTENSION_SCAFFOLD_DIRS: readonly string[] = [
  "models",
  "workflows",
  "vaults",
  "datastores",
  "reports",
  "webhooks",
  "files",
];

const PULLED_PREFIX = `${SWAMP_DATA_DIR}/pulled-extensions/`;
const MANAGED_PULLED_PREFIX = `${SWAMP_DATA_DIR}/config/pulled-extensions/`;
const GEN1_PREFIX = "extensions/";

/**
 * gen-1 needs a known type dir so skill dirs and other non-.swamp paths are not
 * swept as legacy; path-only, so it cannot tell a tool=none skill entry from
 * gen-2; normalised to forward slashes
 */
export function classifyExtensionFile(path: string): ExtensionLayoutGeneration {
  const file = path.replaceAll("\\", "/");
  if (file.startsWith(GEN1_PREFIX)) {
    const firstSegment = file.slice(GEN1_PREFIX.length).split("/")[0];
    if (PULLED_TYPE_DIRS.has(firstSegment)) {
      return "gen-1";
    }
  }
  const activePulledPrefix = file.startsWith(MANAGED_PULLED_PREFIX)
    ? MANAGED_PULLED_PREFIX
    : file.startsWith(PULLED_PREFIX)
    ? PULLED_PREFIX
    : undefined;
  if (!activePulledPrefix) {
    return "current";
  }
  const firstSegment = file.slice(activePulledPrefix.length).split("/")[0];
  if (PULLED_TYPE_DIRS.has(firstSegment)) {
    return "gen-2";
  }
  return "current";
}

/**
 * skills are tracked as a directory path, or file by file when merged into a
 * shared dir, so this compares at the directory boundary; skillsDir must be
 * repo-relative, and both sides are normalised to forward slashes for Windows
 */
export function isSkillDirEntry(
  file: string,
  skillsDir: string | undefined,
): boolean {
  if (!skillsDir) return false;
  const trimmed = skillsDir.replaceAll("\\", "/").replace(/\/$/, "");
  if (trimmed.length === 0) return false;
  const normalizedFile = file.replaceAll("\\", "/");
  return normalizedFile === trimmed ||
    normalizedFile.startsWith(`${trimmed}/`);
}

export function isSkillDirEntryMulti(
  file: string,
  skillsDirs: string[] | undefined,
): boolean {
  if (!skillsDirs) return false;
  for (const dir of skillsDirs) {
    if (isSkillDirEntry(file, dir)) return true;
  }
  return false;
}

/**
 * null for skill paths (tracked as directories only, so no orphan detection
 * within) and legacy paths (extensionInstall migration handles those); otherwise
 * the longest prefix identifying one per-extension subtree or bundle namespace
 */
export function extractTopLevelRoot(
  filePath: string,
  skillsDir: string,
  extensionName: string,
): string | null {
  // Legacy paths are out of scope for orphan detection; the migrate
  // flow in extensionInstall handles those.
  if (classifyExtensionFile(filePath) !== "current") {
    return null;
  }

  // Skills are tracked as their dir root, or file by file when merged
  // into a dir another owner shares. Skill dirs are out of scope for the
  // orphan walk: a shared dir holds files no single entry lists.
  if (isSkillDirEntry(filePath, skillsDir)) {
    return null;
  }

  const pfx = filePath.startsWith(MANAGED_PULLED_PREFIX)
    ? MANAGED_PULLED_PREFIX
    : filePath.startsWith(PULLED_PREFIX)
    ? PULLED_PREFIX
    : undefined;
  if (pfx) {
    const nameSegments = extensionName.split("/");
    const rest = filePath.slice(pfx.length);
    const segments = rest.split("/");
    if (segments.length < nameSegments.length) return null;
    return `${pfx}${segments.slice(0, nameSegments.length).join("/")}`;
  }

  const BUNDLE_KINDS = [
    "bundles",
    "vault-bundles",
    "datastore-bundles",
    "report-bundles",
    "webhook-bundles",
  ];
  for (const kind of BUNDLE_KINDS) {
    const prefix = `${SWAMP_DATA_DIR}/${kind}/`;
    if (filePath.startsWith(prefix)) {
      const rest = filePath.slice(prefix.length);
      const segments = rest.split("/");
      if (segments.length === 0 || segments[0].length === 0) return null;
      return `${prefix}${segments[0]}`;
    }
  }

  return null;
}

export function extractTopLevelRootMulti(
  filePath: string,
  skillsDirs: string[],
  extensionName: string,
): string | null {
  if (classifyExtensionFile(filePath) !== "current") {
    return null;
  }
  for (const dir of skillsDirs) {
    if (isSkillDirEntry(filePath, dir)) {
      return null;
    }
  }
  const pfx2 = filePath.startsWith(MANAGED_PULLED_PREFIX)
    ? MANAGED_PULLED_PREFIX
    : filePath.startsWith(PULLED_PREFIX)
    ? PULLED_PREFIX
    : undefined;
  if (pfx2) {
    const nameSegments = extensionName.split("/");
    const rest = filePath.slice(pfx2.length);
    const segments = rest.split("/");
    if (segments.length < nameSegments.length) return null;
    return `${pfx2}${segments.slice(0, nameSegments.length).join("/")}`;
  }
  const BUNDLE_KINDS = [
    "bundles",
    "vault-bundles",
    "datastore-bundles",
    "report-bundles",
    "webhook-bundles",
  ];
  for (const kind of BUNDLE_KINDS) {
    const prefix = `${SWAMP_DATA_DIR}/${kind}/`;
    if (filePath.startsWith(prefix)) {
      const segments = filePath.slice(prefix.length).split("/");
      if (segments.length < 1) continue;
      return `${prefix}${segments[0]}`;
    }
  }
  return null;
}

/**
 * without the skillsDirRelative filter the tool=none fallback
 * .swamp/pulled-extensions/skills/<name> looks like a gen-2 path and would be
 * falsely flagged as legacy
 */
export async function detectLegacyExtensionLayout(
  lockfilePath: string,
  skillsDirRelative?: string,
): Promise<LegacyFileEntry[]> {
  const repo = await LockfileRepository.create(lockfilePath);
  const upstream = repo.getAllEntries();
  const legacy: LegacyFileEntry[] = [];

  for (const [name, entry] of Object.entries(upstream)) {
    if (!entry.files) continue;
    for (const file of entry.files) {
      if (isSkillDirEntry(file, skillsDirRelative)) {
        continue;
      }
      const generation = classifyExtensionFile(file);
      if (generation === "gen-1" || generation === "gen-2") {
        legacy.push({ extensionName: name, file, generation });
      }
    }
  }

  return legacy;
}

export interface LegacyLayoutSummary {
  extensionNames: string[];
  fileCount: number;
  generations: Set<"gen-1" | "gen-2">;
}

export function summariseLegacyLayout(
  legacy: LegacyFileEntry[],
): LegacyLayoutSummary {
  const names = new Set<string>();
  const generations = new Set<"gen-1" | "gen-2">();
  for (const entry of legacy) {
    names.add(entry.extensionName);
    generations.add(entry.generation);
  }
  return {
    extensionNames: [...names].sort(),
    fileCount: legacy.length,
    generations,
  };
}

/**
 * warns rather than throws: migration is per-extension, so the lockfile
 * tolerates mixed-generation state and commands operate on whatever paths it
 * records
 */
export async function warnLegacyExtensionLayout(
  lockfilePath: string,
  warn: (message: string) => void,
  skillsDirRelative?: string,
): Promise<LegacyLayoutSummary | undefined> {
  const legacy = await detectLegacyExtensionLayout(
    lockfilePath,
    skillsDirRelative,
  );
  if (legacy.length === 0) return undefined;
  const summary = summariseLegacyLayout(legacy);
  warn(
    `${summary.extensionNames.length} extension(s) pending migration. ` +
      `Run 'swamp repo upgrade' to complete.`,
  );
  return summary;
}

/**
 * deprecated hard-gate alias; use warnLegacyExtensionLayout, since the lockfile
 * tolerates mixed-generation state
 */
export async function requireCurrentExtensionLayout(
  lockfilePath: string,
): Promise<void> {
  const legacy = await detectLegacyExtensionLayout(lockfilePath);
  if (legacy.length === 0) return;
  const summary = summariseLegacyLayout(legacy);
  const msg =
    `${summary.extensionNames.length} extension(s) pending migration. ` +
    `Run 'swamp repo upgrade' to complete.`;
  // Lazy import to avoid circular deps with UserError consumers.
  const { UserError } = await import("../../domain/errors.ts");
  throw new UserError(msg);
}
