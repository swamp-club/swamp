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

import { join, relative, resolve as resolvePath } from "@std/path";
import {
  type ExtensionRef,
  type InstallContext,
  installExtension,
  type InstallResult,
} from "./pull.ts";
import {
  type Extension,
  makeExtension,
  tombstoneAll,
} from "../../domain/extensions/extension.ts";
import { makeSource } from "../../domain/extensions/source.ts";
import { makeSourceLocation } from "../../domain/extensions/source_location.ts";
import { makeBundleLocation } from "../../domain/extensions/bundle_location.ts";
import type { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import { DuplicateTypeError } from "../../infrastructure/persistence/duplicate_type_error.ts";
import { DuplicateTypeUserError } from "../../domain/extensions/duplicate_type_user_error.ts";
import { UserError } from "../../domain/errors.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";
import { ExtensionLoader } from "../../domain/extensions/extension_loader.ts";
import { modelKindAdapter } from "../../domain/extensions/model_kind_adapter.ts";
import { vaultKindAdapter } from "../../domain/extensions/vault_kind_adapter.ts";
import { driverKindAdapter } from "../../domain/extensions/driver_kind_adapter.ts";
import { datastoreKindAdapter } from "../../domain/extensions/datastore_kind_adapter.ts";
import { reportKindAdapter } from "../../domain/extensions/report_kind_adapter.ts";
import type { DenoRuntime } from "../../domain/runtime/deno_runtime.ts";
import type { UpstreamExtensionEntry } from "../../infrastructure/persistence/upstream_extensions.ts";

/** Subdirectories of a per-extension subtree, paired with their kind. */
const KIND_DIRS = [
  "models",
  "vaults",
  "drivers",
  "datastores",
  "reports",
] as const;

type KindDir = typeof KIND_DIRS[number];

/**
 * W2 lifecycle service for installing a single extension. **Owns the
 * catalog write surface** end-to-end:
 *
 * 1. Filesystem mutations (download + extract + copy to per-extension
 *    subtree)
 * 2. Lockfile write (`upstream_extensions.json`)
 * 3. Catalog write (`repository.save(extension)` — synchronous type
 *    extraction via each loader's `bundleAndIndexOne`, then save)
 *
 * **Asymmetric ordering with `RemoveExtensionService`.** Install is
 * filesystem → lockfile → catalog. Remove is the inverse. Pinned in
 * plan v4 challenge #3.
 *
 * **I-Repo-1 fires at install time.** Phase 8 builds the
 * `Extension` aggregate from the just-extracted on-disk subtree
 * (calling each loader's `bundleAndIndexOne` per source file) and
 * commits via `repository.save(extension)`. Cross-extension
 * `(kind, typeNormalized)` collision raises `DuplicateTypeError`
 * synchronously — the user-visible payoff for W2.
 *
 * **FS rollback on `DuplicateTypeError`.** SQLite ROLLBACK does not
 * undo filesystem mutations, so the service explicitly undoes the
 * filesystem writes (delete extracted files, restore lockfile to its
 * prior state) before propagating a {@link UserError} that names both
 * conflicting extensions. Plan v4 calls this "expensive miss #2".
 *
 * **Snapshot semantics inherited from `InstallContext`.** The
 * `lockfileRepository` on the context captures a snapshot at
 * construction. Single-use only — see {@link InstallContext} JSDoc.
 *
 * **W4-inherits.** When the unified loader (KindAdapter) lands in W4,
 * the per-loader `bundleAndIndexOne` calls in `buildExtensionFromDisk`
 * collapse to a single dispatch. The service shape is W4-stable;
 * loaders are the deletion surface.
 */
export class InstallExtensionService {
  private readonly denoRuntime: DenoRuntime;
  private readonly repository: ExtensionRepository;
  private readonly installExtensionFn: (
    ref: ExtensionRef,
    ctx: InstallContext,
  ) => Promise<InstallResult | undefined>;

  constructor(args: {
    denoRuntime: DenoRuntime;
    repository: ExtensionRepository;
    /**
     * Test seam — defaults to the real {@link installExtension} from
     * `pull.ts`. Tests inject a stub that returns a hand-built
     * {@link InstallResult} so phase 8 can be exercised against a
     * pre-staged on-disk subtree without driving a real registry,
     * tarball, or filesystem write. Production callers always omit
     * this.
     */
    installExtensionFn?: (
      ref: ExtensionRef,
      ctx: InstallContext,
    ) => Promise<InstallResult | undefined>;
  }) {
    this.denoRuntime = args.denoRuntime;
    this.repository = args.repository;
    this.installExtensionFn = args.installExtensionFn ?? installExtension;
  }

  /**
   * Installs `ref` using `ctx`. Returns the {@link InstallResult} on a
   * fresh install, or `undefined` when the install short-circuited
   * (alreadyPulled).
   *
   * Throws `ConflictError` from filesystem-conflict detection when
   * `ctx.force` is false. Throws {@link UserError} (mapped from
   * {@link DuplicateTypeError}) when the catalog save detects a
   * cross-extension type collision; filesystem state is rolled back to
   * the pre-install snapshot before the throw.
   */
  async execute(
    ref: ExtensionRef,
    ctx: InstallContext,
  ): Promise<InstallResult | undefined> {
    // Snapshot the lockfile entry BEFORE install so FS rollback can
    // restore it on a catalog-side failure. The snapshot survives
    // installExtension's own writeEntry call (which only mutates the
    // shared lockfileRepository's cache from this point forward).
    const priorEntry = ctx.lockfileRepository.getEntry(ref.name);

    // Phases 1-7: download → extract → copy → prune → lockfile write.
    // (Recursion into deps is internal to installExtension; deps land
    // in the same lockfile snapshot.)
    const result = await this.installExtensionFn(ref, ctx);
    if (!result) return result; // alreadyPulled short-circuit

    // Phase 8: build Extension aggregates for top-level + each freshly-
    // installed dep. **Atomic upgrade pattern** — for each new
    // extension, tombstone any existing aggregates with the SAME name
    // but a DIFFERENT version, so the saveAll commits in one SQLite
    // transaction:
    //   saveAll([tombstoneAll(v1), v2])
    // I-Repo-1 then evaluates against the post-save state where only
    // the new version holds the type. Without this, force-pulling an
    // already-installed extension (or any version-bump pull) would
    // fail with DuplicateTypeError even though the only "conflict" is
    // the user's own prior version. Re-installs of the same version
    // skip the tombstone — the diff-save in saveAll handles
    // overwrite semantics.
    //
    // On DuplicateTypeError (genuine cross-extension collision —
    // not the v1→v2 case), FS rollback the entire set.
    try {
      const installedResults = flattenInstallResults(result);
      const newExtensions = await Promise.all(
        installedResults.map((r) =>
          this.buildExtensionFromDisk(r, ctx.repoDir)
        ),
      );
      const tombstones: Extension[] = [];
      for (const newExt of newExtensions) {
        for (const existing of this.repository.loadByName(newExt.name)) {
          if (existing.version !== newExt.version) {
            tombstones.push(tombstoneAll(existing));
          }
        }
      }
      this.repository.saveAll([...tombstones, ...newExtensions]);
    } catch (error) {
      if (error instanceof DuplicateTypeError) {
        await this.rollbackOnCollision(result, priorEntry, ctx);
        throw mapDuplicateTypeErrorToUserError(error);
      }
      // Half-state from a non-DuplicateTypeError fault during phase 8.
      // Files + lockfile entry are on disk (the install service does
      // NOT auto-roll-back FS for generic faults — see crash-state
      // recovery posture in design/extension.md). Surface a UserError
      // with the pinned recovery message so log-mode shows a clean
      // single-line guidance instead of a stack trace.
      throw new UserError(
        `Install partially applied for ${ref.name} — files extracted but the ` +
          `catalog write failed (${
            error instanceof Error ? error.message : String(error)
          }). Run \`swamp doctor extensions\` to inspect, or retry ` +
          `\`swamp extension pull ${ref.name}\` to reconcile.`,
      );
    }

    return result;
  }

  /**
   * Walks the per-extension subtree on disk and builds an
   * {@link Extension} aggregate whose Sources are in `Indexed` state
   * with `(kind, typeNormalized, bundlePath)` populated. Each source
   * file is bundled and type-extracted via the appropriate loader's
   * `bundleAndIndexOne` (Pin 1 contract: NO catalog writes from the
   * loader; the lifecycle service is the catalog-write owner).
   */
  private async buildExtensionFromDisk(
    result: InstallResult,
    repoDir: string,
  ): Promise<Extension> {
    // Resolve to an absolute path so the source_path written to the
    // catalog matches the absolute paths the legacy user_*_loader
    // bootstrap path uses (`populateCatalogFromDir`). Without this, a
    // relative `repoDir` (e.g. `.`) would have phase 8 writing relative
    // source_paths while the loader writes absolute ones, leaving
    // duplicate rows in the catalog and the legacy upsert's empty-
    // identity rows would shadow phase 8's properly-identified rows on
    // the next `loadByName` call.
    const absoluteRepoDir = resolvePath(repoDir);
    const extRoot = join(
      swampPath(absoluteRepoDir, "pulled-extensions"),
      result.name,
    );
    const sources: ReturnType<typeof makeSource>[] = [];

    for (const kindDir of KIND_DIRS) {
      const dir = join(extRoot, kindDir);
      const tsFiles = await collectTsFiles(dir);
      const loader = this.makeLoaderForKind(kindDir, repoDir);
      for (const absolutePath of tsFiles) {
        const relativePath = relative(dir, absolutePath);
        const out = await loader.bundleAndIndexOne({
          absolutePath,
          relativePath,
          baseDir: dir,
        });
        if (!out) continue;
        sources.push(
          makeSource({
            id: makeSourceLocation(absolutePath, extRoot),
            kind: out.kind,
            fingerprint: out.fingerprint,
            state: {
              tag: "Indexed",
              type: out.typeNormalized,
              bundle: makeBundleLocation(out.bundlePath, out.fingerprint),
            },
          }),
        );
      }
    }

    return makeExtension({
      name: result.name,
      version: result.version,
      origin: "pulled",
      extensionRoot: extRoot,
      sources,
    });
  }

  /**
   * Constructs the loader for a given kind directory. Each loader is
   * stateless w.r.t. `bundleAndIndexOne` (no catalog write — Pin 1) so
   * constructing fresh per call is cheap.
   */
  private makeLoaderForKind(
    kindDir: KindDir,
    repoDir: string,
  ): {
    bundleAndIndexOne: (args: {
      absolutePath: string;
      relativePath: string;
      baseDir: string;
    }) => Promise<
      | {
        kind:
          | "model"
          | "extension"
          | "vault"
          | "driver"
          | "datastore"
          | "report";
        typeNormalized: string;
        bundlePath: string;
        fingerprint: string;
      }
      | null
    >;
  } {
    switch (kindDir) {
      case "models":
        return new ExtensionLoader(
          this.denoRuntime,
          modelKindAdapter,
          repoDir,
          undefined,
          this.repository,
        );
      case "vaults":
        return new ExtensionLoader(
          this.denoRuntime,
          vaultKindAdapter,
          repoDir,
          undefined,
          this.repository,
        );
      case "drivers":
        return new ExtensionLoader(
          this.denoRuntime,
          driverKindAdapter,
          repoDir,
          undefined,
          this.repository,
        );
      case "datastores":
        return new ExtensionLoader(
          this.denoRuntime,
          datastoreKindAdapter,
          repoDir,
          undefined,
          this.repository,
        );
      case "reports":
        return new ExtensionLoader(
          this.denoRuntime,
          reportKindAdapter,
          repoDir,
          undefined,
          this.repository,
        );
    }
  }

  /**
   * Filesystem rollback on `DuplicateTypeError`. Deletes the just-
   * installed files for the top-level extension AND any freshly-
   * installed deps, then restores the lockfile to its pre-install
   * state.
   *
   * Best-effort: any individual delete that fails (file already gone,
   * permission denied) is logged and swallowed so the caller still
   * surfaces the original `DuplicateTypeError` as the user-visible
   * cause. The disk-walk fallback in the loader pipeline handles any
   * stragglers on the next swamp invocation.
   */
  private async rollbackOnCollision(
    result: InstallResult,
    priorEntry: UpstreamExtensionEntry | null,
    ctx: InstallContext,
  ): Promise<void> {
    const installedResults = flattenInstallResults(result);
    for (const r of installedResults) {
      for (const file of r.extractedFiles) {
        const absolutePath = join(ctx.repoDir, file);
        try {
          await Deno.remove(absolutePath, { recursive: true });
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) {
            if (ctx.logger) {
              ctx.logger.warn`FS rollback failed for ${absolutePath}: ${error}`;
            }
          }
        }
      }
    }

    // Restore the top-level extension's lockfile entry to its prior
    // state (or remove if first-install). Deps' lockfile entries were
    // also written during install but their priorEntry isn't captured
    // here — they were absent before this install (otherwise
    // installExtension would have skipped them via the alreadyPulled
    // / lockfile check). So we remove deps' entries.
    try {
      if (priorEntry) {
        await ctx.lockfileRepository.writeEntry(
          result.name,
          priorEntry.version,
          priorEntry.files ?? [],
          {
            include: priorEntry.include,
            checksum: priorEntry.checksum,
            filesChecksum: priorEntry.filesChecksum,
            serverUrl: priorEntry.serverUrl,
          },
        );
      } else {
        await ctx.lockfileRepository.removeEntry(result.name);
      }
      for (const dep of installedResults.slice(1)) {
        await ctx.lockfileRepository.removeEntry(dep.name);
      }
    } catch (error) {
      if (ctx.logger) {
        ctx.logger.warn`Lockfile rollback failed: ${error}`;
      }
    }
  }
}

/**
 * Flattens an {@link InstallResult} tree into a depth-first list:
 * `[topLevel, ...deps, ...transitiveDeps]`. Used to drive phase 8
 * across the entire install operation atomically.
 */
function flattenInstallResults(result: InstallResult): InstallResult[] {
  const out: InstallResult[] = [result];
  for (const dep of result.dependencyResults) {
    out.push(...flattenInstallResults(dep));
  }
  return out;
}

/**
 * Collects every `.ts` file under `dir` recursively. Returns absolute
 * paths. Returns `[]` when `dir` doesn't exist (the per-extension
 * subtree may not include every kind directory). Skips `_`-prefixed
 * directories (private helpers convention).
 */
async function collectTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      const path = join(dir, entry.name);
      if (entry.isFile && entry.name.endsWith(".ts")) {
        out.push(path);
      } else if (entry.isDirectory && !entry.name.startsWith("_")) {
        out.push(...await collectTsFiles(path));
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return out;
}

/**
 * Wraps a {@link DuplicateTypeError} in a
 * {@link DuplicateTypeUserError} so the top-level CLI error handler
 * renders a clean single-line message in log mode AND emits the
 * pinned JSON shape in JSON mode (plan v4 step 11). Both source paths
 * are named — the W2 user-visible payoff that replaces W1b's silent
 * first-wins.
 */
function mapDuplicateTypeErrorToUserError(
  error: DuplicateTypeError,
): DuplicateTypeUserError {
  return new DuplicateTypeUserError({
    kind: error.kind,
    typeNormalized: error.typeNormalized,
    existing: error.firstSource,
    conflicting: error.secondSource,
  });
}
