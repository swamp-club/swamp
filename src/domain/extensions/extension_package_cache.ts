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

import {
  exactVersion,
  parseSpecifier,
} from "@swamp-club/extension-scoring/dependency-audit";
import type { GraphDependencies } from "./dependency_resolution/package_versions.ts";
import {
  dirname,
  fromFileUrl,
  join,
  relative,
  resolve,
  SEPARATOR,
} from "@std/path";
import type { ResolvedBareImport } from "./bare_import_resolution.ts";
import {
  readConfigImports,
  resolveBareImport,
} from "./dependency_resolution/import_map.ts";
import type { ExtensionManifest } from "./extension_manifest.ts";
import { qualitySidecarPath } from "./extension_quality_sidecar.ts";

function encodeHex(bytes: Uint8Array): string {
  const chars: string[] = [];
  for (const b of bytes) {
    chars.push(b.toString(16).padStart(2, "0"));
  }
  return chars.join("");
}

/**
 * opportunistic: quality packages once and push reuses the bytes if inputs are
 * unchanged, else packages afresh; the hash covers the manifest and every
 * tarball file, so any change invalidates
 */

/** Inputs used to compute the cache hash. All source-tree state that
 * affects the tarball must be represented here. */
export interface PackageCacheHashInput {
  manifest: ExtensionManifest;
  /**
   * files are labelled by their path from here so the hash is the same wherever
   * the repo sits: pushing from a sibling repo hashes like publish
   */
  rootDir: string;
  /**
   * the quality.yaml sidecar beside it joins the hash, so a changed acceptance
   * moves the content hash and the review-report path
   */
  manifestDir: string;
  modelFilePaths: string[];
  vaultFilePaths: string[];
  datastoreFilePaths: string[];
  reportFilePaths: string[];
  webhookFilePaths: string[];
  workflowFilePaths: string[];
  additionalFilePaths: string[];
  binaryFilePaths: string[];
  skillFilePaths: string[];
  includeFilePaths: string[];
  denoConfigPath: string | undefined;
  packageJsonPath: string | undefined;
  /**
   * the bundles and the dependency audit record ship the locked versions, so a
   * lock bump with no source change must not reuse an archive built against the
   * old lock
   */
  lockPath?: string;
  /**
   * the shipped source depends on these, and an importMap file or workspace
   * root can change them without changing denoConfigPath
   */
  bareImports?: ResolvedBareImport[];
  /**
   * the shipped source pins these versions and the record lists them, so a
   * lockless range resolving to a new version must not reuse an archive pinned
   * to an old one
   */
  graphDependencies?: GraphDependencies;
  /**
   * hashed by path alone, never read: the safety gate refuses them, and a
   * target may be outside the repository, a device or a pipe
   */
  symlinkedPaths?: ReadonlySet<string>;
}

export interface CachedPackageMetadata {
  hash: string;
  extensionName: string;
  extensionVersion: string;
  archiveSize: number;
  cachedAt: string;
  rubricVersion: number;
  /**
   * an entry is reused only by the same swamp version: a cached archive skips
   * the fmt/lint gates, so a newer swamp whose gates may have changed packages
   * afresh
   */
  swampVersion?: string;
  /**
   * recorded at packaging so a cache hit need not load every source again to
   * check their collective
   */
  archiveIndex?: StoredArchiveIndex;
}

export interface StoredArchiveIndex {
  sources: Array<{
    kindDir: string;
    fileName: string;
    kind: string;
    typeNormalized: string;
  }>;
  failures: Array<{ kindDir: string; fileName: string; reason: string }>;
}

/**
 * the metadata file sits in the repository, so it is untrusted data: a
 * malformed index is dropped and the sources are loaded again
 */
export function parseStoredArchiveIndex(
  value: unknown,
): StoredArchiveIndex | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { sources, failures } = value as Record<string, unknown>;
  if (!Array.isArray(sources) || !Array.isArray(failures)) return undefined;
  const strings = (entry: unknown, keys: string[]) =>
    typeof entry === "object" && entry !== null &&
    keys.every((k) =>
      typeof (entry as Record<string, unknown>)[k] === "string"
    );
  if (
    !sources.every((s) =>
      strings(s, ["kindDir", "fileName", "kind", "typeNormalized"])
    ) ||
    !failures.every((f) => strings(f, ["kindDir", "fileName", "reason"]))
  ) {
    return undefined;
  }
  return value as StoredArchiveIndex;
}

export interface CachedPackage {
  archiveBytes: Uint8Array;
  metadata: CachedPackageMetadata;
}

export async function computePackageCacheHash(
  input: PackageCacheHashInput,
): Promise<string> {
  const parts: string[] = [];

  const rootDir = input.rootDir;

  const unread = input.symlinkedPaths ?? new Set<string>();
  parts.push("manifest-v1");
  parts.push(serializeManifestForHash(input.manifest));

  await appendFileGroup("models", input.modelFilePaths, rootDir, parts, unread);
  await appendFileGroup("vaults", input.vaultFilePaths, rootDir, parts, unread);
  await appendFileGroup(
    "datastores",
    input.datastoreFilePaths,
    rootDir,
    parts,
    unread,
  );
  await appendFileGroup(
    "reports",
    input.reportFilePaths,
    rootDir,
    parts,
    unread,
  );
  await appendFileGroup(
    "webhooks",
    input.webhookFilePaths,
    rootDir,
    parts,
    unread,
  );
  await appendFileGroup(
    "workflows",
    input.workflowFilePaths,
    rootDir,
    parts,
    unread,
  );
  await appendFileGroup(
    "additional",
    input.additionalFilePaths,
    rootDir,
    parts,
    unread,
  );
  await appendFileGroup(
    "binaries",
    input.binaryFilePaths,
    rootDir,
    parts,
    unread,
  );
  await appendFileGroup("skills", input.skillFilePaths, rootDir, parts, unread);
  await appendFileGroup(
    "include",
    input.includeFilePaths,
    rootDir,
    parts,
    unread,
  );

  if (input.denoConfigPath) {
    parts.push("deno-config");
    parts.push(await readFileIfExists(input.denoConfigPath));
  }
  if (input.packageJsonPath) {
    parts.push("package-json");
    parts.push(await readFileIfExists(input.packageJsonPath));
  }
  // Only when present, so every extension without a lock keeps its hash.
  const lock = input.lockPath
    ? await computeFileContentHashIfExists(input.lockPath)
    : null;
  if (lock !== null) {
    parts.push("deno-lock");
    parts.push(lock);
  }
  // Only the resolutions the config's own top-level imports do not give
  // (an importMap file, a scope, a workspace root), so every extension
  // whose config the deno-config part above already covers keeps its hash.
  const unexplained = input.denoConfigPath
    ? await unexplainedBareImports(
      input.denoConfigPath,
      input.bareImports ?? [],
      rootDir,
    )
    : [];
  if (unexplained.length > 0) {
    parts.push("bare-imports");
    for (const line of unexplained) parts.push(line);
  }
  // in a package.json project the shipped source names each installed package's
  // version, which reinstalling changes without changing any hashed file; only
  // when present so other extensions keep their hash
  const installed = installedBareImports(input.bareImports ?? [], rootDir);
  if (installed.length > 0) {
    parts.push("installed-imports");
    for (const line of installed) parts.push(line);
  }
  // what source, config and lock do not fix: versions a lockless range resolved
  // to (so a new release misses the cache), URL-fetched modules, package-lock
  // validity; only when present, keeping other hashes
  const graph = input.graphDependencies;
  const lockless = input.lockPath
    ? []
    : Object.entries(graph?.packageVersions ?? {})
      .filter(([specifier, version]) => {
        // zod is the host's and never pinned; parseSpecifier skips it.
        const parsed = parseSpecifier(specifier);
        return parsed !== null && !version.installed &&
          exactVersion(parsed.version) === null;
      })
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  if (lockless.length > 0) {
    parts.push("lockless-versions");
    for (const [specifier, version] of lockless) {
      parts.push(`${specifier} ${version.specifier}`);
    }
  }
  if (graph && graph.unaudited.length > 0) {
    parts.push("unaudited");
    for (const u of graph.unaudited) {
      parts.push(`${u.kind} ${u.origin}`);
      for (const [module, sha] of Object.entries(u.modules).sort()) {
        parts.push(`${module} ${sha}`);
      }
    }
  }
  if (graph?.packageLock?.valid) parts.push("package-lock-valid");
  // only when present, so every extension without a sidecar keeps its hash
  const sidecar = await computeFileContentHashIfExists(
    qualitySidecarPath(input.manifestDir),
  );
  if (sidecar !== null) {
    parts.push("quality-sidecar");
    parts.push(sidecar);
  }

  const payload = new TextEncoder().encode(parts.join("\n"));
  const digest = await crypto.subtle.digest("SHA-256", payload);
  return encodeHex(new Uint8Array(digest));
}

/**
 * field order is fixed and optional fields appear only when set, so equivalent
 * manifests serialize identically
 */
function serializeManifestForHash(manifest: ExtensionManifest): string {
  const lines: string[] = [];
  lines.push(`name=${manifest.name}`);
  lines.push(`version=${manifest.version}`);
  lines.push(`manifestVersion=${manifest.manifestVersion}`);
  lines.push(`description=${manifest.description ?? ""}`);
  lines.push(`repository=${manifest.repository ?? ""}`);
  if (manifest.license !== undefined) {
    lines.push(`license=${manifest.license}`);
  }
  if (manifest.visibility !== undefined) {
    lines.push(`visibility=${manifest.visibility}`);
  }
  lines.push(`models=${JSON.stringify(manifest.models)}`);
  lines.push(`workflows=${JSON.stringify(manifest.workflows)}`);
  lines.push(`vaults=${JSON.stringify(manifest.vaults)}`);
  lines.push(`datastores=${JSON.stringify(manifest.datastores)}`);
  lines.push(`reports=${JSON.stringify(manifest.reports)}`);
  lines.push(`webhooks=${JSON.stringify(manifest.webhooks)}`);
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
  rootDir: string,
  out: string[],
  unread: ReadonlySet<string>,
): Promise<void> {
  const relPaths = paths.map((p) => ({
    rel: normalizeToForwardSlash(relative(rootDir, p)),
    abs: p,
  }));
  relPaths.sort((a, b) => a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
  out.push(`group=${label}`);
  for (const { rel, abs } of relPaths) {
    out.push(`file=${rel}`);
    out.push(unread.has(abs) ? "symlink" : await readFileIfExists(abs));
  }
}

function installedBareImports(
  bareImports: readonly ResolvedBareImport[],
  rootDir: string,
): string[] {
  return bareImports
    .filter((b) => b.installedVersion !== undefined && b.target !== undefined)
    .map((b) =>
      `import=${
        normalizeToForwardSlash(relative(rootDir, b.importer))
      }\0${b.specifier}\0${b.target}\0${b.declared ?? ""}`
    )
    .sort();
}

async function unexplainedBareImports(
  denoConfigPath: string,
  bareImports: readonly ResolvedBareImport[],
  rootDir: string,
): Promise<string[]> {
  if (bareImports.length === 0) return [];
  const map = await readConfigImports(denoConfigPath);
  const configDir = dirname(denoConfigPath);
  const label = (target: string | undefined): string => {
    if (target === undefined) return "";
    if (target.startsWith("file:")) {
      return `file:${
        normalizeToForwardSlash(relative(rootDir, fromFileUrl(target)))
      }`;
    }
    if (/^\.{0,2}\//.test(target)) {
      return `file:${
        normalizeToForwardSlash(relative(rootDir, resolve(configDir, target)))
      }`;
    }
    return target.replace(/^(npm|jsr):\//, "$1:");
  };
  const lines: string[] = [];
  for (const b of bareImports) {
    const resolved = label(b.target);
    const fromImports = label(
      map ? resolveBareImport(b.specifier, map) : undefined,
    );
    if (resolved === fromImports) continue;
    lines.push(
      `import=${
        normalizeToForwardSlash(relative(rootDir, b.importer))
      }\0${b.specifier}\0${resolved}`,
    );
  }
  return lines.sort();
}

function normalizeToForwardSlash(p: string): string {
  return SEPARATOR === "\\" ? p.replaceAll("\\", "/") : p;
}

export async function computeFileContentHash(path: string): Promise<string> {
  const bytes = await Deno.readFile(path);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${encodeHex(new Uint8Array(digest))}`;
}

export async function computeFileContentHashIfExists(
  path: string,
): Promise<string | null> {
  try {
    return await computeFileContentHash(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return null;
    }
    throw error;
  }
}

async function readFileIfExists(path: string): Promise<string> {
  return await computeFileContentHashIfExists(path) ?? "missing";
}

/**
 * entries written by another swamp version, or before entries recorded one, are
 * misses; the version lives in the entry, not the hash, which also keys an
 * adversarial-review report
 */
export class ExtensionPackageCache {
  constructor(
    private readonly cacheRoot: string,
    private readonly swampVersion: string,
  ) {}

  entryDir(hash: string): string {
    return join(this.cacheRoot, hash);
  }

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
    if (metadata.swampVersion !== this.swampVersion) return null;
    const archiveIndex = parseStoredArchiveIndex(metadata.archiveIndex);
    if (archiveIndex) {
      metadata.archiveIndex = archiveIndex;
    } else {
      delete metadata.archiveIndex;
    }

    return { archiveBytes, metadata };
  }

  async put(
    hash: string,
    archiveBytes: Uint8Array,
    extras: {
      extensionName: string;
      extensionVersion: string;
      rubricVersion: number;
      archiveIndex?: StoredArchiveIndex;
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
      swampVersion: this.swampVersion,
      ...(extras.archiveIndex ? { archiveIndex: extras.archiveIndex } : {}),
    };
    await Deno.writeTextFile(metadataPath, JSON.stringify(metadata, null, 2));

    return metadata;
  }
}

export function defaultPackageCacheRoot(repoDir: string): string {
  return join(repoDir, ".swamp", "cache", "packages");
}
