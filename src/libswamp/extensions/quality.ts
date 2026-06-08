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
  computePackageCacheHash,
  type ExtensionPackageCache,
  type PackageCacheHashInput,
} from "../../domain/extensions/extension_package_cache.ts";
import {
  createRubricScoreDeps,
  RUBRIC_VERSION,
  type RubricScore,
  type RubricScoreDeps,
  scoreExtensionTarball,
} from "../../domain/extensions/extension_rubric_scorer.ts";
import { extractBareSpecifierNames } from "../../domain/models/bundle.ts";
import { extractTarGz } from "../../infrastructure/archive/tar_archive.ts";
import { EmbeddedDenoRuntime } from "../../infrastructure/runtime/embedded_deno_runtime.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import type { DependencyTrustResult } from "../../domain/extensions/extension_dependency_trust_checker.ts";
import type { LibSwampContext } from "../context.ts";
import { validationFailed } from "../errors.ts";
import type { SwampError } from "../errors.ts";
import {
  extensionPushPrepare,
  type ExtensionPushPrepared,
  type ExtensionPushPrepareDeps,
  type ExtensionPushPrepareInput,
} from "./push.ts";

/** Emitted by the extension quality generator. */
export type ExtensionQualityEvent =
  | { kind: "packaging" }
  | { kind: "cache_hit"; hash: string }
  | { kind: "scoring" }
  | { kind: "completed"; data: ExtensionQualityData }
  | { kind: "error"; error: SwampError };

/** Result of a quality scoring run. */
export interface ExtensionQualityData {
  score: RubricScore;
  cacheHash: string;
  archiveSize: number;
  cacheHit: boolean;
  dependencyTrustResult: DependencyTrustResult;
}

/** Input to run a quality score. */
export interface ExtensionQualityInput {
  prepareInput: ExtensionPushPrepareInput;
  hashInput: PackageCacheHashInput;
}

/** Dependencies injected into the quality generator. */
export interface ExtensionQualityDeps {
  pushPrepareDeps: ExtensionPushPrepareDeps;
  cache: ExtensionPackageCache;
  ensureDenoPath: () => Promise<string>;
  makeScoreDeps: (denoPath: string) => RubricScoreDeps;
}

async function readImportMap(
  denoConfigPath: string | undefined,
): Promise<Record<string, string> | undefined> {
  if (!denoConfigPath) return undefined;
  try {
    const raw = await Deno.readTextFile(denoConfigPath);
    const config = JSON.parse(raw);
    if (
      config.imports && typeof config.imports === "object" &&
      !Array.isArray(config.imports)
    ) {
      return config.imports as Record<string, string>;
    }
  } catch {
    // Missing or unparseable config — fall back to no import map.
  }
  return undefined;
}

/** Wires real infrastructure into ExtensionQualityDeps. */
export function createExtensionQualityDeps(
  pushPrepareDeps: ExtensionPushPrepareDeps,
  cache: ExtensionPackageCache,
): ExtensionQualityDeps {
  const denoRuntime = new EmbeddedDenoRuntime();
  return {
    pushPrepareDeps,
    cache,
    ensureDenoPath: () => denoRuntime.ensureDeno(),
    makeScoreDeps: (denoPath) => createRubricScoreDeps(denoPath, extractTarGz),
  };
}

/**
 * Runs the quality scorer against an extension, reusing or populating
 * the opportunistic package cache along the way. The bytes scored are
 * the bytes a subsequent `swamp extension push` would upload if run
 * against the same source — same input hash, same tarball, same score
 * as the registry will compute server-side.
 */
export async function* extensionQuality(
  ctx: LibSwampContext,
  deps: ExtensionQualityDeps,
  input: ExtensionQualityInput,
): AsyncIterable<ExtensionQualityEvent> {
  yield* withGeneratorSpan(
    "swamp.extension.quality",
    { "extension.name": input.prepareInput.manifest.name },
    (async function* () {
      ctx.logger.debug`Executing extension quality`;

      const hash = await computePackageCacheHash(input.hashInput);
      ctx.logger.debug`Package cache hash: ${hash}`;

      let archiveBytes: Uint8Array;
      let cacheHit = false;
      let dependencyTrustResult: DependencyTrustResult | undefined = undefined;

      const cached = await deps.cache.get(hash);
      if (cached) {
        cacheHit = true;
        archiveBytes = cached.archiveBytes;
        ctx.logger
          .debug`Cache hit: reusing ${cached.archiveBytes.length} bytes`;
        yield { kind: "cache_hit", hash };

        const sourceFiles = [
          ...input.prepareInput.allModelFiles,
          ...input.prepareInput.allVaultFiles,
          ...input.prepareInput.allDriverFiles,
          ...input.prepareInput.allDatastoreFiles,
          ...input.prepareInput.allReportFiles,
        ];
        const specifiers = await deps.pushPrepareDeps
          .extractDependencySpecifiers(sourceFiles);
        if (specifiers.length > 0) {
          dependencyTrustResult = await deps.pushPrepareDeps
            .checkDependencyTrust(specifiers);
        } else {
          dependencyTrustResult = {
            errors: [],
            warnings: [],
            audited: [],
            passed: true,
          };
        }
      } else {
        yield { kind: "packaging" };
        let prepared: ExtensionPushPrepared;
        try {
          prepared = await extensionPushPrepare(
            ctx,
            deps.pushPrepareDeps,
            { ...input.prepareInput, dryRun: true },
          );
        } catch (error) {
          yield { kind: "error", error: error as SwampError };
          return;
        }
        archiveBytes = prepared.archiveBytes;
        dependencyTrustResult = prepared.dependencyTrustResult;
        await deps.cache.put(hash, archiveBytes, {
          extensionName: input.prepareInput.manifest.name,
          extensionVersion: input.prepareInput.manifest.version,
          rubricVersion: RUBRIC_VERSION,
        });
        ctx.logger.debug`Cache put: ${archiveBytes.length} bytes at ${hash}`;
      }

      const allSourceFiles = [
        ...input.prepareInput.allModelFiles,
        ...input.prepareInput.allVaultFiles,
        ...input.prepareInput.allDriverFiles,
        ...input.prepareInput.allDatastoreFiles,
        ...input.prepareInput.allReportFiles,
      ];
      const bareSpecifiers = new Set<string>();
      for (const file of allSourceFiles) {
        try {
          const src = await Deno.readTextFile(file);
          for (const name of extractBareSpecifierNames(src)) {
            bareSpecifiers.add(name);
          }
        } catch {
          // File unreadable — skip.
        }
      }
      if (bareSpecifiers.size > 0) {
        const names = [...bareSpecifiers].sort();
        yield {
          kind: "error",
          error: validationFailed(
            `Extension uses bare import specifiers that cannot be resolved by the server-side scorer: ${
              names.map((s) => `"${s}"`).join(", ")
            }. Use explicit npm: or jsr: prefixes in your source files (e.g., "npm:package@version").`,
          ),
        };
        return;
      }

      yield { kind: "scoring" };
      const denoPath = await deps.ensureDenoPath();
      const scoreDeps = deps.makeScoreDeps(denoPath);
      const importMap = await readImportMap(
        input.prepareInput.denoConfigPath,
      );
      const score = await scoreExtensionTarball(
        archiveBytes,
        input.prepareInput.manifest,
        scoreDeps,
        {
          dependencyTrustPassed: dependencyTrustResult?.passed,
          dependencyTrustBlockerCount: dependencyTrustResult?.errors.length,
          importMap,
        },
      );

      yield {
        kind: "completed",
        data: {
          score,
          cacheHash: hash,
          archiveSize: archiveBytes.length,
          cacheHit,
          dependencyTrustResult,
        },
      };
    })(),
  );
}
