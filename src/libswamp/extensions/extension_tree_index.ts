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

import { join, relative, SEPARATOR } from "@std/path";
import type { BundleIndexResult } from "../../domain/extensions/kind_adapter.ts";
import { ExtensionLoader } from "../../domain/extensions/extension_loader.ts";
import { modelKindAdapter } from "../../domain/extensions/model_kind_adapter.ts";
import { vaultKindAdapter } from "../../domain/extensions/vault_kind_adapter.ts";
import { datastoreKindAdapter } from "../../domain/extensions/datastore_kind_adapter.ts";
import { reportKindAdapter } from "../../domain/extensions/report_kind_adapter.ts";
import { webhookKindAdapter } from "../../domain/extensions/webhook_kind_adapter.ts";
import type { KindAdapter } from "../../domain/extensions/kind_adapter.ts";
import type { DenoRuntime } from "../../domain/runtime/deno_runtime.ts";
import type { RuntimeContentType } from "../../domain/extensions/extension_collective_validator.ts";
import type { StoredArchiveIndex } from "../../domain/extensions/extension_package_cache.ts";
import type { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import { createDenoInfoModuleGraphReader } from "../../infrastructure/runtime/deno_info_module_graph_reader.ts";
import { ProcessBundleProber } from "../../infrastructure/runtime/process_bundle_prober.ts";

/** The source directories of an extension tree that a consumer indexes. */
export const EXTENSION_KIND_DIRS = [
  "models",
  "vaults",
  "datastores",
  "reports",
  "webhooks",
] as const;

export type ExtensionKindDir = typeof EXTENSION_KIND_DIRS[number];

const ADAPTERS: Record<ExtensionKindDir, KindAdapter> = {
  models: modelKindAdapter,
  vaults: vaultKindAdapter,
  datastores: datastoreKindAdapter,
  reports: reportKindAdapter,
  webhooks: webhookKindAdapter,
};

/** One source file of an extension tree and what loading it registers. */
export interface ExtensionTreeSource {
  kindDir: ExtensionKindDir;
  absolutePath: string;
  /** Path inside the kind directory, with forward slashes. */
  fileName: string;
  /** What the loader indexed, or null for a helper with no kind export. */
  indexed: BundleIndexResult | null;
}

/** A source file whose bundle or probe failed, so its type is unknown. */
export interface ExtensionTreeFailure {
  kindDir: ExtensionKindDir;
  absolutePath: string;
  fileName: string;
  reason: string;
}

/** Every source a consumer of an extension tree would index. */
export interface ExtensionTreeIndex {
  sources: ExtensionTreeSource[];
  failures: ExtensionTreeFailure[];
  /**
   * The repository whose catalog the loaders recorded each source's modules
   * in, and fingerprinted against. A catalog save reuses the index only when
   * it is its own repository: any other index fingerprints differently.
   */
  repository?: ExtensionRepository;
}

/** Indexes the extension tree rooted at `extRoot`. */
export type ExtensionTreeIndexer = (
  extRoot: string,
) => Promise<ExtensionTreeIndex>;

/**
 * An indexer that loads each source the way install and the loader do:
 * every `.ts` file under the kind directories (skipping `_`-prefixed
 * directories) is bundled and its top level imported in a probe host,
 * never its methods. Bundles are written where the loader keeps them under
 * `repoDir` and imported from file URLs, as the loader imports them: a
 * bundle imported from a `data:` URL breaks modules that resolve paths from
 * `import.meta.url`.
 */
export function createExtensionTreeIndexer(options: {
  denoRuntime: DenoRuntime;
  repoDir: string;
  /** How many sources load at once; defaults to {@link defaultConcurrency}. */
  concurrency?: number;
  /**
   * Load a pulled tree's shipped bundles instead of rebundling its sources.
   * Only for bundles this process built itself (push's own archive): an
   * install must rebundle, as the loader does, or a shipped bundle that
   * differs from its source would be judged instead of the source.
   */
  trustShippedBundles?: boolean;
  /**
   * The repository whose catalog records each source's modules, as the
   * install service's loaders record them, so the index fingerprints sources
   * exactly as they do.
   */
  repository?: ExtensionRepository;
}): ExtensionTreeIndexer {
  return async (extRoot) => {
    const files: Array<
      { kindDir: ExtensionKindDir; dir: string; absolutePath: string }
    > = [];
    for (const kindDir of EXTENSION_KIND_DIRS) {
      const dir = join(extRoot, kindDir);
      for (const absolutePath of await collectExtensionTsFiles(dir)) {
        files.push({ kindDir, dir, absolutePath });
      }
    }
    // Several lanes bundle sources side by side, and share one probe
    // host: a host costs a process start and the binary's memory, while
    // probing a built bundle is quick (swamp-club#3494). Results keep the
    // files' order whatever order they finish in.
    const outcomes: Array<
      | { ok: true; source: ExtensionTreeSource }
      | { ok: false; failure: ExtensionTreeFailure }
    > = new Array(files.length);
    let next = 0;
    const prober = new ProcessBundleProber();
    const lane = async () => {
      const loaders = new Map<ExtensionKindDir, ExtensionLoader>();
      while (next < files.length) {
        const i = next++;
        const { kindDir, dir, absolutePath } = files[i];
        let loader = loaders.get(kindDir);
        if (!loader) {
          loader = new ExtensionLoader(
            options.denoRuntime,
            ADAPTERS[kindDir],
            options.repoDir,
            undefined,
            options.repository,
            prober,
            createDenoInfoModuleGraphReader,
          );
          loaders.set(kindDir, loader);
        }
        const relativePath = relative(dir, absolutePath);
        const fileName = toForwardSlashes(relativePath);
        try {
          const indexed = await loader.bundleAndIndexOne({
            absolutePath,
            relativePath,
            baseDir: dir,
            trustPulledCache: options.trustShippedBundles,
          });
          outcomes[i] = {
            ok: true,
            source: { kindDir, absolutePath, fileName, indexed },
          };
        } catch (error) {
          outcomes[i] = {
            ok: false,
            failure: {
              kindDir,
              absolutePath,
              fileName,
              reason: error instanceof Error ? error.message : String(error),
            },
          };
        }
      }
    };
    const lanes = Math.max(
      1,
      Math.min(options.concurrency ?? defaultConcurrency(), files.length),
    );
    // Settled, not raced: a lane still running after another failed would
    // start a new host after the release below.
    const settled = await Promise.allSettled(
      Array.from({ length: lanes }, lane),
    );
    await prober.release();
    for (const outcome of settled) {
      if (outcome.status === "rejected") throw outcome.reason;
    }
    const sources: ExtensionTreeSource[] = [];
    const failures: ExtensionTreeFailure[] = [];
    for (const outcome of outcomes) {
      if (outcome.ok) sources.push(outcome.source);
      else failures.push(outcome.failure);
    }
    return {
      sources,
      failures,
      ...(options.repository ? { repository: options.repository } : {}),
    };
  };
}

/**
 * Lanes for loading sources: one per spare core, at most four, so a large
 * extension loads several times faster without crowding the machine.
 */
export function defaultConcurrency(): number {
  const cores = navigator.hardwareConcurrency ?? 1;
  return Math.max(1, Math.min(4, cores - 1));
}

/**
 * The types an indexed tree registers, for the collective check. Extension
 * sources (`export const extension`) add methods to another type rather than
 * registering one, so they are left out. `_test.ts` files are judged like
 * any other source: the loader walks them in pulled trees, so a behavior
 * named `docker_image_test.ts` still loads (design/primitives/extensions.md).
 */
export function runtimeContentTypes(
  index: ExtensionTreeIndex,
): RuntimeContentType[] {
  const out: RuntimeContentType[] = [];
  for (const source of index.sources) {
    const indexed = source.indexed;
    if (!indexed || indexed.kind === "extension") continue;
    out.push({
      kind: indexed.kind,
      typeNormalized: indexed.typeNormalized,
      fileName: source.fileName,
    });
  }
  return out;
}

const INDEXED_KINDS: ReadonlySet<string> = new Set<BundleIndexResult["kind"]>([
  "model",
  "extension",
  "vault",
  "datastore",
  "report",
  "webhook",
]);

/** An index in the form a package cache entry stores it. */
export function toStoredArchiveIndex(
  index: ExtensionTreeIndex,
): StoredArchiveIndex {
  return {
    sources: index.sources.flatMap((s) =>
      s.indexed
        ? [{
          kindDir: s.kindDir,
          fileName: s.fileName,
          kind: s.indexed.kind,
          typeNormalized: s.indexed.typeNormalized,
        }]
        : []
    ),
    failures: index.failures.map((f) => ({
      kindDir: f.kindDir,
      fileName: f.fileName,
      reason: f.reason,
    })),
  };
}

/**
 * The index a package cache entry stored, or undefined when it names a kind
 * or directory this version does not know, so the archive is indexed again.
 * Paths and bundle details are not stored: only the types are judged.
 */
export function fromStoredArchiveIndex(
  stored: StoredArchiveIndex,
): ExtensionTreeIndex | undefined {
  const kindDirs: ReadonlySet<string> = new Set(EXTENSION_KIND_DIRS);
  if (
    !stored.sources.every((s) =>
      kindDirs.has(s.kindDir) && INDEXED_KINDS.has(s.kind)
    ) ||
    !stored.failures.every((f) => kindDirs.has(f.kindDir))
  ) {
    return undefined;
  }
  return {
    sources: stored.sources.map((s) => ({
      kindDir: s.kindDir as ExtensionKindDir,
      absolutePath: "",
      fileName: s.fileName,
      indexed: {
        kind: s.kind as BundleIndexResult["kind"],
        typeNormalized: s.typeNormalized,
        bundlePath: "",
        fingerprint: "",
        fromCache: true,
      },
    })),
    failures: stored.failures.map((f) => ({
      kindDir: f.kindDir as ExtensionKindDir,
      absolutePath: "",
      fileName: f.fileName,
      reason: f.reason,
    })),
  };
}

/**
 * Every `.ts` file under `dir`, recursively, skipping `_`-prefixed
 * directories (private helpers). Empty when `dir` does not exist.
 */
export async function collectExtensionTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      const path = join(dir, entry.name);
      if (entry.isFile && entry.name.endsWith(".ts")) {
        out.push(path);
      } else if (entry.isDirectory && !entry.name.startsWith("_")) {
        for (const file of await collectExtensionTsFiles(path)) out.push(file);
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return out.sort();
}

function toForwardSlashes(path: string): string {
  return SEPARATOR === "/" ? path : path.split(SEPARATOR).join("/");
}
