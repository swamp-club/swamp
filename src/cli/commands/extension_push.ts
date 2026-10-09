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

import { Command } from "@cliffy/command";
import { dirname, join } from "@std/path";
import {
  createContext,
  type GlobalOptions,
  resolveExtensionsDir,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import {
  findDenoConfig,
  findPackageJsonDir,
  projectConfigBoundary,
  resolveExtensionFiles,
} from "../resolve_extension_files.ts";
import { resolveManifestArgument } from "../resolve_manifest_path.ts";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import {
  REGISTRY_FORBIDDEN_CODE,
  REGISTRY_NOT_AUTHENTICATED_MESSAGE,
  REGISTRY_TOKEN_SCOPE_CODE,
} from "../../infrastructure/http/extension_api_client.ts";
import { VERSION } from "./version.ts";
import { sourceHasBareSpecifiers } from "../../domain/models/bundle.ts";
import { CalVer } from "../../domain/models/calver.ts";
import {
  computePackageCacheHash,
  defaultPackageCacheRoot,
  ExtensionPackageCache,
} from "../../domain/extensions/extension_package_cache.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import { createApiCallRecorder } from "../../infrastructure/http/recording_fetcher.ts";
import {
  createExtensionPromoteDeps,
  extensionPromote,
} from "../../libswamp/extensions/promote.ts";
import {
  createExtensionPushExecuteDeps,
  createExtensionPushPrepareDeps,
  extensionPush,
  extensionPushPrepare,
  type ExtensionPushPrepareDeps,
} from "../../libswamp/extensions/push.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import { registryChecksVerdict } from "../../domain/extensions/extension_publish_checks.ts";
import { resolvePublishVisibility } from "../../domain/extensions/extension_manifest.ts";
import { RUBRIC_VERSION } from "../../domain/extensions/extension_rubric_scorer.ts";
import {
  type AcceptedWarnings,
  createExtensionPushRenderer,
  renderExtensionPushCancelled,
  type WarningsWaiver,
} from "../../presentation/renderers/extension_push.ts";
import {
  bumpVersionPrompt,
  existingVersionChoicePrompt,
  finalPushPrompt,
} from "../../presentation/renderers/extension_push_prompts.ts";
import { createExtensionPromoteRenderer } from "../../presentation/renderers/extension_promote.ts";
import type { OutputMode } from "../../presentation/output/output.ts";
import type { SafetyIssue } from "../../domain/extensions/extension_safety_analyzer.ts";
import {
  checkVersionBumpWithoutUpgrade,
  checkVersionConsistency,
  type PublishedLookup,
  type QualityIssue,
} from "../../domain/extensions/extension_quality_checker.ts";
import type { DependencyTrustIssue } from "../../domain/extensions/extension_dependency_trust_checker.ts";
import type { ReviewFinding } from "../../domain/extensions/extension_review_rules.ts";
import type {
  CollectiveMismatch,
} from "../../domain/extensions/extension_collective_validator.ts";
import type { CompilationError } from "../../libswamp/extensions/push.ts";
import type { SwampError } from "../../libswamp/errors.ts";
import { loadIdentity } from "../load_identity.ts";
import { ReleaseChannel } from "../../domain/extensions/release_channel.ts";
import { promptConfirmation, promptNumberedChoice } from "../prompt_helpers.ts";
import {
  placeExistingVersion,
  promoteCommand,
} from "../../domain/extensions/extension_publish_checks.ts";
import {
  buildFindingsReport,
  withAcceptance,
} from "../../presentation/renderers/extension_findings_report.ts";

interface ExtensionPushOptions extends GlobalOptions {
  repoDir?: string;
  extensionsDir?: string;
  yes?: boolean;
  force?: boolean;
  dryRun?: boolean;
  releaseNotes?: string;
  channel?: string;
  visibility?: string;
  versionSuffix?: string;
  skipUpgradeCheck?: boolean;
}

/**
 * Names the flag that waives the warnings prompt on this run, or `undefined`
 * when neither was passed. `--yes` wins when both are given, so the summary
 * credits the flag users reach for.
 */
export function resolveWarningsWaiver(
  options: { yes?: boolean; force?: boolean },
): WarningsWaiver | undefined {
  if (options.yes) return "--yes";
  if (options.force) return "--force";
  return undefined;
}

/** What the warnings gate decided for this run. */
export type WarningsGateDecision =
  | {
    kind: "proceed";
    /**
     * The flag that waived the warnings. Absent when there were none, or
     * when the run proceeds without a waiver (dry run, `--json`).
     */
    waivedBy?: WarningsWaiver;
  }
  | { kind: "prompt" };

/**
 * Decides whether safety and review warnings prompt or pass a push.
 *
 * `--yes` and `--force` waive the warnings along with the push confirmation,
 * and the summary records what they waived. A dry run never prompts: it
 * performs no push and so has nothing to confirm. A `--json` run never
 * prompts either. Both proceed without a record, as they did before
 * swamp-club#3015 briefly made them refuse (restored by swamp-club#3047). A
 * log-mode run without a terminal reaches the prompt, whose own error says
 * to pass `--yes`.
 */
export function resolveWarningsGate(input: {
  warningCount: number;
  waiver: WarningsWaiver | undefined;
  dryRun: boolean;
  outputMode: OutputMode;
}): WarningsGateDecision {
  if (input.warningCount === 0) {
    return { kind: "proceed" };
  }
  if (input.waiver) {
    return { kind: "proceed", waivedBy: input.waiver };
  }
  if (input.dryRun || input.outputMode === "json") {
    return { kind: "proceed" };
  }
  return { kind: "prompt" };
}

/**
 * Looks up the extension's last-published version for the version-drift
 * check. Never throws: missing or rejected credentials and a failed lookup
 * each become their own outcome, so none is reported as a first publish.
 */
export async function lookupPublishedBaseline(
  deps: Pick<
    ExtensionPushPrepareDeps,
    "loadCredentials" | "getLatestVersionDetail"
  >,
  extensionName: string,
): Promise<PublishedLookup> {
  try {
    const creds = await deps.loadCredentials();
    if (!creds) return { kind: "no-credentials" };
    const latestDetail = await deps.getLatestVersionDetail(
      creds.serverUrl,
      extensionName,
      creds.apiKey,
    );
    if (!latestDetail) return { kind: "never-published" };
    return {
      kind: "found",
      state: {
        manifestVersion: latestDetail.version,
        models: (latestDetail.contentMetadata?.models ?? []).map((m) => ({
          fileName: m.fileName,
          version: m.version,
        })),
      },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return isRegistryAuthError(error)
      ? { kind: "authentication-failed", reason }
      : { kind: "registry-unavailable", reason };
  }
}

/** A 401 or 403 from the registry API: it refused the stored credentials. */
function isRegistryAuthError(error: unknown): boolean {
  if (!(error instanceof UserError)) return false;
  return error.message === REGISTRY_NOT_AUTHENTICATED_MESSAGE ||
    error.code === REGISTRY_FORBIDDEN_CODE ||
    error.code === REGISTRY_TOKEN_SCOPE_CODE;
}

/** How push answers a version that is already published. */
export type ExistingVersionResponse =
  /** Fail with the version-exists error; no prompt. */
  | { kind: "refuse"; message: string }
  /** Ask whether to bump (same or higher channel: promote is impossible). */
  | { kind: "bump-prompt" }
  /** Offer promote, bump or stop (the version is on a lower channel). */
  | { kind: "choose" };

/**
 * Decides how push answers a version that is already published.
 *
 * Only an interactive log run prompts, exactly as before swamp-club#2939:
 * `--json`, `--yes` and `--force` refuse, so `--yes` can never promote. A log
 * run without a terminal still reaches a prompt, whose own error says to
 * pass `--yes`. A refusal keeps the pre-#2939 message for a duplicate on the
 * requested channel; a version on another channel gets the check's message,
 * which names that channel and, when lower, the promote command.
 *
 * A yanked version is never offered for promotion, whatever channel it is
 * on: the registry refuses it. It gets the bump prompt, and a refusal uses
 * the check's message, which names the yank.
 */
export function resolveExistingVersionResponse(input: {
  extensionName: string;
  version: string;
  checkMessage: string;
  existingChannel?: string;
  requestedChannel?: string;
  existingYanked?: boolean;
  outputMode: OutputMode;
  yes?: boolean;
  force?: boolean;
}): ExistingVersionResponse {
  const placement = input.existingChannel && input.requestedChannel
    ? placeExistingVersion(input.existingChannel, input.requestedChannel)
    : "same-channel";
  if (input.outputMode !== "log" || input.yes || input.force) {
    return {
      kind: "refuse",
      message: placement === "same-channel" && !input.existingYanked
        ? `Version ${input.version} already exists for ${input.extensionName}. ` +
          `Use a different version or let the CLI bump it interactively.`
        : input.checkMessage,
    };
  }
  return placement === "lower-channel" && !input.existingYanked
    ? { kind: "choose" }
    : { kind: "bump-prompt" };
}

/**
 * Collects the warnings the gate covers into the record the summary prints
 * when they are accepted. Findings drop their report skeleton and their
 * remediation: `warnings.review` and `warnings.safety` already carry them,
 * and repeating them would bury the summary.
 */
export function buildAcceptedWarnings(prepared: {
  safetyWarnings: SafetyIssue[];
  reviewRulesResult: { warnings: ReviewFinding[] };
}): AcceptedWarnings {
  return {
    safety: prepared.safetyWarnings.map((w) => ({
      ruleId: w.ruleId,
      file: w.file,
      ...(w.line !== undefined ? { line: w.line } : {}),
      message: w.message,
    })),
    review: prepared.reviewRulesResult.warnings.map((w) => ({
      ruleId: w.ruleId,
      dimension: w.dimension,
      severity: w.severity,
      file: w.file,
      ...(w.line !== undefined ? { line: w.line } : {}),
      message: w.message,
    })),
  };
}

/**
 * Validates that node_modules/ exists alongside a package.json project.
 * Throws UserError with clear instructions if missing.
 */
async function requireNodeModules(projectDir: string): Promise<void> {
  const nodeModulesPath = join(projectDir, "node_modules");
  try {
    const stat = await Deno.stat(nodeModulesPath);
    if (!stat.isDirectory) {
      throw markErrorPaths(
        new UserError(
          `Expected node_modules/ to be a directory at ${nodeModulesPath}. ` +
            `Run 'npm install' or 'deno install' in ${projectDir} first.`,
        ),
        [nodeModulesPath, projectDir],
      );
    }
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw markErrorPaths(
      new UserError(
        `No node_modules/ found at ${projectDir}. ` +
          `Run 'npm install' or 'deno install' to install dependencies before pushing.`,
      ),
      [projectDir],
    );
  }
}

export const extensionPushCommand = new Command()
  .name("push")
  .description("Push an extension to the swamp registry")
  .example(
    "Publish extension",
    "swamp extension push extensions/models/my-model/manifest.json",
  )
  .example(
    "Dry run",
    "swamp extension push extensions/models/my-model/manifest.json --dry-run",
  )
  .example(
    "With release notes",
    `swamp extension push extensions/models/my-model/manifest.json --release-notes "Added validate method"`,
  )
  .arguments("<manifest-path:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--extensions-dir <dir:string>",
    "Extensions root: the directory that contains extensions/ (models, workflows and skills resolve from it; env: SWAMP_EXTENSIONS_DIR)",
  )
  .option(
    "-y, --yes",
    "Skip confirmation prompts; the summary records any warnings this waived",
  )
  .option("-f, --force", "Skip confirmation prompts (alias for --yes)")
  .option(
    "--dry-run",
    "Build the archive and run the registry checks read-only, without pushing",
  )
  .option(
    "--visibility <visibility:string>",
    "Publication visibility: public (registry default) or private; overrides manifest visibility. Omit to use the manifest or registry default.",
  )
  .option(
    "--release-notes <text:string>",
    "Per-version release notes (max 5000 chars)",
  )
  .option(
    "--channel <channel:string>",
    "Release channel: 'beta', 'rc', or 'stable' (default: stable)",
  )
  .option(
    "--version-suffix <type:string>",
    "Override version micro segment: 'epoch' uses Unix timestamp (e.g. 2026.06.18.1750263600)",
  )
  .option(
    "--skip-upgrade-check",
    "Suppress warning when version is bumped without upgrade entries",
  )
  .action(async function (options: ExtensionPushOptions, manifestPath: string) {
    const cliCtx = createContext(options, ["extension", "push"]);
    cliCtx.logger.debug`Starting extension push`;
    // The renderer exists before anything can throw, so a --json run always
    // leaves exactly one document on stdout: a render that ended the run
    // wrote it, or renderUnfinished writes it with status failed. Paths are
    // filled in once the repo and manifest directories are resolved.
    const renderPaths = {
      cwd: Deno.cwd(),
      repoDir: Deno.cwd(),
      manifestDir: Deno.cwd(),
    };
    const renderer = createExtensionPushRenderer(
      cliCtx.outputMode,
      renderPaths,
    );
    try {
      resolvePublishVisibility(undefined, options.visibility);
      if (
        options.channel !== undefined &&
        !ReleaseChannel.isValid(options.channel)
      ) {
        throw new UserError(
          `Invalid channel: "${options.channel}". Must be one of: beta, rc, stable.`,
        );
      }
      if (options.channel === "stable") {
        options.channel = undefined;
      }
      if (
        options.versionSuffix !== undefined &&
        options.versionSuffix !== "epoch"
      ) {
        throw new UserError(
          `Invalid version suffix: "${options.versionSuffix}". Must be "epoch".`,
        );
      }

      // 1. Validate repo
      const repoDir = resolveRepoDir(options.repoDir);
      const extensionsDir = resolveExtensionsDir(options.extensionsDir);
      const { absoluteManifestPath } = await resolveManifestArgument({
        argument: manifestPath,
        cwd: Deno.cwd(),
        repoDir,
        extensionsDir,
      });
      const { repoContext } = await requireInitializedRepoReadOnly({
        repoDir,
        outputMode: cliCtx.outputMode,
      });

      // 2. Resolve extension files (manifest, models, workflows, additional files)
      const resolved = await resolveExtensionFiles({
        repoDir,
        manifestPath: absoluteManifestPath,
        repoContext,
        logger: cliCtx.logger,
        extensionsDir,
      });
      const {
        manifest: sourceManifest,
        modelsDir,
        modelEntryPoints,
        allModelFiles,
        vaultsDir,
        vaultEntryPoints,
        allVaultFiles,
        datastoresDir,
        datastoreEntryPoints,
        allDatastoreFiles,
        reportsDir,
        reportEntryPoints,
        allReportFiles,
        webhooksDir,
        webhookEntryPoints,
        allWebhookFiles,
        workflowFiles,
        includeFilePaths,
        additionalFilePaths,
        binaryFilePaths,
      } = resolved;
      const manifest = {
        ...sourceManifest,
        visibility: resolvePublishVisibility(
          sourceManifest.visibility,
          options.visibility,
        ),
      };

      // 2a. Override version micro with epoch seconds when requested.
      if (options.versionSuffix === "epoch") {
        manifest.version = CalVer.withEpochMicro().value;
        cliCtx.logger
          .debug`Version overridden with epoch suffix: ${manifest.version}`;
      }

      // 2b. Detect project config for project-aware bundling and quality checks.
      // The walk up from the manifest stops at the extensions root, so a
      // manifest outside the repo never picks up a deno.json above it.
      const manifestDir = dirname(absoluteManifestPath);
      const configBoundary = projectConfigBoundary(
        manifestDir,
        resolved.extensionsRoot,
        repoDir,
      );
      const denoConfigPath = await findDenoConfig(manifestDir, configBoundary);
      let packageJsonDir: string | undefined;
      if (denoConfigPath) {
        cliCtx.logger.debug`Found deno.json at ${denoConfigPath}`;
      } else {
        const candidateDir = await findPackageJsonDir(
          manifestDir,
          configBoundary,
        );
        if (candidateDir) {
          const allEntryPoints = [
            ...modelEntryPoints,
            ...vaultEntryPoints,
            ...datastoreEntryPoints,
            ...reportEntryPoints,
            ...webhookEntryPoints,
          ];
          let hasBare = false;
          for (const ep of allEntryPoints) {
            const src = await Deno.readTextFile(ep);
            if (sourceHasBareSpecifiers(src)) {
              hasBare = true;
              break;
            }
          }
          if (hasBare) {
            packageJsonDir = candidateDir;
            cliCtx.logger
              .debug`Found package.json project at ${packageJsonDir}`;
            await requireNodeModules(packageJsonDir);
          } else {
            cliCtx.logger
              .debug`Ignoring package.json at ${candidateDir} (extension uses npm: prefixed imports)`;
          }
        }
      }

      // 3. Create libswamp context and deps
      const ctx = createLibSwampContext({ logger: cliCtx.logger });
      const identity = await loadIdentity();
      // Every HTTP call made before the upload is recorded so the dry-run
      // summary can list the calls actually made.
      const apiCalls = createApiCallRecorder();
      const prepareDeps = createExtensionPushPrepareDeps(identity, {
        recorder: apiCalls,
      });
      // Printed paths open from where the author ran the command, now that
      // the repo and manifest directories are known.
      renderPaths.repoDir = repoDir;
      renderPaths.manifestDir = manifestDir;
      const registryChecks = options.dryRun ? "collect" : "enforce";
      const cache = new ExtensionPackageCache(
        defaultPackageCacheRoot(repoDir),
        VERSION,
      );

      // 3b. Opportunistic package cache lookup — if a prior `swamp
      // extension quality` run packaged the same source, reuse those
      // bytes. Cache miss falls back to packaging from scratch.
      const cacheHashInput = {
        manifest,
        rootDir: resolved.extensionsRoot,
        manifestDir,
        modelFilePaths: allModelFiles,
        vaultFilePaths: allVaultFiles,
        datastoreFilePaths: allDatastoreFiles,
        reportFilePaths: allReportFiles,
        webhookFilePaths: allWebhookFiles,
        workflowFilePaths: workflowFiles.map((w) => w.sourcePath),
        additionalFilePaths,
        binaryFilePaths,
        skillFilePaths: resolved.allSkillFiles,
        includeFilePaths,
        denoConfigPath,
        packageJsonPath: undefined,
      };
      const cacheHash = await computePackageCacheHash(cacheHashInput);
      const cached = await cache.get(cacheHash);
      if (cached) {
        cliCtx.logger
          .debug`Reusing cached package ${
          cacheHash.slice(0, 12)
        } (${cached.archiveBytes.length} bytes)`;
      }

      // 4. Run prepare phase
      let prepared;
      try {
        prepared = await extensionPushPrepare(ctx, prepareDeps, {
          manifest,
          repoDir,
          manifestDir,
          modelsDir,
          allModelFiles,
          modelEntryPoints,
          vaultsDir,
          allVaultFiles,
          vaultEntryPoints,
          datastoresDir,
          allDatastoreFiles,
          datastoreEntryPoints,
          reportsDir,
          allReportFiles,
          reportEntryPoints,
          webhooksDir,
          allWebhookFiles,
          webhookEntryPoints,
          workflowFiles,
          skillDirs: resolved.skillDirs,
          allSkillFiles: resolved.allSkillFiles,
          includeFilePaths,
          additionalFilePaths,
          binaryFilePaths,
          dryRun: options.dryRun ?? false,
          registryChecks,
          channel: options.channel,
          releaseNotes: options.releaseNotes,
          denoConfigPath,
          packageJsonDir,
          contentHash: cacheHash,
          cachedArchive: cached?.archiveBytes,
        });
      } catch (error) {
        // Handle structured errors from the prepare phase with rich rendering
        if (isSwampError(error)) {
          const details = error.details as Record<string, unknown> | undefined;
          if (details?.dependencyTrustErrors) {
            renderer.renderDependencyTrustErrors(
              details.dependencyTrustErrors as DependencyTrustIssue[],
            );
          } else if (details?.reviewRuleErrors) {
            renderer.renderReviewRuleErrors(
              details.reviewRuleErrors as ReviewFinding[],
            );
          } else if (details?.safetyErrors) {
            renderer.renderSafetyErrors(
              details.safetyErrors as SafetyIssue[],
            );
          } else if (details?.upgradeChainErrors) {
            renderer.renderUpgradeChainErrors(
              details.upgradeChainErrors as QualityIssue[],
            );
          } else if (details?.qualityErrors) {
            renderer.renderQualityErrors(
              details.qualityErrors as QualityIssue[],
            );
          } else if (details?.compilationErrors) {
            renderer.renderCompilationErrors(
              details.compilationErrors as CompilationError[],
            );
          } else if (details?.expectedCollective && details?.mismatches) {
            renderer.renderCollectiveErrors(
              details.expectedCollective as string,
              details.mismatches as CollectiveMismatch[],
            );
          } else if (details?.existingVersion) {
            // Version already exists — promote, bump or stop interactively
            const existingVersion = details.existingVersion as string;
            const requestedChannel = (details.requestedChannel as
              | string
              | undefined) ?? options.channel ?? "stable";
            const existingChannel =
              (details.existingChannel as string | undefined) ??
                requestedChannel;
            const existingYanked = details.existingYanked === true;
            const response = resolveExistingVersionResponse({
              extensionName: manifest.name,
              version: existingVersion,
              checkMessage: error.message,
              existingChannel,
              requestedChannel,
              existingYanked,
              outputMode: cliCtx.outputMode,
              yes: options.yes,
              force: options.force,
            });
            if (response.kind === "refuse") {
              throw new UserError(response.message);
            }
            const bumped = CalVer.bump(CalVer.create(existingVersion));
            const promptInput = {
              name: manifest.name,
              version: existingVersion,
              bumpedVersion: bumped.value,
              existingChannel,
              requestedChannel,
            };
            let action: "promote" | "bump" | "stop";
            if (response.kind === "choose") {
              const prompt = existingVersionChoicePrompt(promptInput);
              const index = await promptNumberedChoice(
                prompt.details,
                prompt.choices.map((c) => c.label),
              );
              action = index === null ? "stop" : prompt.choices[index].action;
            } else {
              const prompt = bumpVersionPrompt({
                ...promptInput,
                ...(existingYanked
                  ? {
                    yank: {
                      reason: details.existingYankReason as string | undefined,
                    },
                  }
                  : {}),
              });
              action = await promptConfirmation(prompt.question, prompt.details)
                ? "bump"
                : "stop";
            }
            if (action === "promote") {
              const command = promoteCommand(
                manifest.name,
                existingVersion,
                requestedChannel,
              );
              cliCtx.logger.info`Running: ${command}`;
              await consumeStream(
                extensionPromote(ctx, createExtensionPromoteDeps(identity), {
                  extensionName: manifest.name,
                  version: existingVersion,
                  toChannel: requestedChannel,
                  fromChannel: existingChannel,
                }),
                createExtensionPromoteRenderer(cliCtx.outputMode).handlers(),
              );
              return;
            }
            if (action === "bump") {
              manifest.version = bumped.value;
              // The version is part of the content hash, so bumping it
              // changes the hash and therefore the review-report path.
              const bumpedHash = await computePackageCacheHash(cacheHashInput);
              // Re-run prepare with bumped version
              try {
                prepared = await extensionPushPrepare(ctx, prepareDeps, {
                  manifest,
                  repoDir,
                  manifestDir,
                  modelsDir,
                  allModelFiles,
                  modelEntryPoints,
                  vaultsDir,
                  allVaultFiles,
                  vaultEntryPoints,
                  datastoresDir,
                  allDatastoreFiles,
                  datastoreEntryPoints,
                  reportsDir,
                  allReportFiles,
                  reportEntryPoints,
                  webhooksDir,
                  allWebhookFiles,
                  webhookEntryPoints,
                  workflowFiles,
                  skillDirs: resolved.skillDirs,
                  allSkillFiles: resolved.allSkillFiles,
                  includeFilePaths,
                  additionalFilePaths,
                  binaryFilePaths,
                  dryRun: options.dryRun ?? false,
                  registryChecks,
                  channel: options.channel,
                  releaseNotes: options.releaseNotes,
                  denoConfigPath,
                  packageJsonDir,
                  contentHash: bumpedHash,
                });
              } catch (retryError) {
                if (isSwampError(retryError)) {
                  throw new UserError(retryError.message);
                }
                throw retryError;
              }
            } else {
              renderExtensionPushCancelled(cliCtx.outputMode);
              return;
            }
          }
          if (!prepared) {
            throw new UserError(error.message);
          }
        } else {
          throw error;
        }
      }

      // 4b. Populate the package cache on a miss. Writing here lets a
      // subsequent `swamp extension quality` run against the same source
      // reuse these bytes without repackaging.
      if (!cached) {
        try {
          await cache.put(cacheHash, prepared.archiveBytes, {
            extensionName: prepared.manifest.name,
            extensionVersion: prepared.manifest.version,
            rubricVersion: RUBRIC_VERSION,
          });
        } catch (cacheError) {
          cliCtx.logger
            .debug`Failed to write package cache (continuing): ${cacheError}`;
        }
      }

      // 5. Render resolved data
      renderer.renderResolved(prepared.resolvedData);

      // 6. Handle dependency trust warnings
      if (prepared.dependencyTrustResult.warnings.length > 0) {
        renderer.renderDependencyTrustWarnings(
          prepared.dependencyTrustResult.warnings,
        );
      }

      // 6a. Handle review-rule warnings
      if (prepared.reviewRulesResult.warnings.length > 0) {
        renderer.renderReviewRuleWarnings(
          withAcceptance(
            prepared.reviewRulesResult.warnings,
            manifestDir,
            prepared.commentSites,
          ),
        );
      }

      // 6b. Handle safety warnings
      if (prepared.safetyWarnings.length > 0) {
        renderer.renderSafetyWarnings(
          withAcceptance(
            prepared.safetyWarnings,
            manifestDir,
            prepared.commentSites,
          ),
        );
      }

      // 6c. One gate covers safety and review-rule warnings, so the user is
      // never prompted twice. --yes and --force waive them along with the push
      // confirmation, and the summary records what was waived. A dry run has
      // nothing to confirm and a --json run never prompts, so neither stops
      // here; the warnings were rendered above either way.
      const gatedWarnings = buildAcceptedWarnings(prepared);
      const gate = resolveWarningsGate({
        warningCount: gatedWarnings.safety.length + gatedWarnings.review.length,
        waiver: resolveWarningsWaiver(options),
        dryRun: prepared.isDryRun,
        outputMode: cliCtx.outputMode,
      });
      if (gate.kind === "prompt") {
        const confirmed = await promptConfirmation(
          "Continue with push despite warnings?",
        );
        if (!confirmed) {
          renderExtensionPushCancelled(cliCtx.outputMode);
          return;
        }
      }
      const accepted = gate.kind === "proceed" && gate.waivedBy
        ? { warnings: gatedWarnings, waivedBy: gate.waivedBy }
        : undefined;
      // The closing report is built from the gated warnings themselves, not
      // the waiver record, so a dry run, a --json run and an interactive "y"
      // all get the same advice.
      const report = buildFindingsReport(
        {
          safetyWarnings: prepared.safetyWarnings,
          reviewWarnings: prepared.reviewRulesResult.warnings,
          acceptances: prepared.acceptances,
          commentSites: prepared.commentSites,
        },
        manifestDir,
      );

      // 6d. Version-drift check (advisory warning only)
      // Look up the last-published version in the registry to compare model
      // versions. Best-effort — when there is nothing to compare against, the
      // warning says why: never published, no credentials, rejected
      // credentials, or a failed lookup.
      const baseline = await lookupPublishedBaseline(
        prepareDeps,
        manifest.name,
      );
      if (
        baseline.kind === "authentication-failed" ||
        baseline.kind === "registry-unavailable"
      ) {
        cliCtx.logger
          .debug`Failed to fetch published version for drift check (continuing): ${baseline.reason}`;
      }

      const versionIssues = await checkVersionConsistency(
        prepared.manifest.version,
        allModelFiles,
        baseline,
      );
      if (versionIssues.length > 0) {
        renderer.renderVersionDriftWarnings(versionIssues);
      }

      // 6e. Version-bump-without-upgrade check — warn when the extension
      // version changed from the published baseline but model files lack
      // an upgrades array. Skipped when --skip-upgrade-check is passed,
      // when there is no published version, or when the version has not
      // changed.
      if (
        !options.skipUpgradeCheck &&
        baseline.kind === "found" &&
        baseline.state.manifestVersion !== prepared.manifest.version
      ) {
        const upgradeWarnings = await checkVersionBumpWithoutUpgrade(
          allModelFiles,
        );
        if (upgradeWarnings.length > 0) {
          renderer.renderVersionBumpUpgradeWarnings(upgradeWarnings);
        }
      }

      // 7. Dry run — report and stop. A failed registry check, or one the
      // registry did not answer, exits non-zero with the message the real push
      // would have failed with; no bump prompt, since a dry run never prompts.
      if (prepared.isDryRun) {
        renderer.renderDryRun({
          name: prepared.manifest.name,
          version: prepared.manifest.version,
          archiveSize: prepared.archiveBytes.length,
          visibility: prepared.resolvedData.visibility,
          contentHash: prepared.contentHash,
          registryChecks: prepared.registryChecks,
          apiCalls: apiCalls.calls,
          accepted,
          report,
        });
        const verdict = registryChecksVerdict(prepared.registryChecks);
        if (!verdict.ok) {
          throw new UserError(verdict.message);
        }
        return;
      }

      // 8. Confirmation prompt
      if (!options.yes && !options.force && cliCtx.outputMode === "log") {
        const prompt = finalPushPrompt({
          name: prepared.manifest.name,
          version: prepared.manifest.version,
          channel: options.channel ?? "stable",
        });
        const confirmed = await promptConfirmation(
          prompt.question,
          prompt.details,
        );
        if (!confirmed) {
          renderExtensionPushCancelled(cliCtx.outputMode);
          return;
        }
      }

      // 9. Execute push
      const executeDeps = createExtensionPushExecuteDeps(identity);
      await consumeStream(
        extensionPush(ctx, executeDeps, {
          manifest: prepared.manifest,
          archiveBytes: prepared.archiveBytes,
          contentMetadata: prepared.contentMetadata,
          counts: prepared.counts,
          releaseNotes: options.releaseNotes,
          channel: options.channel,
          collectiveEntitlement: prepared.collectiveEntitlement,
        }),
        renderer.handlers({ accepted, report }),
      );

      cliCtx.logger.debug("Extension push command completed");
    } catch (error) {
      renderer.renderUnfinished();
      throw error;
    }
  });

function isSwampError(
  error: unknown,
): error is SwampError {
  return typeof error === "object" && error !== null && "code" in error &&
    "message" in error;
}
