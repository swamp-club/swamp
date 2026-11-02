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
  predictPublishedPrivate,
  type RubricScore,
  type RubricScoreDeps,
  scoreExtensionTarball,
} from "../../domain/extensions/extension_rubric_scorer.ts";
import {
  type PrivateSourceStanding,
  RUBRIC_VERSION,
} from "@swamp-club/extension-scoring/rubric";
import type { ExtensionManifest } from "../../domain/extensions/extension_manifest.ts";
import { collectiveOf } from "../../domain/extensions/extension_publish_checks.ts";
import type { ClientIdentity } from "../../infrastructure/http/client_identity.ts";
import { ExtensionApiClient } from "../../infrastructure/http/extension_api_client.ts";
import {
  SwampClubClient,
  type WhoamiResponse,
} from "../../infrastructure/http/swamp_club_client.ts";
import { extractTarGz } from "../../infrastructure/archive/tar_archive.ts";
import { EmbeddedDenoRuntime } from "../../infrastructure/runtime/embedded_deno_runtime.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import {
  dependencyTrustBlockerCount,
  type DependencyTrustResult,
  looseSpecifierCount,
  notAuditedCount,
  notAuditedFixes,
  unpublishedSpecifiers,
} from "@swamp-club/extension-scoring/dependency-audit";
import type { ManifestLicenseWarning } from "@swamp-club/extension-scoring/licensing";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import {
  extensionPushPrepare,
  type ExtensionPushPrepared,
  type ExtensionPushPrepareDeps,
  type ExtensionPushPrepareInput,
  type LocalGateFailure,
  type QualityFindings,
} from "./push.ts";
import { sourceHostingOf } from "../auth/whoami.ts";

export type ExtensionQualityEvent =
  | { kind: "packaging" }
  | { kind: "cache_hit"; hash: string }
  | { kind: "scoring" }
  | { kind: "completed"; data: ExtensionQualityData }
  | { kind: "error"; error: SwampError };

export interface ExtensionQualityData {
  score: RubricScore;
  license: string | null;
  licenseWarning: ManifestLicenseWarning | undefined;
  cacheHash: string;
  archiveSize: number;
  cacheHit: boolean;
  dependencyTrustResult: DependencyTrustResult;
  /**
   * computed on every run, including a cache hit, so quality always reports
   * them.
   */
  findings: QualityFindings;
  /**
   * each would stop a push; the score is still computed so the author sees the
   * rubric beside them.
   */
  gateFailures: LocalGateFailure[];
  excludedFromArchive: string[];
  /**
   * false when the registry's scorer cannot resolve the published extension's
   * bare imports, so it scores the documentation factors 0 whatever the local
   * score says.
   */
  registryScorable: boolean;
}

export interface ExtensionQualityInput {
  prepareInput: ExtensionPushPrepareInput;
  hashInput: PackageCacheHashInput;
  /**
   * run `deno doc` as the registry does: an empty cache and no inherited
   * registry credentials.
   */
  isolated?: boolean;
}

/** each call takes the lookup's signal, so one timeout bounds them all. */
export interface PrivateSourceLookupDeps {
  loadCredentials: () => Promise<
    { serverUrl: string; apiKey: string } | null
  >;
  whoami: (
    serverUrl: string,
    apiKey: string,
    signal: AbortSignal,
  ) => Promise<WhoamiResponse>;
  getExtensionVisibility: (
    serverUrl: string,
    name: string,
    apiKey: string,
    signal: AbortSignal,
  ) => Promise<{ isPrivate: boolean } | null>;
}

export interface ExtensionQualityDeps {
  pushPrepareDeps: ExtensionPushPrepareDeps;
  cache: ExtensionPackageCache;
  ensureDenoPath: () => Promise<string>;
  makeScoreDeps: (
    denoPath: string,
    options?: { isolated?: boolean },
  ) => RubricScoreDeps;
  privateSourceLookup: PrivateSourceLookupDeps;
}

export function createExtensionQualityDeps(
  pushPrepareDeps: ExtensionPushPrepareDeps,
  cache: ExtensionPackageCache,
  identity?: ClientIdentity,
): ExtensionQualityDeps {
  const denoRuntime = new EmbeddedDenoRuntime();
  return {
    pushPrepareDeps,
    cache,
    ensureDenoPath: () => denoRuntime.ensureDeno(),
    makeScoreDeps: (denoPath, options) =>
      createRubricScoreDeps(
        denoPath,
        extractTarGz,
        denoRuntime.getDenoEnv(),
        options?.isolated === true,
      ),
    privateSourceLookup: {
      loadCredentials: () => pushPrepareDeps.loadCredentials(),
      whoami: (serverUrl, apiKey, signal) =>
        new SwampClubClient(serverUrl, identity).whoami(apiKey, signal),
      getExtensionVisibility: async (serverUrl, name, apiKey, signal) => {
        const info = await new ExtensionApiClient(serverUrl, identity)
          .getExtension(name, apiKey, signal);
        if (!info) return null;
        // An answer without visibility cannot say which way a republish
        // goes, so the lookup counts as unanswered rather than public.
        if (typeof info.isPrivate !== "boolean") {
          throw new Error("Registry did not report the extension's visibility");
        }
        return { isPrivate: info.isPrivate };
      },
    },
  };
}

export const PRIVATE_SOURCE_LOOKUP_TIMEOUT_MS = 5_000;

/**
 * never throws or blocks past the timeout: any failure answers `unknown`, and
 * the factor is then scored on the repository URL alone.
 */
export async function resolvePrivateSourceStanding(
  ctx: LibSwampContext,
  deps: PrivateSourceLookupDeps,
  manifest: ExtensionManifest,
  timeoutMs = PRIVATE_SOURCE_LOOKUP_TIMEOUT_MS,
): Promise<PrivateSourceStanding> {
  const unknown: PrivateSourceStanding = { kind: "unknown" };
  try {
    const creds = await deps.loadCredentials();
    if (!creds) {
      ctx.logger.debug`Private source hosting not checked: no credentials`;
      return unknown;
    }
    const signal = AbortSignal.timeout(timeoutMs);
    const whoami = await deps.whoami(creds.serverUrl, creds.apiKey, signal);
    if (whoami.authenticated === false) {
      ctx.logger.debug`Private source hosting not checked: key rejected`;
      return unknown;
    }
    const collective = sourceHostingOf(whoami, collectiveOf(manifest.name));
    if (!collective) {
      ctx.logger
        .debug`Private source hosting not reported for ${manifest.name}`;
      return unknown;
    }
    if (!collective.privateSourceHosting) {
      return { kind: "not_attested", reason: "no_private_source_hosting" };
    }
    const existing = await deps.getExtensionVisibility(
      creds.serverUrl,
      manifest.name,
      creds.apiKey,
      signal,
    );
    return predictPublishedPrivate(
        existing,
        manifest.visibility,
        collective.privateNamespace,
      )
      ? { kind: "attested" }
      : { kind: "not_attested", reason: "public_extension" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger.debug`Private source hosting not checked: ${message}`;
    return unknown;
  }
}

/**
 * the bytes scored are the bytes a later `swamp extension push` would upload
 * from the same source.
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

      const cached = await deps.cache.get(hash);
      const cacheHit = cached !== null;
      if (cached) {
        ctx.logger
          .debug`Cache hit: reusing ${cached.archiveBytes.length} bytes`;
        yield { kind: "cache_hit", hash };
      } else {
        yield { kind: "packaging" };
      }

      // Push's own prepare path, so quality runs every gate push runs, on a
      // cache hit too. Local gate failures are collected rather than thrown,
      // so the rubric is still scored and printed beside them.
      let prepared: ExtensionPushPrepared;
      try {
        prepared = await extensionPushPrepare(
          ctx,
          deps.pushPrepareDeps,
          {
            ...input.prepareInput,
            dryRun: true,
            registryChecks: "skip",
            localGates: "collect",
            ...(cached
              ? {
                cachedArchive: cached.archiveBytes,
                cachedArchiveIndex: cached.metadata.archiveIndex,
              }
              : {}),
          },
        );
      } catch (error) {
        yield { kind: "error", error: error as SwampError };
        return;
      }
      const archiveBytes = prepared.archiveBytes;
      const findings: QualityFindings = {
        safetyWarnings: prepared.safetyWarnings,
        reviewRulesResult: prepared.reviewRulesResult,
        acceptances: prepared.acceptances,
        commentSites: prepared.commentSites,
      };

      // A cached archive means every gate passed; never cache one built
      // around a failure.
      if (!cacheHit && prepared.gateFailures.length === 0) {
        await deps.cache.put(hash, archiveBytes, {
          extensionName: input.prepareInput.manifest.name,
          extensionVersion: input.prepareInput.manifest.version,
          rubricVersion: RUBRIC_VERSION,
          archiveIndex: prepared.archiveIndex,
        });
        ctx.logger.debug`Cache put: ${archiveBytes.length} bytes at ${hash}`;
      }

      // The registry's scorer strips deno.json, so it cannot resolve a bare
      // import push ships and scores documentation 0; the local score does
      // likewise.
      const registryScorable = !prepared.reviewRulesResult.warnings.some((w) =>
        w.ruleId === "bare-specifiers"
      );

      yield { kind: "scoring" };
      const privateSource = await resolvePrivateSourceStanding(
        ctx,
        deps.privateSourceLookup,
        input.prepareInput.manifest,
      );
      const denoPath = await deps.ensureDenoPath();
      const scoreDeps = deps.makeScoreDeps(denoPath, {
        isolated: input.isolated === true,
      });
      const score = await scoreExtensionTarball(
        archiveBytes,
        input.prepareInput.manifest,
        scoreDeps,
        {
          dependencyTrustBlockerCount: dependencyTrustBlockerCount(
            prepared.dependencyTrustResult,
          ),
          dependencyNotAuditedCount: notAuditedCount(
            prepared.dependencyTrustResult,
          ),
          dependencyNotAuditedFixes: notAuditedFixes(
            prepared.dependencyTrustResult,
          ),
          dependencyLooseCount: looseSpecifierCount(
            prepared.dependencyTrustResult,
          ),
          // Acceptances are already applied: the warnings left are the
          // findings no comment or quality.yaml entry covers.
          secretSafeDocs: !prepared.reviewRulesResult.warnings.some((w) =>
            w.ruleId === "secret-unsafe-docs"
          ),
          privateSource,
          unpublishedSpecifiers: unpublishedSpecifiers(
            prepared.dependencyTrustResult,
          ),
        },
      );

      yield {
        kind: "completed",
        data: {
          score,
          license: input.prepareInput.manifest.license ?? null,
          licenseWarning: prepared.licenseWarning,
          cacheHash: hash,
          archiveSize: archiveBytes.length,
          cacheHit,
          dependencyTrustResult: prepared.dependencyTrustResult,
          findings,
          gateFailures: prepared.gateFailures,
          excludedFromArchive: prepared.excludedFromArchive,
          registryScorable,
        },
      };
    })(),
  );
}
