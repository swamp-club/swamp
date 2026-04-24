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
import type { ExtensionManifest } from "./extension_manifest.ts";

function encodeHex(bytes: Uint8Array): string {
  const chars: string[] = [];
  for (const b of bytes) {
    chars.push(b.toString(16).padStart(2, "0"));
  }
  return chars.join("");
}

/**
 * Content-hash-keyed cache for packaged extension tarballs.
 *
 * The cache is opportunistic: `swamp extension quality` packages once,
 * writes the tarball here, and `swamp extension push` can later reuse the
 * same bytes if the source inputs have not changed. The cache is a pure
 * optimization — cache misses fall back to fresh packaging.
 *
 * Cache entries live at:
 *   <cacheRoot>/<hash>/extension.tar.gz
 *   <cacheRoot>/<hash>/metadata.json
 *
 * The hash is a SHA-256 over the normalized manifest YAML plus the
 * contents of every file that ends up in the tarball — so any source
 * change invalidates the entry by construction.
 */

/** Inputs used to compute the cache hash. All source-tree state that
 * affects the tarball must be represented here. */
export interface PackageCacheHashInput {
  manifest: ExtensionManifest;
  modelFilePaths: string[];
  vaultFilePaths: string[];
  driverFilePaths: string[];
  datastoreFilePaths: string[];
  reportFilePaths: string[];
  workflowFilePaths: string[];
  additionalFilePaths: string[];
  skillFilePaths: string[];
  includeFilePaths: string[];
  denoConfigPath: string | undefined;
  packageJsonPath: string | undefined;
}

/** Cached per-entry metadata written alongside the tarball. */
export interface CachedPackageMetadata {
  hash: string;
  extensionName: string;
  extensionVersion: string;
  archiveSize: number;
  cachedAt: string;
  rubricVersion: number;
}

/** A cached package retrieved from disk. */
export interface CachedPackage {
  archiveBytes: Uint8Array;
  metadata: CachedPackageMetadata;
}

/**
 * Computes a deterministic SHA-256 hash over all inputs that would
 * affect the packaged tarball's contents. Uses the file paths as
 * deterministic labels and the file contents as the material to hash.
 */
export async function computePackageCacheHash(
  input: PackageCacheHashInput,
): Promise<string> {
  const parts: string[] = [];

  parts.push("manifest-v1");
  parts.push(serializeManifestForHash(input.manifest));

  await appendFileGroup("models", input.modelFilePaths, parts);
  await appendFileGroup("vaults", input.vaultFilePaths, parts);
  await appendFileGroup("drivers", input.driverFilePaths, parts);
  await appendFileGroup("datastores", input.datastoreFilePaths, parts);
  await appendFileGroup("reports", input.reportFilePaths, parts);
  await appendFileGroup("workflows", input.workflowFilePaths, parts);
  await appendFileGroup("additional", input.additionalFilePaths, parts);
  await appendFileGroup("skills", input.skillFilePaths, parts);
  await appendFileGroup("include", input.includeFilePaths, parts);

  if (input.denoConfigPath) {
    parts.push("deno-config");
    parts.push(await readFileIfExists(input.denoConfigPath));
  }
  if (input.packageJsonPath) {
    parts.push("package-json");
    parts.push(await readFileIfExists(input.packageJsonPath));
  }

  const payload = new TextEncoder().encode(parts.join("\n"));
  const digest = await crypto.subtle.digest("SHA-256", payload);
  return encodeHex(new Uint8Array(digest));
}

/**
 * Serialises the manifest fields relevant to the tarball into a stable
 * deterministic string. Field order is fixed; optional fields appear
 * only when set so equivalent-shaped manifests produce identical output.
 */
function serializeManifestForHash(manifest: ExtensionManifest): string {
  const lines: string[] = [];
  lines.push(`name=${manifest.name}`);
  lines.push(`version=${manifest.version}`);
  lines.push(`manifestVersion=${manifest.manifestVersion}`);
  lines.push(`description=${manifest.description ?? ""}`);
  lines.push(`repository=${manifest.repository ?? ""}`);
  lines.push(`models=${JSON.stringify(manifest.models)}`);
  lines.push(`workflows=${JSON.stringify(manifest.workflows)}`);
  lines.push(`vaults=${JSON.stringify(manifest.vaults)}`);
  lines.push(`drivers=${JSON.stringify(manifest.drivers)}`);
  lines.push(`datastores=${JSON.stringify(manifest.datastores)}`);
  lines.push(`reports=${JSON.stringify(manifest.reports)}`);
  lines.push(`skills=${JSON.stringify(manifest.skills)}`);
  lines.push(`include=${JSON.stringify(manifest.include)}`);
  lines.push(`additionalFiles=${JSON.stringify(manifest.additionalFiles)}`);
  lines.push(`platforms=${JSON.stringify(manifest.platforms)}`);
  lines.push(`labels=${JSON.stringify(manifest.labels)}`);
  lines.push(`dependencies=${JSON.stringify(manifest.dependencies)}`);
  return lines.join("\n");
}

async function appendFileGroup(
  label: string,
  paths: string[],
  out: string[],
): Promise<void> {
  const sorted = [...paths].sort();
  out.push(`group=${label}`);
  for (const p of sorted) {
    out.push(`file=${p}`);
    out.push(await readFileIfExists(p));
  }
}

async function readFileIfExists(path: string): Promise<string> {
  try {
    const bytes = await Deno.readFile(path);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return `sha256:${encodeHex(new Uint8Array(digest))}`;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return "missing";
    }
    throw error;
  }
}

/**
 * On-disk repository for cached extension tarballs. Construct with the
 * cache root directory (typically `<repoDir>/.swamp/cache/packages/`).
 */
export class ExtensionPackageCache {
  constructor(private readonly cacheRoot: string) {}

  /** Returns the per-entry directory for a given hash. */
  entryDir(hash: string): string {
    return join(this.cacheRoot, hash);
  }

  /** Retrieves a cached package, or returns null if not present. */
  async get(hash: string): Promise<CachedPackage | null> {
    const dir = this.entryDir(hash);
    const archivePath = join(dir, "extension.tar.gz");
    const metadataPath = join(dir, "metadata.json");

    let archiveBytes: Uint8Array;
    let metadataJson: string;
    try {
      archiveBytes = await Deno.readFile(archivePath);
      metadataJson = await Deno.readTextFile(metadataPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw error;
    }

    let metadata: CachedPackageMetadata;
    try {
      metadata = JSON.parse(metadataJson) as CachedPackageMetadata;
    } catch {
      return null;
    }

    return { archiveBytes, metadata };
  }

  /** Stores a package under the given hash. */
  async put(
    hash: string,
    archiveBytes: Uint8Array,
    extras: {
      extensionName: string;
      extensionVersion: string;
      rubricVersion: number;
    },
  ): Promise<CachedPackageMetadata> {
    const dir = this.entryDir(hash);
    await Deno.mkdir(dir, { recursive: true });

    const archivePath = join(dir, "extension.tar.gz");
    const metadataPath = join(dir, "metadata.json");

    await Deno.writeFile(archivePath, archiveBytes);

    const metadata: CachedPackageMetadata = {
      hash,
      extensionName: extras.extensionName,
      extensionVersion: extras.extensionVersion,
      archiveSize: archiveBytes.length,
      cachedAt: new Date().toISOString(),
      rubricVersion: extras.rubricVersion,
    };
    await Deno.writeTextFile(metadataPath, JSON.stringify(metadata, null, 2));

    return metadata;
  }
}

/** Resolves the standard cache root inside a swamp repo. */
export function defaultPackageCacheRoot(repoDir: string): string {
  return join(repoDir, ".swamp", "cache", "packages");
}
