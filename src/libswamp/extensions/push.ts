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

import { basename, dirname, extname, join, relative } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { createTarGz } from "../../infrastructure/archive/tar_archive.ts";
import {
  formatArchiveBytes,
  MAX_EXTENSION_ARCHIVE_BYTES,
} from "../../domain/extensions/extension_archive_limits.ts";
import { extractBareSpecifierNames } from "../../domain/models/bundle.ts";
import { validateContentCollectives } from "../../domain/extensions/extension_collective_validator.ts";
import type {
  ExtensionContentMetadata,
  ExtractedArgument,
} from "../../domain/extensions/extension_content.ts";
import {
  ALLOWED_EXTENSIONS,
  LEGAL_BASENAMES,
  type SafetyCheckResult,
  type SafetyIssue,
} from "../../domain/extensions/extension_safety_analyzer.ts";
import type { QualityCheckResult } from "../../domain/extensions/extension_quality_checker.ts";
import type { DependencySpecifier } from "../../domain/extensions/extension_dependency_extractor.ts";
import type { DependencyTrustResult } from "../../domain/extensions/extension_dependency_trust_checker.ts";
import type {
  ExtensionContentKind,
  ExtensionReviewInput,
  ReviewFileRef,
  ReviewRulesResult,
} from "../../domain/extensions/extension_review_rules.ts";
import {
  applicableDimensions,
  buildReviewReportSkeleton,
  reviewReportPath,
} from "../../domain/extensions/extension_review_rules.ts";
import {
  type ExtensionManifest,
  type PublishVisibility,
  resolvePublishVisibility,
} from "../../domain/extensions/extension_manifest.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notAuthenticated, validationFailed } from "../errors.ts";
import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import { validateExtensionSkills } from "../../domain/extensions/extension_skill_validator.ts";
import {
  type CollectiveEntitlement,
  collectiveOf,
  evaluateCollectiveMembership,
  evaluatePrivateEntitlement,
  evaluateVersionExists,
  explainPrivatePublishRefusal,
  type PublishedVersion,
  registryCheckNotRun,
  type RegistryCheckResult,
  type RegistryChecksMode,
} from "../../domain/extensions/extension_publish_checks.ts";
import { UserError } from "../../domain/errors.ts";

// ── Data types ────────────────────────────────────────────────────────

/** A model entry enriched with extracted metadata for the resolved display. */
export interface ResolvedModelEntry {
  type: string;
  fileName: string;
  globalArguments?: ExtractedArgument[];
}

/** A vault entry enriched with extracted metadata for the resolved display. */
export interface ResolvedVaultEntry {
  type: string;
  fileName: string;
  name?: string;
  hasConfigSchema?: boolean;
  configFields?: ExtractedArgument[];
}

/** A datastore entry enriched with extracted metadata for the resolved display. */
export interface ResolvedDatastoreEntry {
  type: string;
  fileName: string;
  name?: string;
  hasConfigSchema?: boolean;
  configFields?: ExtractedArgument[];
}

/** A report entry enriched with extracted metadata for the resolved display. */
export interface ResolvedReportEntry {
  name: string;
  fileName: string;
  description?: string;
  scope?: string;
  labels?: string[];
}

/** A webhook entry enriched with extracted metadata for the resolved display. */
export interface ResolvedWebhookEntry {
  type: string;
  fileName: string;
  name?: string;
  description?: string;
}

/** Data for showing resolved extension contents before push. */
export interface ExtensionPushResolvedData {
  name: string;
  version: string;
  /** Requested intent, not a prediction of registry authorization or defaults. */
  visibility: PublishVisibility | "default";
  description: string | undefined;
  repository: string | undefined;
  releaseNotes: string | undefined;
  models: ResolvedModelEntry[];
  workflowFiles: string[];
  vaults: ResolvedVaultEntry[];
  datastores: ResolvedDatastoreEntry[];
  reports: ResolvedReportEntry[];
  webhooks: ResolvedWebhookEntry[];
  skills: Array<{ name: string; fileCount: number }>;
  additionalFiles: string[];
  platforms: string[];
  labels: string[];
  dependencies: string[];
}

/** Data for successful push output. */
export interface ExtensionPushSuccessData {
  name: string;
  version: string;
  extensionId: string;
  archiveSize: number;
  modelCount: number;
  workflowCount: number;
  bundleCount: number;
  vaultCount: number;
  datastoreCount: number;
  reportCount: number;
  webhookCount: number;
  skillCount: number;
  channel: string;
  visibility: "public" | "private";
}

/** Data for compilation error output. */
export interface CompilationError {
  file: string;
  error: string;
}

// ── Prepare types ─────────────────────────────────────────────────────

/** Input for the extension push prepare phase. */
export interface ExtensionPushPrepareInput {
  manifest: ExtensionManifest;
  repoDir: string;
  modelsDir: string;
  allModelFiles: string[];
  modelEntryPoints: string[];
  vaultsDir: string;
  allVaultFiles: string[];
  vaultEntryPoints: string[];
  datastoresDir: string;
  allDatastoreFiles: string[];
  datastoreEntryPoints: string[];
  reportsDir: string;
  allReportFiles: string[];
  reportEntryPoints: string[];
  webhooksDir: string;
  allWebhookFiles: string[];
  webhookEntryPoints: string[];
  workflowFiles: Array<{ sourcePath: string; archiveName: string }>;
  skillDirs: Array<{ name: string; absolutePath: string }>;
  allSkillFiles: string[];
  includeFilePaths: string[];
  additionalFilePaths: string[];
  binaryFilePaths: string[];
  dryRun: boolean;
  /**
   * What to do with the registry-side checks (authentication, collective
   * membership, reserved collective, version exists): a real push enforces
   * them, a dry run collects their verdicts, packaging-only callers skip
   * them and never contact the registry.
   */
  registryChecks: RegistryChecksMode;
  releaseNotes?: string;
  denoConfigPath?: string;
  packageJsonDir?: string;
  /**
   * Content hash of the resolved source tree (the package cache hash). When
   * provided, push verifies a content-hash-bound adversarial-review report.
   * Omitted by non-push callers (e.g. quality packaging).
   */
  contentHash?: string;
  /**
   * If provided, reuse these archive bytes instead of bundling and
   * tarring from source. Callers supply this when a prior
   * `swamp extension quality` run left a cached tarball whose source
   * hash matches the current tree — letting push skip the expensive
   * bundling step. The caller is responsible for validating that the
   * cache key corresponds to the current source state.
   */
  cachedArchive?: Uint8Array;
}

/** Result of the prepare phase, containing everything needed for push. */
export interface ExtensionPushPrepared {
  resolvedData: ExtensionPushResolvedData;
  safetyWarnings: SafetyIssue[];
  dependencyTrustResult: DependencyTrustResult;
  reviewRulesResult: ReviewRulesResult;
  archiveBytes: Uint8Array;
  manifest: ExtensionManifest;
  contentMetadata: ExtensionContentMetadata | undefined;
  counts: ExtensionPushCounts;
  isDryRun: boolean;
  /**
   * The registry checks' verdicts. Empty when the checks were skipped; in
   * `enforce` mode every entry passed, since a failure throws instead.
   */
  registryChecks: RegistryCheckResult[];
  /** The content hash the review report is keyed by, when the caller computed one. */
  contentHash: string | undefined;
  /**
   * What the registry reported the extension's collective entitles the
   * caller to, from the sign-in whoami call. Undefined when the registry sent
   * no entitlement or the checks were skipped. Held in memory for the push
   * that follows and never written to disk: entitlement is the registry's to
   * decide, and a cached plan would make a confidently wrong message.
   */
  collectiveEntitlement: CollectiveEntitlement | undefined;
}

/** Content counts for the extension. */
export interface ExtensionPushCounts {
  models: number;
  workflows: number;
  bundles: number;
  vaults: number;
  datastores: number;
  reports: number;
  webhooks: number;
  skills: number;
}

// ── Push (execute) types ──────────────────────────────────────────────

/** Input for the extension push execute phase. */
export interface ExtensionPushExecuteInput {
  manifest: ExtensionManifest;
  archiveBytes: Uint8Array;
  contentMetadata: ExtensionContentMetadata | undefined;
  counts: ExtensionPushCounts;
  releaseNotes?: string;
  channel?: string;
  /**
   * The collective's entitlement as the prepare phase resolved it, so a
   * refused private publication can say what the registry had reported.
   */
  collectiveEntitlement?: CollectiveEntitlement;
}

export type ExtensionPushEvent =
  | { kind: "pushing"; phase: "initiate" | "upload" | "confirm" }
  | { kind: "completed"; data: ExtensionPushSuccessData }
  | { kind: "error"; error: SwampError };

// ── Dependencies ──────────────────────────────────────────────────────

/**
 * The caller's collectives and what each entitles them to, from one whoami
 * call. `collectives` is undefined when the registry sent no organizations;
 * `entitlements` when it sent no entitlement (an older server), which the
 * private-entitlement check reports as undecided.
 */
export interface CollectiveLookup {
  collectives: string[] | undefined;
  entitlements: CollectiveEntitlement[] | undefined;
}

/** Dependencies for the extension push prepare phase. */
export interface ExtensionPushPrepareDeps {
  loadCredentials: () => Promise<
    { serverUrl: string; apiKey: string; username: string } | null
  >;
  fetchCollectives: (
    serverUrl: string,
    apiKey: string,
  ) => Promise<CollectiveLookup>;
  extractContentMetadata: (
    modelFiles: string[],
    modelsDir: string,
    workflowFiles: Array<{ sourcePath: string; archiveName: string }>,
    vaultFiles: string[],
    vaultsDir: string,
    datastoreFiles: string[],
    datastoresDir: string,
    reportFiles: string[],
    reportsDir: string,
    webhookFiles: string[],
    webhooksDir: string,
  ) => Promise<ExtensionContentMetadata>;
  analyzeExtensionSafety: (
    files: string[],
    exemptFromExtensionCheck?: Set<string>,
  ) => Promise<SafetyCheckResult>;
  checkExtensionQuality: (
    files: string[],
    denoPath: string,
    denoConfigPath?: string,
    denoEnv?: Record<string, string>,
  ) => Promise<QualityCheckResult>;
  bundleEntryPoint: (
    entryPoint: string,
    denoPath: string,
    options?: {
      denoConfigPath?: string;
      packageJsonDir?: string;
      env?: Record<string, string>;
    },
  ) => Promise<string>;
  extractDependencySpecifiers: (
    sourceFiles: string[],
  ) => Promise<DependencySpecifier[]>;
  checkDependencyTrust: (
    specifiers: DependencySpecifier[],
  ) => Promise<DependencyTrustResult>;
  checkReviewRules: (
    input: ExtensionReviewInput,
  ) => Promise<ReviewRulesResult>;
  ensureDenoPath: () => Promise<string>;
  getDenoEnv: () => Record<string, string>;
  /**
   * Finds a published version of the extension on any release channel.
   * Resolves null when no channel carries that version.
   */
  findPublishedVersion: (
    serverUrl: string,
    name: string,
    version: string,
    apiKey: string,
  ) => Promise<PublishedVersion | null>;
  getLatestVersionDetail: (
    serverUrl: string,
    name: string,
    apiKey: string,
  ) => Promise<LatestVersionDetail | null>;
}

/** Metadata sent during push phases. */
export interface ExtensionPushMetadata {
  name: string;
  version: string;
  description: string;
  dependencies: string[];
  platforms: string[];
  labels: string[];
  repository?: string;
  releaseNotes?: string;
  binaries?: string[];
  channel?: string;
  /** Public/default selection is represented by omission on the wire. */
  visibility?: "private";
  contentMetadata?: ExtensionContentMetadata;
}

/** Dependencies for the extension push execute phase. */
export interface ExtensionPushExecuteDeps {
  loadCredentials: () => Promise<
    { serverUrl: string; apiKey: string } | null
  >;
  initiatePush: (
    serverUrl: string,
    metadata: ExtensionPushMetadata,
    apiKey: string,
  ) => Promise<{ uploadUrl: string }>;
  uploadArchive: (
    uploadUrl: string,
    archiveBytes: Uint8Array,
  ) => Promise<void>;
  confirmPush: (
    serverUrl: string,
    metadata: ExtensionPushMetadata,
    apiKey: string,
  ) => Promise<{
    name: string;
    version: string;
    extensionId: string;
    visibility?: "public" | "private";
  }>;
  getExtensionVisibility: (
    serverUrl: string,
    name: string,
    apiKey: string,
  ) => Promise<{ isPrivate: boolean } | null>;
}

// ── Deps factory ──────────────────────────────────────────────────────

import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import {
  getCollectives,
  SwampClubClient,
} from "../../infrastructure/http/swamp_club_client.ts";
import { entitlementsOf } from "../auth/whoami.ts";
import {
  ExtensionApiClient,
  type LatestVersionDetail,
  REGISTRY_FORBIDDEN_CODE,
} from "../../infrastructure/http/extension_api_client.ts";
import type { ClientIdentity } from "../../infrastructure/http/client_identity.ts";
import { analyzeExtensionSafety } from "../../domain/extensions/extension_safety_analyzer.ts";
import {
  checkExtensionQuality,
  checkUpgradeChainConsistency,
} from "../../domain/extensions/extension_quality_checker.ts";
import { extractDependencySpecifiers } from "../../domain/extensions/extension_dependency_extractor.ts";
import { checkDependencyTrust } from "../../domain/extensions/extension_dependency_trust_checker.ts";
import { checkReviewRules as checkReviewRulesImpl } from "../../domain/extensions/extension_review_rules.ts";
import { bundleExtension } from "../../domain/models/bundle.ts";
import { extractContentMetadata } from "../../domain/extensions/extension_content_extractor.ts";
import { EmbeddedDenoRuntime } from "../../infrastructure/runtime/embedded_deno_runtime.ts";
import { DEFAULT_SWAMP_CLUB_URL } from "../../domain/auth/auth_credentials.ts";
import {
  type ApiCallRecorder,
  type Fetcher,
  recordingFetcher,
} from "../../infrastructure/http/recording_fetcher.ts";

function resolveServerUrl(): string {
  return Deno.env.get("SWAMP_CLUB_URL") ?? DEFAULT_SWAMP_CLUB_URL;
}

/** Options for the prepare deps factory. */
export interface ExtensionPushPrepareDepsOptions {
  /**
   * Receives every HTTP call the prepare phase makes (registry, OSV, npm),
   * so the summary can list the calls actually made.
   */
  recorder?: ApiCallRecorder;
  /** The fetch to make calls with; tests pass a fake. Defaults to global fetch. */
  fetch?: Fetcher;
}

/** Release channels a version may be published on. */
const ALL_RELEASE_CHANNELS = ["stable", "rc", "beta"];
const VERSIONS_PAGE_SIZE = 100;
const VERSIONS_MAX_PAGES = 50;

/** Wires real infrastructure into ExtensionPushPrepareDeps. */
export function createExtensionPushPrepareDeps(
  identity?: ClientIdentity,
  options: ExtensionPushPrepareDepsOptions = {},
): ExtensionPushPrepareDeps {
  const authRepo = new AuthRepository();
  const denoRuntime = new EmbeddedDenoRuntime();
  const fetcherFor = (registryUrl: string): Fetcher | undefined =>
    options.recorder
      ? recordingFetcher(options.recorder, registryUrl, options.fetch)
      : options.fetch;

  return {
    loadCredentials: async () => {
      const creds = await authRepo.load();
      if (!creds) return null;
      return {
        serverUrl: creds.serverUrl ?? resolveServerUrl(),
        apiKey: creds.apiKey,
        username: creds.username,
      };
    },
    fetchCollectives: async (serverUrl, apiKey) => {
      const client = new SwampClubClient(serverUrl, identity, {
        fetch: fetcherFor(serverUrl),
      });
      const whoami = await client.whoami(apiKey);
      // whoami answers a rejected key with its own 401 body rather than an
      // error, so a stale key fails authentication here instead of passing
      // the collective check on the username and failing at upload.
      if (whoami.authenticated === false) {
        throw notAuthenticated();
      }
      // Membership and entitlement come from the same answer, read from
      // their own fields: organizations authorizes the namespace,
      // collectiveEntitlements only ever explains a refusal.
      return {
        collectives: getCollectives(whoami),
        entitlements: entitlementsOf(whoami),
      };
    },
    extractContentMetadata,
    analyzeExtensionSafety,
    checkExtensionQuality,
    extractDependencySpecifiers,
    checkDependencyTrust: (specifiers) =>
      checkDependencyTrust(
        specifiers,
        fetcherFor(resolveServerUrl()) ?? globalThis.fetch,
      ),
    checkReviewRules: checkReviewRulesImpl,
    bundleEntryPoint: bundleExtension,
    ensureDenoPath: () => denoRuntime.ensureDeno(),
    getDenoEnv: () => denoRuntime.getDenoEnv(),
    findPublishedVersion: async (serverUrl, name, version, apiKey) => {
      const client = new ExtensionApiClient(serverUrl, identity, {
        fetch: fetcherFor(serverUrl),
      });
      // A version is unique per extension across channels, so every channel
      // is asked and the first match on any of them answers.
      for (let page = 1; page <= VERSIONS_MAX_PAGES; page++) {
        const listed = await client.listVersions(name, {
          channel: ALL_RELEASE_CHANNELS,
          perPage: VERSIONS_PAGE_SIZE,
          page,
        }, apiKey);
        const match = listed.versions.find((v) => v.version === version);
        if (match) return { version: match.version, channel: match.channel };
        // A short page is the last page; so is reaching the total. A
        // response without usable paging metadata is not paged further.
        const perPage = listed.meta?.perPage;
        const total = listed.meta?.total;
        const seen = (page - 1) * perPage + listed.versions.length;
        if (
          listed.versions.length === 0 || !Number.isFinite(seen) ||
          listed.versions.length < perPage || seen >= total
        ) {
          return null;
        }
      }
      return null;
    },
    getLatestVersionDetail: async (serverUrl, name, apiKey) => {
      const client = new ExtensionApiClient(serverUrl, identity, {
        fetch: fetcherFor(serverUrl),
      });
      return await client.getLatestVersionDetail(name, apiKey);
    },
  };
}

/** Wires real infrastructure into ExtensionPushExecuteDeps. */
export function createExtensionPushExecuteDeps(
  identity?: ClientIdentity,
): ExtensionPushExecuteDeps {
  const authRepo = new AuthRepository();

  return {
    loadCredentials: async () => {
      const creds = await authRepo.load();
      if (!creds) return null;
      return {
        serverUrl: creds.serverUrl ?? resolveServerUrl(),
        apiKey: creds.apiKey,
      };
    },
    initiatePush: async (serverUrl, metadata, apiKey) => {
      const client = new ExtensionApiClient(serverUrl, identity);
      const result = await client.initiatePush(metadata, apiKey);
      return { uploadUrl: result.uploadUrl };
    },
    uploadArchive: async (uploadUrl, archiveBytes) => {
      // No identity here — uploadArchive bypasses the client's fetch
      // wrapper and PUTs directly to a presigned S3 URL. Sending
      // identity headers to S3 breaks the presigned signature and
      // would leak the bearer token to S3 access logs.
      const client = new ExtensionApiClient("");
      await client.uploadArchive(uploadUrl, archiveBytes);
    },
    confirmPush: async (serverUrl, metadata, apiKey) => {
      const client = new ExtensionApiClient(serverUrl, identity);
      return await client.confirmPush(metadata, apiKey);
    },
    getExtensionVisibility: async (serverUrl, name, apiKey) => {
      const client = new ExtensionApiClient(serverUrl, identity);
      const info = await client.getExtension(name, apiKey);
      if (!info) return null;
      return { isPrivate: info.isPrivate ?? false };
    },
  };
}

// ── Prepare function ──────────────────────────────────────────────────

/**
 * Builds the flat list of source files for the adversarial review, tagging
 * each with its content kind and whether it is an entry point. Entry points
 * are the main implementation files; the remaining `all*Files` are helpers.
 */
function buildReviewFileRefs(
  input: ExtensionPushPrepareInput,
): ReviewFileRef[] {
  const refs: ReviewFileRef[] = [];
  const groups: Array<
    { kind: ReviewFileRef["kind"]; all: string[]; entry: string[] }
  > = [
    { kind: "model", all: input.allModelFiles, entry: input.modelEntryPoints },
    { kind: "vault", all: input.allVaultFiles, entry: input.vaultEntryPoints },
    {
      kind: "datastore",
      all: input.allDatastoreFiles,
      entry: input.datastoreEntryPoints,
    },
    {
      kind: "report",
      all: input.allReportFiles,
      entry: input.reportEntryPoints,
    },
    {
      kind: "webhook",
      all: input.allWebhookFiles,
      entry: input.webhookEntryPoints,
    },
  ];
  for (const group of groups) {
    const entrySet = new Set(group.entry);
    for (const path of group.all) {
      refs.push({ path, kind: group.kind, isEntryPoint: entrySet.has(path) });
    }
  }
  return refs;
}

/** The reviewable content kinds present in the extension. */
function contentKindsPresent(
  input: ExtensionPushPrepareInput,
): ExtensionContentKind[] {
  const kinds: ExtensionContentKind[] = [];
  if (input.allModelFiles.length > 0) kinds.push("model");
  if (input.allVaultFiles.length > 0) kinds.push("vault");
  if (input.allDatastoreFiles.length > 0) kinds.push("datastore");
  if (input.allReportFiles.length > 0) kinds.push("report");
  if (input.allWebhookFiles.length > 0) kinds.push("webhook");
  return kinds;
}

/**
 * Performs the extension push prepare phase: validates auth & collectives,
 * extracts content metadata, validates content collectives, runs safety
 * analysis, runs quality checks, bundles entry points, and creates archive.
 *
 * This is a plain async function that throws SwampError on failure.
 * The CLI handles all interactive prompts between prepare and execute.
 */
export async function extensionPushPrepare(
  ctx: LibSwampContext,
  deps: ExtensionPushPrepareDeps,
  input: ExtensionPushPrepareInput,
): Promise<ExtensionPushPrepared> {
  let requestedVisibility: PublishVisibility | undefined;
  try {
    requestedVisibility = resolvePublishVisibility(input.manifest.visibility);
  } catch (error) {
    throw validationFailed(
      error instanceof Error ? error.message : String(error),
    );
  }
  // A private publication adds the private-entitlement check; public or
  // default intent leaves the registry to apply its defaults.
  const privateIntent = requestedVisibility === "private";
  // 1. Registry checks: authentication and collective membership. A real
  // push (`enforce`) stops at the first failure; a dry run (`collect`)
  // records every verdict so the summary reports what the push would say;
  // packaging-only callers (`skip`) never contact the registry.
  const mode = input.registryChecks;
  const registryChecks: RegistryCheckResult[] = [];
  let credentials:
    | { serverUrl: string; apiKey: string; username: string }
    | undefined;
  let collectiveEntitlement: CollectiveEntitlement | undefined;
  // Why the credentialed checks could not run, when they could not.
  let credentialsUnavailable: string | undefined;
  if (mode !== "skip") {
    const creds = await deps.loadCredentials();
    if (!creds) {
      if (mode === "enforce") {
        throw notAuthenticated();
      }
      credentialsUnavailable = NO_CREDENTIALS_REASON;
      registryChecks.push(
        registryCheckNotRun(
          "authentication",
          "no-credentials",
          credentialsUnavailable,
        ),
        registryCheckNotRun(
          "reserved-collective",
          "no-credentials",
          credentialsUnavailable,
        ),
        registryCheckNotRun(
          "collective-membership",
          "no-credentials",
          credentialsUnavailable,
        ),
      );
      if (privateIntent) {
        registryChecks.push(
          registryCheckNotRun(
            "private-entitlement",
            "no-credentials",
            credentialsUnavailable,
          ),
        );
      }
    } else {
      // 2. Validate collective matches user's collectives
      let collectives: string[] | undefined;
      let entitlements: CollectiveEntitlement[] | undefined;
      let signedOut = false;
      let lookupFailure: string | undefined;
      try {
        const lookup = await deps.fetchCollectives(
          creds.serverUrl,
          creds.apiKey,
        );
        collectives = lookup.collectives;
        entitlements = lookup.entitlements;
      } catch (error) {
        if (isNotAuthenticatedError(error)) {
          signedOut = true;
        } else {
          lookupFailure = error instanceof Error
            ? error.message
            : String(error);
          ctx.logger
            .debug`Could not fetch collectives from server, falling back to username check`;
        }
      }

      if (signedOut) {
        if (mode === "enforce") {
          throw notAuthenticated();
        }
        credentialsUnavailable = AUTH_FAILED_REASON;
        registryChecks.push(
          {
            name: "authentication",
            status: "failed",
            message: notAuthenticated().message,
          },
          registryCheckNotRun(
            "reserved-collective",
            "authentication-failed",
            credentialsUnavailable,
          ),
          registryCheckNotRun(
            "collective-membership",
            "authentication-failed",
            credentialsUnavailable,
          ),
        );
        if (privateIntent) {
          registryChecks.push(
            registryCheckNotRun(
              "private-entitlement",
              "authentication-failed",
              credentialsUnavailable,
            ),
          );
        }
      } else {
        credentials = creds;
        collectiveEntitlement = entitlements?.find((e) =>
          e.slug === collectiveOf(input.manifest.name)
        );
        registryChecks.push(
          lookupFailure !== undefined
            ? registryCheckNotRun(
              "authentication",
              "registry-unavailable",
              `registry did not answer: ${lookupFailure}`,
            )
            : {
              name: "authentication",
              status: "passed",
              message: `Signed in as ${creds.username}.`,
            },
        );
        const { reserved, membership } = evaluateCollectiveMembership({
          extensionName: input.manifest.name,
          collectives,
          username: creds.username,
        });
        // For reserved collectives, membership MUST be verified by the server.
        for (const check of [reserved, membership]) {
          if (check.status === "failed" && mode === "enforce") {
            throw validationFailed(check.message);
          }
        }
        registryChecks.push(reserved, membership);
        // 2b. Private entitlement, from the same whoami answer. Only a
        // collective the caller belongs to has an entitlement to report, so
        // the check is omitted when membership did not pass. A whoami that
        // did not answer leaves it unasked, like authentication; an answer
        // that does not settle it (no entitlement reported, or a free plan
        // the registry may start a trial for) is undecided, and the push
        // lets the registry decide.
        if (privateIntent) {
          if (lookupFailure !== undefined) {
            registryChecks.push(
              registryCheckNotRun(
                "private-entitlement",
                "registry-unavailable",
                `registry did not answer: ${lookupFailure}`,
              ),
            );
          } else if (membership.status === "passed") {
            const entitlement = evaluatePrivateEntitlement({
              extensionName: input.manifest.name,
              entitlements,
              serverUrl: creds.serverUrl,
            });
            if (entitlement.status === "failed" && mode === "enforce") {
              throw validationFailed(entitlement.message);
            }
            registryChecks.push(entitlement);
          }
        }
      }
    }
  }

  // 3. Extract content metadata
  let contentMetadata: ExtensionContentMetadata | undefined;
  try {
    contentMetadata = await deps.extractContentMetadata(
      input.modelEntryPoints,
      input.modelsDir,
      input.workflowFiles,
      input.allVaultFiles,
      input.vaultsDir,
      input.allDatastoreFiles,
      input.datastoresDir,
      input.allReportFiles,
      input.reportsDir,
      input.allWebhookFiles,
      input.webhooksDir,
    );
    ctx.logger
      .debug`Extracted content metadata: ${contentMetadata.models.length} models, ${contentMetadata.workflows.length} workflows, ${contentMetadata.vaults.length} vaults, ${contentMetadata.datastores.length} datastores, ${contentMetadata.reports.length} reports, ${contentMetadata.webhooks.length} webhooks`;
  } catch {
    ctx.logger.debug`Content metadata extraction failed, skipping`;
  }

  // 4. Validate content collectives
  if (contentMetadata) {
    const collectiveResult = validateContentCollectives(
      input.manifest.name,
      contentMetadata,
    );
    if (!collectiveResult.valid) {
      const slashIndex = input.manifest.name.indexOf("/");
      const expectedCollective = input.manifest.name.slice(
        0,
        slashIndex + 1,
      );
      throw validationFailed(
        "Extension content uses collectives that don't match the extension package. " +
          "All model types, vault types, workflow names, datastore types, report names, and webhook types must use the same collective as the extension.",
        {
          expectedCollective,
          mismatches: collectiveResult.mismatches,
        },
      );
    }
  }

  // 5. Build resolved data
  const resolvedData = buildResolvedData(input, contentMetadata);

  // 6a. Pre-check additionalFiles against the extension allowlist so the
  // error can name the manifest field and suggest `binaries`.
  for (const file of input.additionalFilePaths) {
    const ext = extname(file).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext) && !LEGAL_BASENAMES.has(basename(file))) {
      const rel = relative(input.repoDir, file);
      throw validationFailed(
        `File "${rel}" in additionalFiles has extension "${ext}" which is not allowed. ` +
          `Allowed extensions for additionalFiles: ${
            [...ALLOWED_EXTENSIONS].join(", ")
          }. ` +
          `If this is an executable or binary file, move it to the \`binaries\` field in manifest.yaml instead.`,
      );
    }
  }

  // 6b. Safety analysis
  // Include files are safety-checked but excluded from quality checks
  // (they may have their own tooling and conventions).
  const qualityFiles = [
    ...input.allModelFiles,
    ...input.allVaultFiles,
    ...input.allDatastoreFiles,
    ...input.allReportFiles,
    ...input.allWebhookFiles,
    ...input.workflowFiles.map((wf) => wf.sourcePath),
    ...input.additionalFilePaths,
  ];
  const allFiles = [
    ...qualityFiles,
    ...input.includeFilePaths,
    ...input.binaryFilePaths,
  ];
  const binaryExemptSet = new Set(input.binaryFilePaths);
  const safetyResult = await deps.analyzeExtensionSafety(
    allFiles,
    binaryExemptSet,
  );

  if (safetyResult.errors.length > 0) {
    throw validationFailed(
      "Extension has safety errors that must be resolved before pushing.",
      { safetyErrors: safetyResult.errors },
    );
  }

  // 7. Dependency trust audit
  let dependencyTrustResult: DependencyTrustResult;
  const sourceFiles = [
    ...input.allModelFiles,
    ...input.allVaultFiles,
    ...input.allDatastoreFiles,
    ...input.allReportFiles,
    ...input.allWebhookFiles,
  ];
  const specifiers = await deps.extractDependencySpecifiers(sourceFiles);
  if (specifiers.length > 0) {
    ctx.logger.debug`Auditing ${specifiers.length} dependency specifier(s)`;
    dependencyTrustResult = await deps.checkDependencyTrust(specifiers);
    if (dependencyTrustResult.errors.length > 0) {
      throw validationFailed(
        "Extension has dependency trust errors that must be resolved before pushing.",
        { dependencyTrustErrors: dependencyTrustResult.errors },
      );
    }
  } else {
    dependencyTrustResult = {
      errors: [],
      warnings: [],
      audited: [],
      passed: true,
    };
  }

  // 8. Validate skills and populate content metadata
  if (input.skillDirs.length > 0) {
    const skillResult = await validateExtensionSkills(input.skillDirs);
    if (skillResult.errors.length > 0) {
      throw validationFailed(
        "Extension has skill validation errors:\n" +
          skillResult.errors.map((e) => `  ${e.skill}: ${e.message}`).join(
            "\n",
          ),
      );
    }

    // Populate skill metadata for registry
    if (contentMetadata) {
      const skillsByName = new Map(
        skillResult.skills.map((s) => [s.name, s]),
      );
      contentMetadata.skills = input.skillDirs.map((s) => {
        const validated = skillsByName.get(s.name);
        return {
          dirName: s.name,
          name: s.name,
          description: "",
          hasScripts: validated?.hasScripts ?? false,
          fileCount: validated?.fileCount ?? 0,
        };
      });
    }
  }

  // 9. Resolve deno binary (only needed when building a fresh archive)
  const usingCachedArchive = input.cachedArchive !== undefined;
  let denoPath = "";
  if (!usingCachedArchive) {
    denoPath = await deps.ensureDenoPath();
  }

  // 10. Quality checks — skip on cache hit (the cached archive was
  // written only after quality checks passed)
  if (!usingCachedArchive) {
    const qualityResult = await deps.checkExtensionQuality(
      qualityFiles,
      denoPath,
      input.denoConfigPath,
      deps.getDenoEnv(),
    );
    if (!qualityResult.passed) {
      throw validationFailed(
        "Extension has formatting or lint issues. Run 'swamp extension fmt <manifest-path>' to fix.",
        { qualityErrors: qualityResult.issues },
      );
    }
  }

  // 10a. Upgrade chain consistency — validate that each model's upgrade
  // chain terminates at its declared version. Always runs (not gated on
  // cache hit) since it's a fast file read.
  const upgradeChainIssues = await checkUpgradeChainConsistency(
    input.allModelFiles,
  );
  if (upgradeChainIssues.length > 0) {
    throw validationFailed(
      "Extension has model upgrade chain errors that must be resolved before pushing.",
      { upgradeChainErrors: upgradeChainIssues },
    );
  }

  // 10b. Review — runs after the mechanical gates (safety/deps/fmt) so those
  // fire first. Two parts: deterministic static file rules (NOT the adversarial
  // review — those only warn), and validation of the adversarial-review report
  // (the agent/CI judgment pass). Report findings are warnings: a missing or
  // stale report surfaces the "continue despite warnings?" prompt rather than a
  // hard block, so a benign version bump nudges the reviewer instead of bricking
  // the push.
  const reviewInput: ExtensionReviewInput = {
    files: buildReviewFileRefs(input),
  };
  const reviewKinds = contentKindsPresent(input);
  if (input.contentHash && reviewKinds.length > 0) {
    const dims = applicableDimensions(reviewKinds);
    reviewInput.report = {
      reportPath: reviewReportPath(input.manifest.name, input.contentHash),
      extensionName: input.manifest.name,
      extensionVersion: input.manifest.version,
      applicableDimensions: dims,
      skeleton: buildReviewReportSkeleton(
        input.manifest.name,
        input.manifest.version,
        dims,
      ),
    };
  }
  const reviewRulesResult = await deps.checkReviewRules(reviewInput);
  if (reviewRulesResult.errors.length > 0) {
    throw validationFailed(
      "Extension review found issues that must be resolved before pushing.",
      { reviewRuleErrors: reviewRulesResult.errors },
    );
  }

  // 10c. Bare specifier check — warn that the server-side scorer cannot
  // resolve bare imports (it strips deno.json and writes a controlled one).
  const bareSpecifiers = new Set<string>();
  for (const file of sourceFiles) {
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
    reviewRulesResult.warnings.push({
      ruleId: "bare-specifiers",
      dimension: "scoring",
      severity: "medium",
      file: "(multiple files)",
      message: `Extension uses bare import specifiers (${
        names.map((s) => `"${s}"`).join(", ")
      }) which cannot be scored by the server. The extension will be published but may show as unscored.`,
    });
  }

  // 11. Bundle entry points + build archive — skip on cache hit
  let totalBundles: number;
  let archiveBytes: Uint8Array;
  if (usingCachedArchive) {
    totalBundles = input.modelEntryPoints.length +
      input.vaultEntryPoints.length +
      input.datastoreEntryPoints.length + input.reportEntryPoints.length +
      input.webhookEntryPoints.length;
    archiveBytes = input.cachedArchive!;
  } else {
    const built = await bundleAndArchive(input, deps, denoPath, ctx);
    totalBundles = built.totalBundles;
    archiveBytes = built.archiveBytes;
  }
  // Same compressed limit pull enforces, so consumers can download what is
  // pushed. The decompressed limit is enforced at install only.
  if (archiveBytes.byteLength > MAX_EXTENSION_ARCHIVE_BYTES) {
    throw validationFailed(
      `Extension archive is ${
        formatArchiveBytes(archiveBytes.byteLength)
      }, over the ${
        formatArchiveBytes(MAX_EXTENSION_ARCHIVE_BYTES)
      } archive size limit. Reduce bundled dependencies or binaries.`,
    );
  }

  // 12. The version must not be published on any channel. Runs after
  // packaging, as it always has, so the cheaper local gates fire first.
  if (mode !== "skip") {
    if (!credentials) {
      registryChecks.push(
        registryCheckNotRun(
          "version-exists",
          credentialsUnavailable === AUTH_FAILED_REASON
            ? "authentication-failed"
            : "no-credentials",
          credentialsUnavailable ?? NO_CREDENTIALS_REASON,
        ),
      );
    } else {
      let published: PublishedVersion | null = null;
      let lookupFailure: string | undefined;
      try {
        published = await deps.findPublishedVersion(
          credentials.serverUrl,
          input.manifest.name,
          input.manifest.version,
          credentials.apiKey,
        );
      } catch (error) {
        if (mode === "enforce") {
          throw error;
        }
        lookupFailure = error instanceof Error ? error.message : String(error);
      }
      if (lookupFailure !== undefined) {
        registryChecks.push(
          registryCheckNotRun(
            "version-exists",
            "registry-unavailable",
            `registry lookup failed: ${lookupFailure}`,
          ),
        );
      } else {
        const check = evaluateVersionExists({
          extensionName: input.manifest.name,
          version: input.manifest.version,
          published,
        });
        if (check.status === "failed" && mode === "enforce") {
          throw validationFailed(check.message, {
            existingVersion: input.manifest.version,
          });
        }
        registryChecks.push(check);
      }
    }
  }

  return {
    resolvedData,
    safetyWarnings: safetyResult.warnings,
    dependencyTrustResult,
    reviewRulesResult,
    archiveBytes,
    manifest: input.manifest,
    contentMetadata,
    counts: {
      models: input.modelEntryPoints.length,
      workflows: input.workflowFiles.length,
      bundles: totalBundles,
      vaults: input.vaultEntryPoints.length,
      datastores: input.datastoreEntryPoints.length,
      reports: input.reportEntryPoints.length,
      webhooks: input.webhookEntryPoints.length,
      skills: input.skillDirs.length,
    },
    isDryRun: input.dryRun,
    registryChecks,
    contentHash: input.contentHash,
    collectiveEntitlement,
  };
}

const NO_CREDENTIALS_REASON =
  "no credentials; run 'swamp auth login' to sign in";
const AUTH_FAILED_REASON = "authentication failed";

function isNotAuthenticatedError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as SwampError).code === "not_authenticated";
}

/** A 403 from the registry that is not a missing token scope. */
function isRegistryForbidden(error: unknown): boolean {
  return error instanceof UserError && error.code === REGISTRY_FORBIDDEN_CODE;
}

// ── Push generator ────────────────────────────────────────────────────

/**
 * Executes the three-phase push to the registry.
 * Yields streaming events for each phase.
 */
export async function* extensionPush(
  ctx: LibSwampContext,
  deps: ExtensionPushExecuteDeps,
  input: ExtensionPushExecuteInput,
): AsyncIterable<ExtensionPushEvent> {
  yield* withGeneratorSpan(
    "swamp.extension.push",
    { "extension.name": input.manifest.name },
    (async function* () {
      let requestedVisibility: PublishVisibility | undefined;
      try {
        requestedVisibility = resolvePublishVisibility(
          input.manifest.visibility,
        );
      } catch (error) {
        yield {
          kind: "error" as const,
          error: validationFailed(
            error instanceof Error ? error.message : String(error),
          ),
        };
        return;
      }
      const credentials = await deps.loadCredentials();
      if (!credentials) {
        yield { kind: "error" as const, error: notAuthenticated() };
        return;
      }
      // The registry's refusal of a private publication is passed on as it
      // came, followed by what the registry had reported for the collective
      // at sign-in, so the message names the plan that stood behind it.
      const refusalMessage = (error: unknown): string => {
        const message = error instanceof Error ? error.message : String(error);
        if (requestedVisibility === "private" && isRegistryForbidden(error)) {
          return explainPrivatePublishRefusal(message, {
            extensionName: input.manifest.name,
            entitlement: input.collectiveEntitlement,
            serverUrl: credentials.serverUrl,
          });
        }
        return message;
      };

      if (!input.manifest.repository) {
        ctx.logger.warn(
          "Your extension manifest doesn't declare a `repository` URL. " +
            `Users running \`swamp issue bug --extension ${input.manifest.name}\` ` +
            "won't be able to file issues against it. " +
            "Consider adding a `repository:` field to manifest.yaml.",
        );
      }

      const releaseNotes = input.releaseNotes ?? input.manifest.releaseNotes;
      const pushMetadata = {
        name: input.manifest.name,
        version: input.manifest.version,
        description: input.manifest.description ?? "",
        dependencies: input.manifest.dependencies,
        platforms: input.manifest.platforms,
        labels: input.manifest.labels,
        repository: input.manifest.repository || undefined,
        ...(releaseNotes ? { releaseNotes } : {}),
        ...(input.manifest.binaries.length > 0
          ? { binaries: input.manifest.binaries }
          : {}),
        ...(input.channel ? { channel: input.channel } : {}),
        ...(requestedVisibility === "private"
          ? { visibility: requestedVisibility }
          : {}),
      };

      // Phase 1: Initiate
      yield { kind: "pushing" as const, phase: "initiate" as const };
      ctx.logger.debug("Initiating push...");
      let initResult: { uploadUrl: string };
      try {
        initResult = await deps.initiatePush(
          credentials.serverUrl,
          pushMetadata,
          credentials.apiKey,
        );
      } catch (error) {
        yield {
          kind: "error" as const,
          error: validationFailed(refusalMessage(error)),
        };
        return;
      }

      // Phase 2: Upload archive
      yield { kind: "pushing" as const, phase: "upload" as const };
      ctx.logger.debug("Uploading archive...");
      try {
        await deps.uploadArchive(initResult.uploadUrl, input.archiveBytes);
      } catch (error) {
        yield {
          kind: "error" as const,
          error: validationFailed(
            error instanceof Error ? error.message : String(error),
          ),
        };
        return;
      }

      // Phase 3: Confirm
      yield { kind: "pushing" as const, phase: "confirm" as const };
      ctx.logger.debug("Confirming push...");
      let confirmResult: {
        name: string;
        version: string;
        extensionId: string;
        visibility?: "public" | "private";
      };
      try {
        confirmResult = await deps.confirmPush(
          credentials.serverUrl,
          { ...pushMetadata, contentMetadata: input.contentMetadata },
          credentials.apiKey,
        );
      } catch (error) {
        yield {
          kind: "error" as const,
          error: validationFailed(refusalMessage(error)),
        };
        return;
      }

      if (
        requestedVisibility === "private" &&
        confirmResult.visibility !== "private"
      ) {
        yield {
          kind: "error" as const,
          error: validationFailed(
            "Registry did not confirm private publication. Publication may have completed; check the extension's visibility in the registry before retrying. Explicit private publication requires a fully upgraded registry.",
          ),
        };
        return;
      }

      let visibility = confirmResult.visibility ?? "public";
      if (confirmResult.visibility === undefined) {
        // Legacy servers omit applied visibility. Public/default intent may use
        // the historical best-effort lookup; explicit privacy was checked above.
        try {
          const info = await deps.getExtensionVisibility(
            credentials.serverUrl,
            confirmResult.name,
            credentials.apiKey,
          );
          if (info?.isPrivate) visibility = "private";
        } catch {
          // Preserve legacy behavior when no private publication was requested.
        }
      }

      yield {
        kind: "completed" as const,
        data: {
          name: confirmResult.name,
          version: confirmResult.version,
          extensionId: confirmResult.extensionId,
          archiveSize: input.archiveBytes.length,
          modelCount: input.counts.models,
          workflowCount: input.counts.workflows,
          bundleCount: input.counts.bundles,
          vaultCount: input.counts.vaults,
          datastoreCount: input.counts.datastores,
          reportCount: input.counts.reports,
          webhookCount: input.counts.webhooks,
          skillCount: input.counts.skills,
          channel: input.channel ?? "stable",
          visibility,
        },
      };
    })(),
  );
}

// ── Helpers ───────────────────────────────────────────────────────────

function buildResolvedData(
  input: ExtensionPushPrepareInput,
  contentMetadata: ExtensionContentMetadata | undefined,
): ExtensionPushResolvedData {
  const extractedModelsByFile = new Map(
    (contentMetadata?.models ?? []).map((m) => [m.fileName, m]),
  );
  const extractedVaultsByFile = new Map(
    (contentMetadata?.vaults ?? []).map((v) => [v.fileName, v]),
  );
  const extractedDatastoresByFile = new Map(
    (contentMetadata?.datastores ?? []).map((d) => [d.fileName, d]),
  );
  const extractedReportsByFile = new Map(
    (contentMetadata?.reports ?? []).map((r) => [r.fileName, r]),
  );
  const extractedWebhooksByFile = new Map(
    (contentMetadata?.webhooks ?? []).map((w) => [w.fileName, w]),
  );

  const resolvedModels = input.modelEntryPoints.map((f) => {
    const relPath = relative(input.repoDir, f);
    const extracted = extractedModelsByFile.get(
      relative(input.modelsDir, f),
    );
    return {
      type: extracted?.type ?? relPath,
      fileName: relPath,
      globalArguments: extracted?.globalArguments,
    };
  });

  const resolvedVaults = input.vaultEntryPoints.map((f) => {
    const relPath = relative(input.repoDir, f);
    const extracted = extractedVaultsByFile.get(
      relative(input.vaultsDir, f),
    );
    return {
      type: extracted?.type ?? relPath,
      fileName: relPath,
      name: extracted?.name,
      hasConfigSchema: extracted?.hasConfigSchema,
      configFields: extracted?.configFields,
    };
  });

  const resolvedDatastores = input.datastoreEntryPoints.map((f) => {
    const relPath = relative(input.repoDir, f);
    const extracted = extractedDatastoresByFile.get(
      relative(input.datastoresDir, f),
    );
    return {
      type: extracted?.type ?? relPath,
      fileName: relPath,
      name: extracted?.name,
      hasConfigSchema: extracted?.hasConfigSchema,
      configFields: extracted?.configFields,
    };
  });

  const resolvedReports = input.reportEntryPoints.map((f) => {
    const relPath = relative(input.repoDir, f);
    const extracted = extractedReportsByFile.get(
      relative(input.reportsDir, f),
    );
    return {
      name: extracted?.name ?? relPath,
      fileName: relPath,
      description: extracted?.description,
      scope: extracted?.scope,
      labels: extracted?.labels,
    };
  });

  const resolvedWebhooks = input.webhookEntryPoints.map((f) => {
    const relPath = relative(input.repoDir, f);
    const extracted = extractedWebhooksByFile.get(
      relative(input.webhooksDir, f),
    );
    return {
      type: extracted?.type ?? relPath,
      fileName: relPath,
      name: extracted?.name,
      description: extracted?.description,
    };
  });

  const resolvedReleaseNotes = input.releaseNotes ??
    input.manifest.releaseNotes;

  return {
    name: input.manifest.name,
    version: input.manifest.version,
    visibility: input.manifest.visibility ?? "default",
    description: input.manifest.description,
    repository: input.manifest.repository,
    releaseNotes: resolvedReleaseNotes,
    models: resolvedModels,
    workflowFiles: input.workflowFiles.map((wf) =>
      relative(input.repoDir, wf.sourcePath)
    ),
    vaults: resolvedVaults,
    datastores: resolvedDatastores,
    reports: resolvedReports,
    webhooks: resolvedWebhooks,
    skills: input.skillDirs.map((s) => ({
      name: s.name,
      fileCount:
        input.allSkillFiles.filter((f) => f.startsWith(s.absolutePath)).length,
    })),
    additionalFiles: input.additionalFilePaths.map((f) =>
      relative(input.repoDir, f)
    ),
    platforms: input.manifest.platforms,
    labels: input.manifest.labels,
    dependencies: input.manifest.dependencies,
  };
}

async function bundleAndArchive(
  input: ExtensionPushPrepareInput,
  deps: ExtensionPushPrepareDeps,
  denoPath: string,
  ctx: LibSwampContext,
): Promise<{ archiveBytes: Uint8Array; totalBundles: number }> {
  const bundleOptions = input.denoConfigPath
    ? { denoConfigPath: input.denoConfigPath }
    : input.packageJsonDir
    ? { packageJsonDir: input.packageJsonDir }
    : undefined;

  const bundles = new Map<string, string>();
  const compilationErrors: CompilationError[] = [];

  await bundleEntryPoints(
    input.modelEntryPoints,
    input.modelsDir,
    bundles,
    compilationErrors,
    deps,
    denoPath,
    bundleOptions,
    ctx,
    "model",
  );

  const vaultBundles = new Map<string, string>();
  await bundleEntryPoints(
    input.vaultEntryPoints,
    input.vaultsDir,
    vaultBundles,
    compilationErrors,
    deps,
    denoPath,
    bundleOptions,
    ctx,
    "vault",
  );

  const datastoreBundles = new Map<string, string>();
  await bundleEntryPoints(
    input.datastoreEntryPoints,
    input.datastoresDir,
    datastoreBundles,
    compilationErrors,
    deps,
    denoPath,
    bundleOptions,
    ctx,
    "datastore",
  );

  const reportBundles = new Map<string, string>();
  await bundleEntryPoints(
    input.reportEntryPoints,
    input.reportsDir,
    reportBundles,
    compilationErrors,
    deps,
    denoPath,
    bundleOptions,
    ctx,
    "report",
  );

  const webhookBundles = new Map<string, string>();
  await bundleEntryPoints(
    input.webhookEntryPoints,
    input.webhooksDir,
    webhookBundles,
    compilationErrors,
    deps,
    denoPath,
    bundleOptions,
    ctx,
    "webhook",
  );

  if (compilationErrors.length > 0) {
    throw validationFailed(
      "Bundle compilation failed. Fix the errors above and try again.",
      { compilationErrors },
    );
  }

  const totalBundles = bundles.size + vaultBundles.size +
    datastoreBundles.size + reportBundles.size + webhookBundles.size;

  const archiveBytes = await createArchive(
    input,
    bundles,
    vaultBundles,
    datastoreBundles,
    reportBundles,
    webhookBundles,
    ctx,
  );

  return { archiveBytes, totalBundles };
}

async function bundleEntryPoints(
  entryPoints: string[],
  baseDir: string,
  bundles: Map<string, string>,
  compilationErrors: CompilationError[],
  deps: ExtensionPushPrepareDeps,
  denoPath: string,
  bundleOptions:
    | { denoConfigPath?: string; packageJsonDir?: string }
    | undefined,
  ctx: LibSwampContext,
  label: string,
): Promise<void> {
  for (const entryPoint of entryPoints) {
    const entryName = relative(baseDir, entryPoint).replace(/\.ts$/, "");
    try {
      const js = await deps.bundleEntryPoint(
        entryPoint,
        denoPath,
        { ...bundleOptions, env: deps.getDenoEnv() },
      );
      bundles.set(entryName, js);
      ctx.logger.debug`Bundled ${label} ${entryName} (${js.length} bytes)`;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      compilationErrors.push({ file: entryPoint, error: msg });
    }
  }
}

async function createArchive(
  input: ExtensionPushPrepareInput,
  bundles: Map<string, string>,
  vaultBundles: Map<string, string>,
  datastoreBundles: Map<string, string>,
  reportBundles: Map<string, string>,
  webhookBundles: Map<string, string>,
  ctx: LibSwampContext,
): Promise<Uint8Array> {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_ext_" });

  try {
    const extDir = join(tmpDir, "extension");
    const dirs = [
      "models",
      "bundles",
      "workflows",
      "vaults",
      "vault-bundles",
      "datastores",
      "datastore-bundles",
      "reports",
      "report-bundles",
      "webhooks",
      "webhook-bundles",
      "skills",
      "files",
    ];
    for (const dir of dirs) {
      await Deno.mkdir(join(extDir, dir), { recursive: true });
    }

    // Re-emit the manifest from parsed fields. Path string arrays
    // pass through verbatim — the on-wire manifest stays
    // byte-equivalent to the author's intent (no path rewriting),
    // so what the registry stores matches what was pushed.
    await Deno.writeTextFile(
      join(extDir, "manifest.yaml"),
      stringifyYaml({
        manifestVersion: input.manifest.manifestVersion,
        name: input.manifest.name,
        version: input.manifest.version,
        description: input.manifest.description ?? "",
        ...(input.manifest.visibility
          ? { visibility: input.manifest.visibility }
          : {}),
        ...(input.manifest.repository
          ? { repository: input.manifest.repository }
          : {}),
        ...(input.manifest.paths.base !== "typedDir"
          ? { paths: { base: input.manifest.paths.base } }
          : {}),
        models: input.manifest.models,
        workflows: input.manifest.workflows,
        vaults: input.manifest.vaults,
        datastores: input.manifest.datastores,
        reports: input.manifest.reports,
        ...(input.manifest.webhooks.length > 0
          ? { webhooks: input.manifest.webhooks }
          : {}),
        ...(input.manifest.skills.length > 0
          ? { skills: input.manifest.skills }
          : {}),
        ...(input.manifest.include.length > 0
          ? { include: input.manifest.include }
          : {}),
        additionalFiles: input.manifest.additionalFiles,
        ...(input.manifest.binaries.length > 0
          ? { binaries: input.manifest.binaries }
          : {}),
        ...(input.manifest.platforms.length > 0
          ? { platforms: input.manifest.platforms }
          : {}),
        ...(input.manifest.labels.length > 0
          ? { labels: input.manifest.labels }
          : {}),
        dependencies: input.manifest.dependencies,
      }),
    );

    // Copy model source files
    for (const modelFile of input.allModelFiles) {
      const relPath = relative(input.modelsDir, modelFile);
      const destPath = join(extDir, "models", relPath);
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await Deno.copyFile(modelFile, destPath);
    }

    // Copy include files (alongside model sources, not bundled)
    for (const incFile of input.includeFilePaths) {
      const relPath = relative(input.modelsDir, incFile);
      const destPath = join(extDir, "models", relPath);
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await Deno.copyFile(incFile, destPath);
    }

    // Write compiled model bundles
    for (const [entryName, js] of bundles) {
      const destPath = join(extDir, "bundles", `${entryName}.js`);
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await Deno.writeTextFile(destPath, js);
    }

    // Copy workflow files
    for (const wf of input.workflowFiles) {
      const destPath = join(extDir, "workflows", wf.archiveName);
      await Deno.copyFile(wf.sourcePath, destPath);
    }

    // Copy vault source files
    for (const vaultFile of input.allVaultFiles) {
      const relPath = relative(input.vaultsDir, vaultFile);
      const destPath = join(extDir, "vaults", relPath);
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await Deno.copyFile(vaultFile, destPath);
    }

    // Write compiled vault bundles
    for (const [entryName, js] of vaultBundles) {
      const destPath = join(extDir, "vault-bundles", `${entryName}.js`);
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await Deno.writeTextFile(destPath, js);
    }

    // Copy datastore source files
    for (const datastoreFile of input.allDatastoreFiles) {
      const relPath = relative(input.datastoresDir, datastoreFile);
      const destPath = join(extDir, "datastores", relPath);
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await Deno.copyFile(datastoreFile, destPath);
    }

    // Write compiled datastore bundles
    for (const [entryName, js] of datastoreBundles) {
      const destPath = join(
        extDir,
        "datastore-bundles",
        `${entryName}.js`,
      );
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await Deno.writeTextFile(destPath, js);
    }

    // Copy report source files
    for (const reportFile of input.allReportFiles) {
      const relPath = relative(input.reportsDir, reportFile);
      const destPath = join(extDir, "reports", relPath);
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await Deno.copyFile(reportFile, destPath);
    }

    // Write compiled report bundles
    for (const [entryName, js] of reportBundles) {
      const destPath = join(extDir, "report-bundles", `${entryName}.js`);
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await Deno.writeTextFile(destPath, js);
    }

    // Copy webhook source files
    for (const webhookFile of input.allWebhookFiles) {
      const relPath = relative(input.webhooksDir, webhookFile);
      const destPath = join(extDir, "webhooks", relPath);
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await Deno.copyFile(webhookFile, destPath);
    }

    // Write compiled webhook bundles
    for (const [entryName, js] of webhookBundles) {
      const destPath = join(extDir, "webhook-bundles", `${entryName}.js`);
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await Deno.writeTextFile(destPath, js);
    }

    // Copy skill directories
    for (const { name, absolutePath } of input.skillDirs) {
      const destDir = join(extDir, "skills", name);
      await Deno.mkdir(destDir, { recursive: true });
      const copySkillDir = async (src: string, dest: string): Promise<void> => {
        for await (const entry of Deno.readDir(src)) {
          const srcPath = join(src, entry.name);
          const destPath = join(dest, entry.name);
          if (entry.isDirectory) {
            await Deno.mkdir(destPath, { recursive: true });
            await copySkillDir(srcPath, destPath);
          } else if (entry.isFile) {
            await Deno.copyFile(srcPath, destPath);
          }
        }
      };
      await copySkillDir(absolutePath, destDir);
    }

    // Copy additional files, preserving the relative paths declared in the
    // manifest. additionalFiles (relative) and additionalFilePaths (absolute)
    // are parallel arrays maintained by resolve_extension_files.ts.
    if (
      input.manifest.additionalFiles.length !== input.additionalFilePaths.length
    ) {
      throw validationFailed(
        "additionalFiles and additionalFilePaths length mismatch — " +
          "this is a bug in extension file resolution.",
      );
    }
    for (let i = 0; i < input.additionalFilePaths.length; i++) {
      const absPath = input.additionalFilePaths[i];
      const relPath = input.manifest.additionalFiles[i];
      const destPath = join(extDir, "files", relPath);
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await Deno.copyFile(absPath, destPath);
    }

    // Copy binary files, preserving executable mode bits.
    if (
      input.manifest.binaries.length !== input.binaryFilePaths.length
    ) {
      throw validationFailed(
        "binaries and binaryFilePaths length mismatch — " +
          "this is a bug in extension file resolution.",
      );
    }
    for (let i = 0; i < input.binaryFilePaths.length; i++) {
      const absPath = input.binaryFilePaths[i];
      const relPath = input.manifest.binaries[i];
      const destPath = join(extDir, "files", relPath);
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await Deno.copyFile(absPath, destPath);
      if (Deno.build.os !== "windows") {
        const srcStat = await Deno.stat(absPath);
        if (srcStat.mode !== null) {
          await Deno.chmod(destPath, srcStat.mode);
        }
      }
    }

    // Create tar.gz. The Deno-native archiver walks the staged tree
    // explicitly, so the previous BSD-tar `COPYFILE_DISABLE=1` env var (which
    // suppressed macOS resource forks) is no longer needed: AppleDouble
    // siblings are filtered defensively in the archiver itself.
    const tarPath = join(tmpDir, "extension.tar.gz");
    try {
      await createTarGz(extDir, tarPath);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw validationFailed(`Failed to create archive: ${message}`);
    }

    const archiveBytes = await Deno.readFile(tarPath);

    // Verify gzip magic bytes
    if (archiveBytes[0] !== 0x1F || archiveBytes[1] !== 0x8B) {
      throw validationFailed(
        "Archive creation failed: output is not a valid gzip file.",
      );
    }

    ctx.logger.debug`Archive created: ${archiveBytes.length} bytes`;

    return archiveBytes;
  } finally {
    try {
      await Deno.remove(tmpDir, { recursive: true });
    } catch {
      // Best-effort cleanup
    }
  }
}
