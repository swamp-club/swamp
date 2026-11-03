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
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
  SEPARATOR,
} from "@std/path";
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
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import { BundleSafetyRefusal } from "../../domain/extensions/bundle_safety_refusal.ts";
import {
  analyzeBundleSafety,
  type BundleDependencyIssue,
} from "../../domain/extensions/extension_safety_analyzer.ts";
import {
  bundleDependencyWarnings,
  describeBundleErrors,
} from "./bundle_safety_scan.ts";
import { resolvePulledExtensionsRoot } from "../../infrastructure/persistence/paths.ts";
import { ExtensionLoader } from "../../domain/extensions/extension_loader.ts";
import type { BundleProber } from "../../domain/extensions/bundle_prober.ts";
import { modelKindAdapter } from "../../domain/extensions/model_kind_adapter.ts";
import { vaultKindAdapter } from "../../domain/extensions/vault_kind_adapter.ts";
import { datastoreKindAdapter } from "../../domain/extensions/datastore_kind_adapter.ts";
import { reportKindAdapter } from "../../domain/extensions/report_kind_adapter.ts";
import { webhookKindAdapter } from "../../domain/extensions/webhook_kind_adapter.ts";
import type { DenoRuntime } from "../../domain/runtime/deno_runtime.ts";
import { createDenoInfoModuleGraphReader } from "../../infrastructure/runtime/deno_info_module_graph_reader.ts";
import { withSpan } from "../../infrastructure/tracing/mod.ts";

const KIND_DIRS = [
  "models",
  "vaults",
  "datastores",
  "reports",
  "webhooks",
] as const;

type KindDir = typeof KIND_DIRS[number];

/**
 * install is filesystem, lockfile, catalog; remove is the inverse. SQLite
 * rollback does not undo filesystem changes, so on DuplicateTypeError the
 * service restores lockfile entries and moves roots back
 */
export class InstallExtensionService {
  private readonly denoRuntime: DenoRuntime;
  private readonly repository: ExtensionRepository;
  private readonly bundleProber: BundleProber | undefined;
  private readonly installExtensionFn: InstallExtensionFn;

  constructor(args: {
    denoRuntime: DenoRuntime;
    repository: ExtensionRepository;
    /**
     * a stub must call options.underLock with its result, or phase 8 does not
     * run: use stubInstallExtension from install_test_helpers.ts
     */
    installExtensionFn?: InstallExtensionFn;
    /**
     * released once every installed extension has been indexed: the root and
     * its dependencies are indexed concurrently and share it
     */
    bundleProber?: BundleProber;
  }) {
    this.bundleProber = args.bundleProber;
    this.denoRuntime = args.denoRuntime;
    this.repository = args.repository;
    this.installExtensionFn = args.installExtensionFn ?? installExtension;
  }

  /**
   * throws ConflictError on a filesystem conflict when ctx.force is false, and
   * DuplicateTypeUserError on a cross-extension type collision after rolling
   * back to the previous versions
   */
  async execute(
    ref: ExtensionRef,
    ctx: InstallContext,
  ): Promise<InstallResult | undefined> {
    // installExtension runs apply and the phase 8 hook in one pulled-extensions
    // lock section, so catalog save and commit or rollback cannot interleave
    // with another install or removal; deps recurse in apply
    return await this.installExtensionFn(ref, ctx, {
      underLock: (pending) =>
        withSpan(
          "swamp.extension.index",
          { "extension.name": ref.name },
          () => this.indexInstalled(ref, pending, ctx),
        ),
    });
  }

  /**
   * previous versions are kept until the catalog save decides: commits on success,
   * rolls back on a type collision so an upgrade that collides keeps the previous
   * version, and commits and reports the half-state on any other fault
   */
  private async indexInstalled(
    ref: ExtensionRef,
    pending: PendingInstall,
    ctx: InstallContext,
  ): Promise<void> {
    const result = pending.result;
    // for each new extension, tombstone aggregates of the same name and a
    // different version so one saveAll transaction replaces it; otherwise a
    // version bump hits DuplicateTypeError against the prior version
    try {
      const installedResults = flattenInstallResults(result);
      let newExtensions: Extension[];
      try {
        // settled, not raced: a branch still indexing after another failed
        // would probe again after the release below and leave a probe host
        // running
        const settled = await Promise.allSettled(
          installedResults.map((r) =>
            this.buildExtensionFromDisk(r, ctx.repoDir)
          ),
        );
        // A refusal anywhere in the set decides, ahead of any other
        // failure: committing would keep the refused extension.
        const refusals = settled.flatMap((outcome) =>
          outcome.status === "rejected" &&
            outcome.reason instanceof BundleSafetyRefusal
            ? [outcome.reason]
            : []
        );
        if (refusals.length > 0) throw BundleSafetyRefusal.merge(refusals);
        newExtensions = settled.map((outcome) => {
          if (outcome.status === "rejected") throw outcome.reason;
          return outcome.value;
        });
      } catch (error) {
        // A refused bundle never ran; the install is undone below.
        if (error instanceof BundleSafetyRefusal) throw error;
        throw new UserError(
          `Install partially applied for ${ref.name} — files extracted but ` +
            `bundling/importing the extension failed (${
              error instanceof Error ? error.message : String(error)
            }). Run \`swamp doctor extensions\` to inspect, or retry ` +
            `\`swamp extension pull ${ref.name}\` to reconcile.`,
        );
      } finally {
        await this.bundleProber?.release();
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
      if (error instanceof BundleSafetyRefusal) {
        throw bundleRefusalError(ref.name, error, await pending.rollback());
      }
      if (error instanceof DuplicateTypeError) {
        const rollback = await pending.rollback();
        const ghostRow = await isGhostRow(error);
        throw mapDuplicateTypeErrorToUserError(error, ghostRow, rollback);
      }
      // half-state from any other fault: the install commits, so files and
      // lockfile hold the new version while the catalog does not; a source that
      // fails to bundle here must not block installing the rest
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
    const dependencyIssues: BundleDependencyIssue[] = [];

    // a source that fails for any other reason does not stop the rest, or a
    // later source could be committed unscanned; the first failure is thrown
    // once every source has been tried, a refusal at once
    let failure: { error: unknown } | undefined;
    for (const kindDir of KIND_DIRS) {
      const dir = join(extRoot, kindDir);
      const tsFiles = await collectTsFiles(dir);
      const loader = this.makeLoaderForKind(kindDir, repoDir);
      for (const absolutePath of tsFiles) {
        const relativePath = relative(dir, absolutePath);
        const index = (trustPulledCache: boolean) =>
          loader.bundleAndIndexOne({
            absolutePath,
            relativePath,
            baseDir: dir,
            // the archive's bundle, which pull scanned and checked against its
            // record, runs as extension install runs it; the loader rebuilds a
            // source the archive has no bundle for
            trustPulledCache,
            // a bundle built here runs, not the archive's: scan it before it is
            // imported
            checkBundle: async (js, bundlePath) => {
              const name = `bundle rebuilt from ${
                relative(extRoot, absolutePath).split(SEPARATOR).join("/")
              }`;
              const scanned = analyzeBundleSafety(js, name, {
                isExtensionModule: (path) =>
                  isUnderPulledExtensions(path, effectivePulledRoot),
              });
              if (scanned.errors.length > 0) {
                // a bundle dir the archive had nothing for is not staged, so
                // the rollback would leave it; a failed removal must not
                // replace the refusal, which is what rolls the install back
                const leftBehind = bundlePath === "" ? [] : await Deno.remove(
                  bundlePath,
                ).then(
                  () => [],
                  (error: unknown) =>
                    error instanceof Deno.errors.NotFound ? [] : [bundlePath],
                );
                throw new BundleSafetyRefusal(scanned.errors, leftBehind);
              }
              for (const issue of scanned.dependencyIssues) {
                dependencyIssues.push(issue);
              }
            },
          });
        const bundlePath = loader.getBundlePath(relativePath, dir);
        const archiveBundle = bundlePath !== "" &&
          await Deno.stat(bundlePath).then(() => true, () => false);
        // A bundle of a format this swamp does not run must not run: removed,
        // the loader has no staged bundle to fall back to when the rebuild
        // fails or cannot be tried.
        if (result.keepArchiveBundles === false && archiveBundle) {
          await Deno.remove(bundlePath);
        }
        const keep = result.keepArchiveBundles === true && archiveBundle;
        let out: Awaited<ReturnType<typeof loader.bundleAndIndexOne>>;
        try {
          try {
            out = await index(keep);
          } catch (error) {
            // An archive bundle this swamp cannot load is rebuilt from the
            // pinned source, and scanned, once. A source the archive had no
            // bundle for was rebuilt already.
            if (!keep || error instanceof BundleSafetyRefusal) throw error;
            out = await index(false);
          }
        } catch (error) {
          if (error instanceof BundleSafetyRefusal) throw error;
          failure ??= { error };
          continue;
        }
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

    if (failure) throw failure.error;

    // A dependency warning's file is the dependency's label, the same from
    // the archive's bundle and from this rebuild, so one already reported
    // is not reported again.
    const reported = new Set(result.safetyWarnings.map((w) => w.file));
    for (
      const warning of bundleDependencyWarnings(dependencyIssues, reported)
    ) {
      result.safetyWarnings.push(warning);
    }

    return makeExtension({
      name: result.name,
      version: result.version,
      origin: "pulled",
      extensionRoot: extRoot,
      sources,
    });
  }

  private makeLoaderForKind(
    kindDir: KindDir,
    repoDir: string,
  ): {
    getBundlePath: (relativePath: string, baseDir: string) => string;
    bundleAndIndexOne: (args: {
      absolutePath: string;
      relativePath: string;
      baseDir: string;
      trustPulledCache?: boolean;
      checkBundle?: (js: string, bundlePath: string) => void | Promise<void>;
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
          this.bundleProber,
          createDenoInfoModuleGraphReader,
        );
      case "vaults":
        return new ExtensionLoader(
          this.denoRuntime,
          vaultKindAdapter,
          repoDir,
          undefined,
          this.repository,
          this.bundleProber,
          createDenoInfoModuleGraphReader,
        );
      case "datastores":
        return new ExtensionLoader(
          this.denoRuntime,
          datastoreKindAdapter,
          repoDir,
          undefined,
          this.repository,
          this.bundleProber,
          createDenoInfoModuleGraphReader,
        );
      case "reports":
        return new ExtensionLoader(
          this.denoRuntime,
          reportKindAdapter,
          repoDir,
          undefined,
          this.repository,
          this.bundleProber,
          createDenoInfoModuleGraphReader,
        );
      case "webhooks":
        return new ExtensionLoader(
          this.denoRuntime,
          webhookKindAdapter,
          repoDir,
          undefined,
          this.repository,
          this.bundleProber,
          createDenoInfoModuleGraphReader,
        );
    }
  }
}

/**
 * the install path is this machine's, which no archive chooses; esbuild paths
 * are relative to the cwd or output file, so match the pulled-extensions
 * segment and also resolve against the cwd
 */
function isUnderPulledExtensions(path: string, pulledRoot: string): boolean {
  if (/(?:^|\/)pulled-extensions\//.test(path.replaceAll("\\", "/"))) {
    return true;
  }
  const fromRoot = relative(pulledRoot, resolvePath(path));
  return fromRoot !== "" && !fromRoot.startsWith("..") &&
    !isAbsolute(fromRoot);
}

function bundleRefusalError(
  name: string,
  refusal: BundleSafetyRefusal,
  rollback: InstallRollbackOutcome,
): UserError {
  const outcome = rollback.status === "rolled-back"
    ? "The install was rolled back to the previously installed version, " +
      "if there was one."
    : rollback.status === "kept"
    ? "The install could not be rolled back (the lockfile could not be " +
      `restored), so it is still installed: remove it with \`swamp ` +
      `extension rm ${name}\` before running anything from it.`
    : "The rollback could not finish: the next `swamp extension` install " +
      "or removal will finish it.";
  const leftBehind = refusal.leftBehind.length === 0
    ? ""
    : `\nThe refused bundle could not be deleted; delete it by hand: ${
      refusal.leftBehind.join(", ")
    }`;
  return markErrorPaths(
    new UserError(
      `Extension bundle has safety errors. Install aborted.\n${
        describeBundleErrors(refusal.errors)
      }\n${outcome}${leftBehind}`,
    ),
    refusal.errors.map((e) => e.file),
  );
}

function flattenInstallResults(result: InstallResult): InstallResult[] {
  const out: InstallResult[] = [result];
  for (const dep of result.dependencyResults) {
    out.push(...flattenInstallResults(dep));
  }
  return out;
}

async function collectTsFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    // In name order, so phase 8 builds and scans sources in the same order
    // on every filesystem.
    const entries = await Array.fromAsync(Deno.readDir(dir));
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
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
 * the repository reports the occupant already in the catalog as firstSource and
 * the one being installed as secondSource, which map to existing and
 * conflicting
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
  // only firstSource is checked: it is the pre-existing catalog occupant, while
  // secondSource is the extension being installed, whose files are gone after
  // rollback; in one save the order is catalog order
  try {
    await Deno.stat(error.firstSource.canonicalPath);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return true;
  }
  return false;
}
