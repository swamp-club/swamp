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

import { join, relative } from "@std/path";
import {
  type ExtensionRef,
  type InstallContext,
  installExtension,
  type InstallResult,
} from "./pull.ts";
import {
  type Extension,
  makeExtension,
} from "../../domain/extensions/extension.ts";
import { makeSource } from "../../domain/extensions/source.ts";
import { makeSourceLocation } from "../../domain/extensions/source_location.ts";
import { makeBundleLocation } from "../../domain/extensions/bundle_location.ts";
import { type ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import { DuplicateTypeError } from "../../infrastructure/persistence/duplicate_type_error.ts";
import { swampPath } from "../../infrastructure/persistence/paths.ts";
import { UserModelLoader } from "../../domain/models/user_model_loader.ts";
import { UserDriverLoader } from "../../domain/drivers/user_driver_loader.ts";
import { UserVaultLoader } from "../../domain/vaults/user_vault_loader.ts";
import { UserDatastoreLoader } from "../../domain/datastore/user_datastore_loader.ts";
import { UserReportLoader } from "../../domain/reports/user_report_loader.ts";
import type { DenoRuntime } from "../../domain/runtime/deno_runtime.ts";
import type { UpstreamExtensionEntry } from "../../infrastructure/persistence/upstream_extensions.ts";
import { UserError } from "../../domain/errors.ts";

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
    // installed dep, then saveAll across the full set so I-Repo-1
    // evaluates the post-save state across this install operation as a
    // unit. On DuplicateTypeError, FS rollback the entire set.
    try {
      const installedResults = flattenInstallResults(result);
      const extensions = await Promise.all(
        installedResults.map((r) =>
          this.buildExtensionFromDisk(r, ctx.repoDir)
        ),
      );
      this.repository.saveAll(extensions);
    } catch (error) {
      if (error instanceof DuplicateTypeError) {
        await this.rollbackOnCollision(result, priorEntry, ctx);
        throw mapDuplicateTypeErrorToUserError(error);
      }
      throw error;
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
    const extRoot = join(swampPath(repoDir, "pulled-extensions"), result.name);
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
        return new UserModelLoader(
          this.denoRuntime,
          repoDir,
          undefined,
          this.repository,
        );
      case "vaults":
        return new UserVaultLoader(
          this.denoRuntime,
          repoDir,
          undefined,
          this.repository,
        );
      case "drivers":
        return new UserDriverLoader(
          this.denoRuntime,
          repoDir,
          undefined,
          this.repository,
        );
      case "datastores":
        return new UserDatastoreLoader(
          this.denoRuntime,
          repoDir,
          this.repository,
        );
      case "reports":
        return new UserReportLoader(
          this.denoRuntime,
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
 * Wraps a {@link DuplicateTypeError} in a {@link UserError} so the
 * top-level CLI error handler renders a clean message rather than a
 * stack trace. Both source paths are named — the W2 user-visible
 * payoff that replaces W1b's silent first-wins.
 */
function mapDuplicateTypeErrorToUserError(
  error: DuplicateTypeError,
): UserError {
  return new UserError(
    `Type "${error.typeNormalized}" (kind=${error.kind}) is already claimed by ` +
      `${error.firstSource.extensionName}@${error.firstSource.extensionVersion} ` +
      `at ${error.firstSource.canonicalPath}. Cannot install ` +
      `${error.secondSource.extensionName}@${error.secondSource.extensionVersion} ` +
      `at ${error.secondSource.canonicalPath} — filesystem changes rolled back. ` +
      `Run \`swamp extension rm ${error.firstSource.extensionName}\` first if ` +
      `you intended to replace it.`,
  );
}
