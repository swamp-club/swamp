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

import { join, relative, resolve as resolvePath } from "@std/path";
import {
  type ExtensionRef,
  type InstallContext,
  installExtension,
  type InstallExtensionFn,
  type InstallResult,
  type PendingInstall,
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
import {
  DuplicateTypeUserError,
  type InstallRollbackOutcome,
} from "../../domain/extensions/duplicate_type_user_error.ts";
import { UserError } from "../../domain/errors.ts";
import { resolvePulledExtensionsRoot } from "../../infrastructure/persistence/paths.ts";
import { ExtensionLoader } from "../../domain/extensions/extension_loader.ts";
import { modelKindAdapter } from "../../domain/extensions/model_kind_adapter.ts";
import { vaultKindAdapter } from "../../domain/extensions/vault_kind_adapter.ts";
import { datastoreKindAdapter } from "../../domain/extensions/datastore_kind_adapter.ts";
import { reportKindAdapter } from "../../domain/extensions/report_kind_adapter.ts";
import { webhookKindAdapter } from "../../domain/extensions/webhook_kind_adapter.ts";
import type { DenoRuntime } from "../../domain/runtime/deno_runtime.ts";

/** Subdirectories of a per-extension subtree, paired with their kind. */
const KIND_DIRS = [
  "models",
  "vaults",
  "datastores",
  "reports",
  "webhooks",
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
 * **Commit or rollback after the catalog save.** Phase 8 receives the
 * install uncommitted ({@link PendingInstall}): the previous versions
 * of the extension and its dependencies are still kept aside. SQLite
 * ROLLBACK does not undo filesystem mutations, so on `DuplicateTypeError`
 * the service rolls the install back (lockfile entries restored, then
 * every root moved back) before propagating a {@link UserError} that
 * names both conflicting extensions; an upgrade that collides leaves
 * the previous version installed (swamp-club#2724). Any other outcome
 * commits. Plan v4 calls the collision case "expensive miss #2".
 *
 * **Snapshot semantics inherited from `InstallContext`.** The
 * `lockfileRepository` on the context captures a snapshot at
 * construction. Single-use only — see {@link InstallContext} JSDoc.
 * installExtension refreshes it under the pulled-extensions lock, and
 * the prior entries a rollback restores are read after that refresh.
 *
 * **W4-inherits.** When the unified loader (KindAdapter) lands in W4,
 * the per-loader `bundleAndIndexOne` calls in `buildExtensionFromDisk`
 * collapse to a single dispatch. The service shape is W4-stable;
 * loaders are the deletion surface.
 */
export class InstallExtensionService {
  private readonly denoRuntime: DenoRuntime;
  private readonly repository: ExtensionRepository;
  private readonly installExtensionFn: InstallExtensionFn;

  constructor(args: {
    denoRuntime: DenoRuntime;
    repository: ExtensionRepository;
    /**
     * Test seam — defaults to the real {@link installExtension} from
     * `pull.ts`. Tests inject a stub that returns a hand-built
     * {@link InstallResult} so phase 8 can be exercised against a
     * pre-staged on-disk subtree without driving a real registry,
     * tarball, or filesystem write. Production callers always omit
     * this. A stub must call `options.underLock` with its result, or
     * phase 8 does not run: use `stubInstallExtension` from
     * `install_test_helpers.ts`.
     */
    installExtensionFn?: InstallExtensionFn;
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
   * `ctx.force` is false. Throws {@link DuplicateTypeUserError} (mapped
   * from {@link DuplicateTypeError}) when the catalog save detects a
   * cross-extension type collision, after rolling the install back to
   * the previous versions; its `rollback` says how that ended.
   */
  async execute(
    ref: ExtensionRef,
    ctx: InstallContext,
  ): Promise<InstallResult | undefined> {
    // Phases 1-7: download → extract → stage and swap → lockfile write,
    // then phase 8 in the underLock hook. installExtension runs apply
    // and the hook in one pulled-extensions lock section, so the catalog
    // save and the commit or rollback cannot interleave with another
    // install or removal on this checkout (swamp-club#2709). Deps recurse
    // inside apply, land in the same section, and are part of `pending`.
    return await this.installExtensionFn(ref, ctx, {
      underLock: (pending) => this.indexInstalled(ref, pending, ctx),
    });
  }

  /**
   * Phase 8, under the lock, with the install still uncommitted: the
   * previous versions are kept until the catalog save decides. Commits
   * on success; rolls back on a type collision, so an upgrade that
   * collides leaves the previous version installed; commits and
   * reports the half-state on any other fault.
   */
  private async indexInstalled(
    ref: ExtensionRef,
    pending: PendingInstall,
    ctx: InstallContext,
  ): Promise<void> {
    const result = pending.result;
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
    // not the v1→v2 case), roll the entire set back.
    try {
      const installedResults = flattenInstallResults(result);
      let newExtensions: Extension[];
      try {
        newExtensions = await Promise.all(
          installedResults.map((r) =>
            this.buildExtensionFromDisk(r, ctx.repoDir)
          ),
        );
      } catch (error) {
        throw new UserError(
          `Install partially applied for ${ref.name} — files extracted but ` +
            `bundling/importing the extension failed (${
              error instanceof Error ? error.message : String(error)
            }). Run \`swamp doctor extensions\` to inspect, or retry ` +
            `\`swamp extension pull ${ref.name}\` to reconcile.`,
        );
      }
      const tombstones: Extension[] = [];
      for (const newExt of newExtensions) {
        for (const existing of this.repository.loadByName(newExt.name)) {
          if (existing.version !== newExt.version) {
            tombstones.push(tombstoneAll(existing));
          }
        }
      }
      this.repository.saveAll([...tombstones, ...newExtensions]);

      const conflicts = this.repository.lastOriginConflicts;
      if (conflicts.length > 0) {
        result.shadowedTypes = conflicts.map((c) => ({
          type: c.type,
          kind: c.kind,
          localSourcePath: c.localSourcePath,
        }));
      }
    } catch (error) {
      if (error instanceof DuplicateTypeError) {
        const rollback = await pending.rollback();
        const ghostRow = await isGhostRow(error);
        throw mapDuplicateTypeErrorToUserError(error, ghostRow, rollback);
      }
      // Half-state from any other fault during phase 8, bundling
      // included: the install commits, so files + lockfile entry hold
      // the new version while the catalog does not (see crash-state
      // recovery posture in design/primitives/extensions.md). A source
      // that fails to bundle on this machine must not block installing
      // the rest. Surface a UserError with the pinned recovery message so
      // log-mode shows a clean single-line guidance instead of a stack
      // trace.
      await pending.commit();
      if (error instanceof UserError) throw error;
      throw new UserError(
        `Install partially applied for ${ref.name} — files extracted but the ` +
          `catalog write failed (${
            error instanceof Error ? error.message : String(error)
          }). Run \`swamp doctor extensions\` to inspect, or retry ` +
          `\`swamp extension pull ${ref.name}\` to reconcile.`,
      );
    }
    await pending.commit();
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
    pulledExtensionsRoot?: string,
  ): Promise<Extension> {
    const absoluteRepoDir = resolvePath(repoDir);
    const effectivePulledRoot = pulledExtensionsRoot ??
      resolvePulledExtensionsRoot(absoluteRepoDir);
    const extRoot = join(effectivePulledRoot, result.name);
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
        const stat = await Deno.stat(absolutePath);
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
            sourceMtime: stat.mtime?.toISOString() ?? "",
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
          | "datastore"
          | "report"
          | "webhook";
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
      case "webhooks":
        return new ExtensionLoader(
          this.denoRuntime,
          webhookKindAdapter,
          repoDir,
          undefined,
          this.repository,
        );
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
 * first-wins. The repository reports the occupant already in the
 * catalog as `firstSource` and the one being installed as
 * `secondSource`, so they map to `existing` and `conflicting`.
 */
function mapDuplicateTypeErrorToUserError(
  error: DuplicateTypeError,
  ghostRow: boolean,
  rollback: InstallRollbackOutcome,
): DuplicateTypeUserError {
  return new DuplicateTypeUserError({
    kind: error.kind,
    typeNormalized: error.typeNormalized,
    existing: error.firstSource,
    conflicting: error.secondSource,
    isGhostRow: ghostRow,
    rollback,
  });
}

async function isGhostRow(error: DuplicateTypeError): Promise<boolean> {
  // Only check firstSource, which the repository reports as the
  // pre-existing catalog occupant when the other side is being saved.
  // secondSource is then the extension being installed — its new files
  // are gone after the rollback, so it can never be a meaningful
  // ghost-row signal. When both sides are in the same save
  // (e.g. two dependencies of one install), the order is catalog order
  // and firstSource may be an incoming extension.
  try {
    await Deno.stat(error.firstSource.canonicalPath);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return true;
  }
  return false;
}
