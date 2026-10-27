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
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  SEPARATOR,
} from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import {
  createTarGz,
  extractTarGz,
} from "../../infrastructure/archive/tar_archive.ts";
import {
  EXTENSION_BUNDLE_KINDS,
  extensionInstallRoots,
} from "../../infrastructure/persistence/paths.ts";
import {
  formatArchiveBytes,
  MAX_EXTENSION_ARCHIVE_BYTES,
  MAX_EXTENSION_ARCHIVE_DECOMPRESSED_BYTES,
} from "../../domain/extensions/extension_archive_limits.ts";
import {
  type CollectiveMismatch,
  collectiveMismatchesForTypes,
  validateContentCollectives,
} from "../../domain/extensions/extension_collective_validator.ts";
import {
  createExtensionTreeIndexer,
  defaultConcurrency,
  type ExtensionKindDir,
  type ExtensionTreeIndex,
  type ExtensionTreeIndexer,
  fromStoredArchiveIndex,
  runtimeContentTypes,
  toStoredArchiveIndex,
} from "./extension_tree_index.ts";
import type { StoredArchiveIndex } from "../../domain/extensions/extension_package_cache.ts";
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
import type {
  DependencySpecifier,
} from "@swamp-club/extension-scoring/dependency-audit";
import type {
  DependencyTrustResult,
} from "@swamp-club/extension-scoring/dependency-audit";
import type {
  ExtensionContentKind,
  ExtensionReviewInput,
  ReviewFileRef,
  ReviewFinding,
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
import { archiveEntryRefusal } from "../../domain/extensions/archive_root_sources.ts";
import { firstSymlinkUnder } from "./first_symlink_under.ts";
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
  signedInCheck,
} from "../../domain/extensions/extension_publish_checks.ts";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import { keyFingerprint } from "../../domain/auth/auth_credentials.ts";

// ── Data types ────────────────────────────────────────────────────────

/** A model entry enriched with extracted metadata for the resolved display. */
export interface ResolvedModelEntry {
  /** Absent when neither the source text nor loading it gave a type. */
  type?: string;
  fileName: string;
  globalArguments?: ExtractedArgument[];
}

/** A vault entry enriched with extracted metadata for the resolved display. */
export interface ResolvedVaultEntry {
  /** Absent when neither the source text nor loading it gave a type. */
  type?: string;
  fileName: string;
  name?: string;
  hasConfigSchema?: boolean;
  configFields?: ExtractedArgument[];
}

/** A datastore entry enriched with extracted metadata for the resolved display. */
export interface ResolvedDatastoreEntry {
  /** Absent when neither the source text nor loading it gave a type. */
  type?: string;
  fileName: string;
  name?: string;
  hasConfigSchema?: boolean;
  configFields?: ExtractedArgument[];
}

/** A report entry enriched with extracted metadata for the resolved display. */
export interface ResolvedReportEntry {
  /** Absent when neither the source text nor loading it gave a name. */
  name?: string;
  fileName: string;
  description?: string;
  scope?: string;
  labels?: string[];
}

/** A webhook entry enriched with extracted metadata for the resolved display. */
export interface ResolvedWebhookEntry {
  /** Absent when neither the source text nor loading it gave a type. */
  type?: string;
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
  /** The declared SPDX license expression, or null when none is declared. */
  license: string | null;
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
  /**
   * What the registry said about the push it accepted, such as client
   * contentMetadata it discarded. Present only when it said something.
   */
  registryWarnings?: RegistryWarnings;
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
  /**
   * The manifest's directory. The `quality.yaml` sidecar (declared
   * acceptances, the generated declaration) is discovered beside it.
   */
  manifestDir: string;
  /**
   * The manifest file, whose description is checked for secret-unsafe
   * docs. Defaults to `manifest.yaml` in {@link manifestDir}.
   */
  manifestPath?: string;
  modelsDir: string;
  /**
   * The behaviors directory the model entry points resolved from when the
   * manifest lists them under `behaviors:` (swamp-club#3338). Files under
   * it are packed at `models/<path from it>`, exactly as files under
   * `modelsDir` are packed at `models/<path from modelsDir>`.
   */
  behaviorsDir?: string;
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
  /**
   * Local data modules (JSON, text or bytes imports) each kind reaches:
   * packaged and safety-scanned, never sent to fmt, lint or review rules.
   */
  dataFilesByKind?: Partial<Record<SourceArchiveKind, string[]>>;
  /**
   * The archive's source copy: where every local module goes and which of
   * its imports are rewritten there (swamp-club#3376).
   */
  sourcePlan: SourceArchivePlan;
  /**
   * Local modules an entry point imports that do not exist. Reported as
   * compilation errors at the bundle step, where the bundler used to
   * report them.
   */
  missingModules?: MissingLocalModule[];
  /**
   * Entry points whose module graph reaches a symlink. The bundler would
   * follow it and quote the target in its errors, so they are never
   * bundled (swamp-club#3420).
   */
  entryPointsReachingSymlinks?: string[];
  /**
   * Extension files with a symlink on their path, to the first symlinked
   * component (swamp-club#3421). Nothing reads them; the safety gate
   * refuses each by the symlink rule.
   */
  symlinkedPaths?: ReadonlyMap<string, string>;
  dryRun: boolean;
  /**
   * What to do with the registry-side checks (authentication, collective
   * membership, reserved collective, version exists): a real push enforces
   * them, a dry run collects their verdicts, packaging-only callers skip
   * them and never contact the registry.
   */
  registryChecks: RegistryChecksMode;
  /**
   * What to do when a local gate fails (content collectives, the
   * additionalFiles allowlist, safety, dependency trust, skills, fmt/lint,
   * upgrade chain, review errors, archive size). A push enforces them: the
   * first failure throws. `extension quality` collects them so it can still
   * score the archive and print the rubric beside every failure. Defaults to
   * `enforce`.
   */
  localGates?: LocalGatesMode;
  /**
   * The channel the push publishes to; stable when omitted. The
   * version-exists check compares it with the channel a published version
   * is already on.
   */
  channel?: string;
  releaseNotes?: string;
  denoConfigPath?: string;
  packageJsonDir?: string;
  /**
   * What Deno resolved each bare import a local module writes to, from the
   * module graph read under `denoConfigPath` (swamp-club#3612). Push
   * rewrites, audits and reports bare imports from these alone.
   */
  bareImports: ResolvedBareImport[];
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
  /**
   * The loaded types the cache entry recorded for `cachedArchive`. Used only
   * with that archive, so the collective check does not load every source
   * of an archive it has already judged (swamp-club#3456).
   */
  cachedArchiveIndex?: StoredArchiveIndex;
}

/** How the prepare phase treats a failed local gate. */
export type LocalGatesMode = "enforce" | "collect";

/** The local gates prepare runs, in the order it runs them. */
export type LocalGate =
  | "content-collectives"
  | "additional-files"
  | "safety"
  | "source-syntax"
  | "dependency-trust"
  | "skills"
  | "fmt-lint"
  | "upgrade-chain"
  | "review"
  | "archive-size";

/** A local gate that failed in `collect` mode, with the error push would throw. */
export interface LocalGateFailure {
  gate: LocalGate;
  message: string;
  details?: unknown;
}

/**
 * Safety rules whose error rejects the file itself. In `collect` mode a file
 * carrying one is left out of the archive: it is never copied, so a
 * rejected symlink's target is not packaged. (A bundled entry point that
 * imports a rejected file can still resolve it; the archive is only scored
 * locally.)
 */
const FILE_REJECTING_SAFETY_RULES: ReadonlySet<string> = new Set([
  "hidden-file",
  "file-type",
  "symlink",
  "file-size",
  "unreadable-file",
]);

/** Result of the prepare phase, containing everything needed for push. */
export interface ExtensionPushPrepared {
  resolvedData: ExtensionPushResolvedData;
  safetyWarnings: SafetyIssue[];
  dependencyTrustResult: DependencyTrustResult;
  reviewRulesResult: ReviewRulesResult;
  /**
   * Set when the manifest declares a license that is not a valid SPDX
   * expression. A license is optional, so this never blocks a push.
   */
  licenseWarning: ManifestLicenseWarning | undefined;
  /** The `quality.yaml` sidecar beside the manifest, when one exists. */
  sidecar: { path: string; value: QualitySidecar } | undefined;
  /**
   * The findings the author declared acceptable, with any reasons. The
   * `safetyWarnings` and `reviewRulesResult.warnings` above hold only the
   * findings no acceptance covers, so the warnings gate counts those alone.
   */
  acceptances: DeclaredAcceptances;
  /** The warned lines a comment acceptance can go above, by absolute file (see {@link QualityFindings}). */
  commentSites: Record<string, CommentSites>;
  archiveBytes: Uint8Array;
  /**
   * The loaded types of `archiveBytes`, for a package cache entry to keep
   * beside the archive. Absent when the archive could not be indexed.
   */
  archiveIndex: StoredArchiveIndex | undefined;
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
   * The local gates that failed, in `collect` mode. Always empty under
   * `enforce`, where the first failure throws instead. When non-empty the
   * archive was built without the rejected files, and must be neither
   * uploaded nor cached.
   */
  gateFailures: LocalGateFailure[];
  /**
   * The files a gate rejected and the archive leaves out, in `collect` mode
   * (sorted). Always empty under `enforce`.
   */
  excludedFromArchive: string[];
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
 * private-entitlement check reports as undecided. `identity` is who the
 * same answer says the key belongs to; it names the credential in the
 * authentication verdict and never decides membership.
 */
export interface CollectiveLookup {
  collectives: string[] | undefined;
  entitlements: CollectiveEntitlement[] | undefined;
  identity?: CollectiveLookupIdentity;
}

/** Who a whoami answer says the key belongs to. */
export interface CollectiveLookupIdentity {
  username?: string;
  collectiveToken?: boolean;
  collectiveSlug?: string;
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
      readOnlyLock?: ReadOnlyLock;
      env?: Record<string, string>;
      bareImports?: readonly ResolvedBareImport[];
    },
  ) => Promise<string>;
  /** `resolver` resolves bare imports, as the bundler does. */
  extractDependencySpecifiers: (
    sourceFiles: string[],
    resolver?: BareImportResolver,
  ) => Promise<DependencySpecifier[]>;
  /**
   * Audits each dependency at the version push ships; `project` locates the
   * lockfile the bundler honours.
   */
  checkDependencyTrust: (
    specifiers: DependencySpecifier[],
    project: ExtensionProject,
  ) => Promise<DependencyTrustResult>;
  checkReviewRules: (
    input: ExtensionReviewInput,
  ) => Promise<ReviewRulesResult>;
  ensureDenoPath: () => Promise<string>;
  getDenoEnv: () => Record<string, string>;
  /**
   * Loads every source in the archive the way a consumer's install does and
   * reports the type each registers, so the collective check judges the
   * type the consumer gets, not only what the static metadata could read
   * (swamp-club#3456).
   */
  indexArchive: (
    archiveBytes: Uint8Array,
    extensionName: string,
  ) => Promise<ExtensionTreeIndex>;
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
  /** The declared SPDX license expression; omitted when none is declared. */
  license?: string;
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
    warnings?: RegistryWarnings;
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
  type RegistryWarnings,
} from "../../infrastructure/http/extension_api_client.ts";
import type { ClientIdentity } from "../../infrastructure/http/client_identity.ts";
import { findPublishedVersion } from "./published_version_lookup.ts";
import {
  analyzeExtensionSafety,
  symlinkIssue,
} from "../../domain/extensions/extension_safety_analyzer.ts";
import {
  checkExtensionQuality,
  checkUpgradeChainConsistency,
} from "../../domain/extensions/extension_quality_checker.ts";
import {
  extractDependencySpecifiers,
} from "../../domain/extensions/extension_dependency_extractor.ts";
import {
  checkDependencyTrust,
} from "../../domain/extensions/extension_dependency_trust_checker.ts";
import { checkReviewRules as checkReviewRulesImpl } from "../../domain/extensions/extension_review_rules.ts";
import {
  bundleExtension,
  type ReadOnlyLock,
} from "../../domain/models/bundle.ts";
import {
  contentFileName,
  extractContentMetadata,
} from "../../domain/extensions/extension_content_extractor.ts";
import { remediationFor } from "../../domain/extensions/extension_rule_catalog.ts";
import {
  type ArchiveFile,
  type ArgumentSchemas,
  argumentSchemas,
  detectSecretDocs,
  markdownImports,
  MAX_SECRET_DOCS_FILE_BYTES,
  MAX_SECRET_DOCS_FILES,
  SECRET_UNSAFE_DOCS_RULE,
  secretDocsTargets,
} from "@swamp-club/extension-scoring/secret-docs";
import { isAuditedCodeFile } from "@swamp-club/extension-scoring/dependency-audit";
import { parseExtensionModule } from "@swamp-club/extension-scoring/source";
import { declaresExport } from "../../domain/extensions/export_declaration.ts";
import {
  type ModelCatalogGap,
  modelCatalogGap,
} from "../../domain/extensions/model_catalog_gap.ts";
import {
  type GeneratedDeclaration,
  parseQualitySidecar,
  QUALITY_SIDECAR_FILENAME,
  type QualitySidecar,
  qualitySidecarPath,
  sidecarDirectives,
} from "../../domain/extensions/extension_quality_sidecar.ts";
import type { MissingLocalModule } from "../../domain/extensions/extension_source_graph.ts";
import {
  buildDependencyAuditRecord,
  DEPENDENCY_AUDIT_RECORD_FILENAME,
  type DependencyAuditRecord,
  serializeDependencyAuditRecord,
} from "@swamp-club/extension-scoring/dependency-audit";
import {
  type BareImportResolver,
  bareImportResolverFrom,
  type ResolvedBareImport,
} from "../../domain/extensions/bare_import_resolution.ts";
import {
  applySpecifierRewrites,
  bareImportRewrites,
  mergeSpecifierRewrites,
  planBareImports,
  type SourceArchiveKind,
  type SourceArchivePlan,
} from "../../domain/extensions/source_archive_plan.ts";
import {
  type AcceptanceDirective,
  type AcceptanceSource,
  applyAcceptances,
  commentFormFor,
  type CommentSites,
  commentSites,
  fileRelativeToManifest,
  type InvalidAcceptance,
  invalidAcceptanceFinding,
  parseAcceptanceDirectives,
  staleAcceptanceFinding,
} from "../../domain/extensions/extension_acceptances.ts";
import type {
  ExtensionAcceptance,
  ExtensionAcceptances,
} from "../../domain/extensions/extension_content.ts";
import { EmbeddedDenoRuntime } from "../../infrastructure/runtime/embedded_deno_runtime.ts";
import {
  type ExtensionProject,
  readOnlyLockFor,
  readProjectLockfile,
} from "../../infrastructure/runtime/deno_lockfile_reader.ts";
import {
  type ManifestLicenseWarning,
  manifestLicenseWarning,
} from "@swamp-club/extension-scoring/licensing";
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
        identity: {
          ...(whoami.username ? { username: whoami.username } : {}),
          ...(whoami.collectiveToken ? { collectiveToken: true } : {}),
          ...(whoami.collectiveSlug
            ? { collectiveSlug: whoami.collectiveSlug }
            : {}),
        },
      };
    },
    extractContentMetadata,
    analyzeExtensionSafety,
    checkExtensionQuality,
    extractDependencySpecifiers,
    checkDependencyTrust: async (specifiers, project) =>
      checkDependencyTrust(
        specifiers,
        fetcherFor(resolveServerUrl()) ?? globalThis.fetch,
        undefined,
        undefined,
        await readProjectLockfile(project),
      ),
    checkReviewRules: checkReviewRulesImpl,
    bundleEntryPoint: bundleExtension,
    indexArchive: (archiveBytes, extensionName) =>
      indexArchiveTree(
        archiveBytes,
        extensionName,
        (tmpRepo) =>
          createExtensionTreeIndexer({
            denoRuntime,
            repoDir: tmpRepo,
            trustShippedBundles: true,
          }),
      ),
    ensureDenoPath: () => denoRuntime.ensureDeno(),
    getDenoEnv: () => denoRuntime.getDenoEnv(),
    findPublishedVersion: async (serverUrl, name, version, apiKey) => {
      const client = new ExtensionApiClient(serverUrl, identity, {
        fetch: fetcherFor(serverUrl),
      });
      return await findPublishedVersion(client, name, version, apiKey);
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
  // Local gates: a push throws the first failure; `collect` records each one
  // and carries on to packaging, so quality can score beside them.
  const gateFailures: LocalGateFailure[] = [];
  const failGate = (gate: LocalGate, error: SwampError): void => {
    if (input.localGates !== "collect") throw error;
    gateFailures.push({
      gate,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    });
  };
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
      let identity: CollectiveLookupIdentity | undefined;
      let signedOut = false;
      let lookupFailure: string | undefined;
      try {
        const lookup = await deps.fetchCollectives(
          creds.serverUrl,
          creds.apiKey,
        );
        collectives = lookup.collectives;
        entitlements = lookup.entitlements;
        identity = lookup.identity;
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
        // The registry's answer names the account; the cached identity
        // stands in when it did not answer. A token has no username.
        const username = identity?.collectiveToken
          ? ""
          : identity?.username || creds.username;
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
            : signedInCheck({
              username,
              collectiveToken: identity?.collectiveToken,
              collectiveSlug: identity?.collectiveSlug,
              fingerprint: await keyFingerprint(creds.apiKey),
            }),
        );
        const { reserved, membership } = evaluateCollectiveMembership({
          extensionName: input.manifest.name,
          collectives,
          username,
        });
        // For reserved collectives, membership MUST be verified by the server.
        for (const check of [reserved, membership]) {
          if (check.status === "failed" && mode === "enforce") {
            throw validationFailed(check.message);
          }
        }
        // Membership nobody could settle refuses the push, as it always has.
        if (
          mode === "enforce" && membership.status === "not-run" &&
          membership.cause === "registry-unavailable"
        ) {
          throw validationFailed(
            `${membership.message} Try again when ${creds.serverUrl} is reachable.`,
          );
        }
        registryChecks.push(reserved, membership);
        // 2b. Private entitlement, from the same whoami answer. Only a
        // collective the caller belongs to has an entitlement to report, so
        // the check is omitted when membership did not pass. A whoami that
        // did not answer leaves it unasked, like authentication; an answer
        // that does not settle it (no entitlement reported for the
        // collective) is undecided, and the push lets the registry decide.
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

  // 3. Extract content metadata. A file with a symlink on its path is
  // never read: the safety gate refuses it (swamp-club#3421).
  const symlinked = input.symlinkedPaths ?? new Map<string, string>();
  const readable = symlinked.size > 0
    ? withoutFiles(input, new Set(symlinked.keys()))
    : input;
  let contentMetadata: ExtensionContentMetadata | undefined;
  try {
    // Entry points under the behaviors directory are read from it, so
    // each `fileName` is the entry point's path inside the archive's
    // models/ (swamp-club#3338).
    const behaviorEntryPoints = readable.modelEntryPoints.filter((f) =>
      modelsArchiveBase(input, f) !== readable.modelsDir
    );
    contentMetadata = await deps.extractContentMetadata(
      behaviorEntryPoints.length > 0
        ? readable.modelEntryPoints.filter((f) =>
          !behaviorEntryPoints.includes(f)
        )
        : readable.modelEntryPoints,
      readable.modelsDir,
      readable.workflowFiles,
      readable.allVaultFiles,
      readable.vaultsDir,
      readable.allDatastoreFiles,
      readable.datastoresDir,
      readable.allReportFiles,
      readable.reportsDir,
      readable.allWebhookFiles,
      readable.webhooksDir,
    );
    if (behaviorEntryPoints.length > 0) {
      const fromBehaviors = await deps.extractContentMetadata(
        behaviorEntryPoints,
        readable.behaviorsDir!,
        [],
        [],
        "",
        [],
        "",
        [],
        "",
        [],
        "",
      );
      contentMetadata = {
        ...contentMetadata,
        models: [...contentMetadata.models, ...fromBehaviors.models],
        extensions: [
          ...contentMetadata.extensions,
          ...fromBehaviors.extensions,
        ],
      };
    }
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
      failGate(
        "content-collectives",
        validationFailed(
          CONTENT_COLLECTIVES_MESSAGE,
          {
            expectedCollective,
            mismatches: collectiveResult.mismatches,
          },
        ),
      );
    }
  }

  // 6a. Pre-check additionalFiles against the extension allowlist so the
  // error can name the manifest field and suggest `binaries`.
  // Files a gate rejected; in `collect` mode they are left out of the archive.
  const rejectedFiles = new Set<string>();
  for (const file of input.additionalFilePaths) {
    const ext = extname(file).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext) && !LEGAL_BASENAMES.has(basename(file))) {
      const rel = relative(input.repoDir, file);
      rejectedFiles.add(file);
      failGate(
        "additional-files",
        validationFailed(
          `File "${rel}" in additionalFiles has extension "${ext}" which is not allowed. ` +
            `Allowed extensions for additionalFiles: ${
              [...ALLOWED_EXTENSIONS].join(", ")
            }. ` +
            `If this is an executable or binary file, move it to the \`binaries\` field in manifest.yaml instead.`,
        ),
      );
    }
  }

  // 6a2. The quality sidecar beside the manifest. Read and validated here so
  // a malformed one blocks like a malformed manifest, before any gate runs.
  const sidecar = await readQualitySidecar(input.manifestDir);

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
    ...Object.values(input.dataFilesByKind ?? {}).flat(),
    ...input.includeFilePaths,
    ...input.binaryFilePaths,
    ...(sidecar ? [sidecar.path] : []),
  ];
  const binaryExemptSet = new Set(input.binaryFilePaths);
  // A file with a symlink on its path is refused by the symlink rule
  // without being stat'd or read; the analyzer sees the rest
  // (swamp-club#3421).
  const analyzed = await deps.analyzeExtensionSafety(
    allFiles.filter((file) => !symlinked.has(file)),
    binaryExemptSet,
  );
  const safetyResult = {
    ...analyzed,
    errors: [
      ...[...symlinked].map(([file, link]) => symlinkIssue(file, link)),
      ...analyzed.errors,
    ],
  };

  if (safetyResult.errors.length > 0) {
    for (const issue of safetyResult.errors) {
      if (FILE_REJECTING_SAFETY_RULES.has(issue.ruleId)) {
        rejectedFiles.add(issue.file);
      }
    }
    failGate(
      "safety",
      validationFailed(
        "Extension has safety errors that must be resolved before pushing.",
        { safetyErrors: safetyResult.errors },
      ),
    );
  }

  // 6b2. Every code file the archive ships must parse: push and the
  // registry read its imports from its syntax tree, so a module that does
  // not parse has no imports to audit or rewrite (swamp-club#3983). Such a
  // module is missing from the source plan, which `deno info` builds:
  // `deno info` reports it as a module it cannot load.
  const unparsed: string[] = [];
  const codeFiles = new Set([
    ...auditedCodeFiles(input),
    ...(input.missingModules ?? []).map((m) => m.path).filter((path) =>
      isAuditedCodeFile(path.replaceAll("\\", "/"))
    ),
  ]);
  for (const file of codeFiles) {
    if (rejectedFiles.has(file) || symlinked.has(file)) continue;
    let source: string;
    try {
      source = await Deno.readTextFile(file);
    } catch {
      continue;
    }
    const parsed = parseExtensionModule(source, { path: file });
    if (!parsed.ok) {
      rejectedFiles.add(file);
      unparsed.push(
        `Cannot read the imports of ${
          relative(input.repoDir, file)
        }: it does not parse (${parsed.reason}). Fix the syntax error and try again.`,
      );
    }
  }
  if (unparsed.length > 0) {
    failGate("source-syntax", validationFailed(unparsed.join("\n")));
  }

  // 6c. A file a check rejected (only `collect` mode gets this far with
  // one) is left out of every later gate as well as the archive: fmt, lint
  // and review read a symlink's target and would quote it (swamp-club#3420).
  const gated = rejectedFiles.size > 0
    ? withoutFiles(input, rejectedFiles)
    : input;
  const notRejected = (file: string) => !rejectedFiles.has(file);

  // 7. Dependency trust audit
  let dependencyTrustResult: DependencyTrustResult;
  const sourceFiles = auditedCodeFiles(gated);
  const specifiers = await deps.extractDependencySpecifiers(
    sourceFiles,
    bareImportResolverFor(input),
  );
  if (specifiers.length > 0) {
    ctx.logger.debug`Auditing ${specifiers.length} dependency specifier(s)`;
    dependencyTrustResult = await deps.checkDependencyTrust(specifiers, {
      denoConfigPath: input.denoConfigPath,
      packageJsonDir: input.packageJsonDir,
    });
    if (dependencyTrustResult.errors.length > 0) {
      failGate(
        "dependency-trust",
        validationFailed(
          "Extension has dependency trust errors that must be resolved before pushing.",
          { dependencyTrustErrors: dependencyTrustResult.errors },
        ),
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
  if (gated.skillDirs.length > 0) {
    const skillResult = await validateExtensionSkills(gated.skillDirs);
    if (skillResult.errors.length > 0) {
      failGate(
        "skills",
        validationFailed(
          "Extension has skill validation errors:\n" +
            skillResult.errors.map((e) => `  ${e.skill}: ${e.message}`).join(
              "\n",
            ),
        ),
      );
    }

    // Populate skill metadata for registry
    if (contentMetadata) {
      const skillsByName = new Map(
        skillResult.skills.map((s) => [s.name, s]),
      );
      contentMetadata.skills = gated.skillDirs.map((s) => {
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
      qualityFiles.filter(notRejected),
      denoPath,
      input.denoConfigPath,
      deps.getDenoEnv(),
    );
    if (!qualityResult.passed) {
      failGate(
        "fmt-lint",
        validationFailed(
          "Extension has formatting or lint issues. Run 'swamp extension fmt <manifest-path>' to fix.",
          { qualityErrors: qualityResult.issues },
        ),
      );
    }
  }

  // 10a. Upgrade chain consistency — validate that each model's upgrade
  // chain terminates at its declared version. Always runs (not gated on
  // cache hit) since it's a fast file read.
  const upgradeChainIssues = await checkUpgradeChainConsistency(
    gated.allModelFiles,
  );
  if (upgradeChainIssues.length > 0) {
    failGate(
      "upgrade-chain",
      validationFailed(
        "Extension has behavior upgrade chain errors that must be resolved before pushing.",
        { upgradeChainErrors: upgradeChainIssues },
      ),
    );
  }

  // 10b. Review, bare specifiers and declared acceptances — one pass shared
  // with `swamp extension quality`, after the mechanical gates (safety,
  // deps, fmt) so those fire first.
  const findings = await runQualityFindings(ctx, deps, {
    input: gated,
    sidecar,
    safetyWarnings: safetyResult.warnings,
    files: allFiles.filter(notRejected),
    ...(contentMetadata
      ? { argumentSchemas: argumentSchemas(contentMetadata) }
      : {}),
  });
  const reviewRulesResult = findings.reviewRulesResult;
  if (reviewRulesResult.errors.length > 0) {
    failGate(
      "review",
      validationFailed(
        "Extension review found issues that must be resolved before pushing.",
        { reviewRuleErrors: reviewRulesResult.errors },
      ),
    );
  }
  if (
    contentMetadata &&
    (findings.acceptances.accepted.length > 0 ||
      findings.acceptances.generated)
  ) {
    contentMetadata.acceptances = toContentMetadataAcceptances(
      findings.acceptances,
    );
  }

  // 11a. A missing local module fails the push as a compilation error, the
  // way the bundler reported it before push read the module graph
  // (swamp-club#3376); models that are never bundled are covered too. A
  // module a gate rejected is reported by that gate (a file that does not
  // parse reads to `deno info` as a module it cannot load).
  const missingModules = (input.missingModules ?? []).filter((m) =>
    notRejected(m.path)
  );
  if (missingModules.length > 0) {
    throw validationFailed(
      "Bundle compilation failed. Fix the errors above and try again.",
      {
        compilationErrors: missingModules.map((m) => ({
          file: m.importer ?? m.path,
          error: m.reason,
        })),
      },
    );
  }

  // 11. Bundle entry points + build archive — skip on cache hit, unless a
  // check rejected files: the cached archive was built before the rejection
  // and may hold them, so collect mode rebuilds without them.
  let totalBundles: number;
  let archiveBytes: Uint8Array;
  const archiveFromCache = usingCachedArchive && rejectedFiles.size === 0;
  if (archiveFromCache) {
    totalBundles = input.modelEntryPoints.length +
      input.vaultEntryPoints.length +
      input.datastoreEntryPoints.length + input.reportEntryPoints.length +
      input.webhookEntryPoints.length;
    archiveBytes = input.cachedArchive!;
  } else {
    const built = await bundleAndArchive(
      withoutEntryPoints(gated, input.entryPointsReachingSymlinks ?? []),
      deps,
      denoPath || await deps.ensureDenoPath(),
      ctx,
      buildDependencyAuditRecord(dependencyTrustResult.shipped ?? []),
    );
    totalBundles = built.totalBundles;
    archiveBytes = built.archiveBytes;
  }
  // Same compressed limit pull enforces, so consumers can download what is
  // pushed. The decompressed limit is enforced at install only.
  if (archiveBytes.byteLength > MAX_EXTENSION_ARCHIVE_BYTES) {
    failGate(
      "archive-size",
      validationFailed(
        `Extension archive is ${
          formatArchiveBytes(archiveBytes.byteLength)
        }, over the ${
          formatArchiveBytes(MAX_EXTENSION_ARCHIVE_BYTES)
        } archive size limit. Reduce bundled dependencies or binaries.`,
      ),
    );
  }

  // 11a. Load the archive's sources the way a consumer's install will, and
  // check the types they register against the collective too: the static
  // metadata reads only string-literal types, so a type in a constant, a
  // spread or a helper file would otherwise go unchecked (swamp-club#3456).
  let runtimeIndex: ExtensionTreeIndex | undefined =
    archiveFromCache && input.cachedArchiveIndex
      ? fromStoredArchiveIndex(input.cachedArchiveIndex)
      : undefined;
  if (!runtimeIndex) {
    try {
      runtimeIndex = await deps.indexArchive(
        archiveBytes,
        input.manifest.name,
      );
    } catch (error) {
      ctx.logger
        .warn`Could not load the archive's sources to check their collective: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }
  const runtimeMismatches = runtimeIndex
    ? newRuntimeMismatches(
      collectiveMismatchesForTypes(
        input.manifest.name,
        runtimeContentTypes(runtimeIndex),
      ),
      contentMetadata,
      input.manifest.name,
    )
    : [];
  if (runtimeMismatches.length > 0) {
    const expectedCollective = input.manifest.name.slice(
      0,
      input.manifest.name.indexOf("/") + 1,
    );
    // In collect mode a static mismatch has already recorded the gate; the
    // loaded types join it, so quality reports the gate once.
    const recorded = gateFailures.find((f) => f.gate === "content-collectives");
    const recordedDetails = recorded?.details as
      | { mismatches?: CollectiveMismatch[] }
      | undefined;
    if (recordedDetails?.mismatches) {
      for (const m of runtimeMismatches) recordedDetails.mismatches.push(m);
    } else {
      failGate(
        "content-collectives",
        validationFailed(CONTENT_COLLECTIVES_MESSAGE, {
          expectedCollective,
          mismatches: runtimeMismatches,
        }),
      );
    }
  }
  for (
    const warning of unverifiedCollectiveWarnings(
      input,
      contentMetadata,
      runtimeIndex,
    )
  ) {
    reviewRulesResult.warnings.push(warning);
  }

  // 5. Build resolved data, with each type the static metadata could not
  // read taken from the loaded source rather than shown as its file path.
  const resolvedData = buildResolvedData(
    input,
    contentMetadata,
    runtimeIndex,
  );

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
          requestedChannel: input.channel,
        });
        if (check.status === "failed" && mode === "enforce") {
          throw validationFailed(check.message, {
            existingVersion: input.manifest.version,
            existingChannel: check.existingChannel,
            requestedChannel: check.requestedChannel,
            ...(check.existingYanked
              ? {
                existingYanked: true,
                existingYankReason: check.existingYankReason,
              }
              : {}),
          });
        }
        registryChecks.push(check);
      }
    }
  }

  return {
    resolvedData,
    safetyWarnings: findings.safetyWarnings,
    dependencyTrustResult,
    reviewRulesResult,
    licenseWarning: manifestLicenseWarning(input.manifest.license),
    sidecar,
    acceptances: findings.acceptances,
    commentSites: findings.commentSites,
    archiveBytes,
    archiveIndex: runtimeIndex ? toStoredArchiveIndex(runtimeIndex) : undefined,
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
    gateFailures,
    excludedFromArchive: [...rejectedFiles].sort(),
  };
}

/**
 * The prepare input with `rejected` files left out of every list the archive
 * is built from. `additionalFiles` / `additionalFilePaths` and `binaries` /
 * `binaryFilePaths` are parallel arrays, so each pair is filtered in
 * lockstep. Used only in `collect` mode.
 */
/**
 * The input without `entryPoints` among its entry points, so they are not
 * bundled; their sources are still packaged.
 */
function withoutEntryPoints(
  input: ExtensionPushPrepareInput,
  entryPoints: readonly string[],
): ExtensionPushPrepareInput {
  if (entryPoints.length === 0) return input;
  const keep = (f: string) => !entryPoints.includes(f);
  return {
    ...input,
    modelEntryPoints: input.modelEntryPoints.filter(keep),
    vaultEntryPoints: input.vaultEntryPoints.filter(keep),
    datastoreEntryPoints: input.datastoreEntryPoints.filter(keep),
    reportEntryPoints: input.reportEntryPoints.filter(keep),
    webhookEntryPoints: input.webhookEntryPoints.filter(keep),
  };
}

function withoutFiles(
  input: ExtensionPushPrepareInput,
  rejected: ReadonlySet<string>,
): ExtensionPushPrepareInput {
  const keep = (f: string) => !rejected.has(f);
  const additional = input.additionalFilePaths
    .map((path, i) => ({ path, rel: input.manifest.additionalFiles[i] }))
    .filter((e) => keep(e.path));
  const binaries = input.binaryFilePaths
    .map((path, i) => ({ path, rel: input.manifest.binaries[i] }))
    .filter((e) => keep(e.path));
  return {
    ...input,
    manifest: {
      ...input.manifest,
      additionalFiles: additional.map((e) => e.rel),
      binaries: binaries.map((e) => e.rel),
    },
    allModelFiles: input.allModelFiles.filter(keep),
    modelEntryPoints: input.modelEntryPoints.filter(keep),
    allVaultFiles: input.allVaultFiles.filter(keep),
    vaultEntryPoints: input.vaultEntryPoints.filter(keep),
    allDatastoreFiles: input.allDatastoreFiles.filter(keep),
    datastoreEntryPoints: input.datastoreEntryPoints.filter(keep),
    allReportFiles: input.allReportFiles.filter(keep),
    reportEntryPoints: input.reportEntryPoints.filter(keep),
    allWebhookFiles: input.allWebhookFiles.filter(keep),
    webhookEntryPoints: input.webhookEntryPoints.filter(keep),
    workflowFiles: input.workflowFiles.filter((wf) => keep(wf.sourcePath)),
    // A skill directory holding a rejected path (a symlink inside it, or
    // the directory itself) goes with it.
    skillDirs: input.skillDirs.filter((d) =>
      ![...rejected].some((f) =>
        f === d.absolutePath || f.startsWith(d.absolutePath + SEPARATOR)
      )
    ),
    allSkillFiles: input.allSkillFiles.filter(keep),
    includeFilePaths: input.includeFilePaths.filter(keep),
    additionalFilePaths: additional.map((e) => e.path),
    binaryFilePaths: binaries.map((e) => e.path),
    ...(input.dataFilesByKind
      ? {
        dataFilesByKind: Object.fromEntries(
          Object.entries(input.dataFilesByKind).map((
            [kind, files],
          ) => [kind, files.filter(keep)]),
        ),
      }
      : {}),
    sourcePlan: {
      entries: input.sourcePlan.entries.filter((e) => keep(e.sourcePath)),
    },
  };
}

const NO_CREDENTIALS_REASON =
  "no credentials; run 'swamp auth login' to sign in";
const AUTH_FAILED_REASON = "authentication failed";

function isNotAuthenticatedError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as SwampError).code === "not_authenticated";
}

// ── Quality findings (shared with `swamp extension quality`) ─────────

/** One declared acceptance, as the summaries and the registry see it. */
export interface DeclaredAcceptance {
  ruleId: string;
  /**
   * The file relative to the manifest's directory (forward slashes, a
   * `../` path for a typed directory beside it); absent for
   * extension-scoped rules.
   */
  file?: string;
  /**
   * The file's path inside the archive (`models/x.ts`, `vaults/v.ts`,
   * `files/README.md`), which is what the registry receives; absent when
   * the file is not packaged under a known directory.
   */
  archivePath?: string;
  line?: number;
  /** The author's reason; absent when they gave none. */
  reason?: string;
  source: AcceptanceSource;
  /** The accepted finding's message. */
  message: string;
}

/** Everything the author declared acceptable in this run. */
export interface DeclaredAcceptances {
  accepted: DeclaredAcceptance[];
  /** The generated declaration from the quality sidecar, when present. */
  generated?: GeneratedDeclaration;
}

/** The warning-level findings of a run after acceptances are applied. */
export interface QualityFindings {
  /** Safety warnings no acceptance covers. */
  safetyWarnings: SafetyIssue[];
  /**
   * Review findings: `warnings` holds those no acceptance covers plus one
   * stale-acceptance warning per directive that matched nothing; `errors`
   * holds invalid acceptances and any blocking review finding.
   */
  reviewRulesResult: ReviewRulesResult;
  acceptances: DeclaredAcceptances;
  /**
   * The warned lines a comment acceptance can go above, with their
   * indentation, by absolute file; the findings report offers no comment
   * acceptance on any other line.
   */
  commentSites: Record<string, CommentSites>;
}

/** Input to {@link runQualityFindings}. */
export interface QualityFindingsInput {
  input: ExtensionPushPrepareInput;
  /** The parsed sidecar, from {@link readQualitySidecar}. */
  sidecar: { path: string; value: QualitySidecar } | undefined;
  /** The safety analyzer's warnings for `files`. */
  safetyWarnings: SafetyIssue[];
  /** Every file the extension packages; directives are read from those with a comment form. */
  files: string[];
  /** The extension's declared and sensitive argument names, for the secret-unsafe-docs check. */
  argumentSchemas?: ArgumentSchemas;
}

/**
 * How push resolves the bare imports `input`'s modules write: as Deno
 * resolved them under the project's Deno config, read from the module
 * graph (swamp-club#3612), or in a package.json project to the package
 * installed in node_modules (swamp-club#3630); without either, not at all,
 * so each ships as written.
 */
export function bareImportResolverFor(
  input: {
    denoConfigPath?: string;
    packageJsonDir?: string;
    bareImports?: ResolvedBareImport[];
  },
): BareImportResolver | undefined {
  return input.denoConfigPath || input.packageJsonDir
    ? bareImportResolverFrom(input.bareImports ?? [])
    : undefined;
}

/**
 * The bare-specifiers finding's message: which bare imports ship as
 * written, why the registry cannot score its documentation because of them,
 * and what lets push rewrite them (swamp-club#3637).
 */
export function bareSpecifiersMessage(names: string[]): string {
  return "Extension has bare imports that ship as written, which the " +
    "registry's scorer cannot resolve, so it would score the documentation " +
    "factors 0: " +
    `${names.map((n) => JSON.stringify(n)).join(", ")}. Push rewrites a ` +
    "bare import only when the project's Deno config (deno.json or " +
    "deno.jsonc imports, an importMap file, a scope covering the module, " +
    "or a workspace root's imports) resolves it to an npm:, jsr:, node: or " +
    "URL specifier, or, with no Deno config, when package.json declares it " +
    "as an npm registry dependency installed in node_modules; add such an " +
    "entry or dependency for each, or write the specifier in its place.";
}

/**
 * The uncatalogued-model finding's message: what push could not read from
 * the model export, and that the registry will not list the model although
 * it still installs and runs.
 */
function uncataloguedModelMessage(
  gap: ModelCatalogGap,
  exportName: "model" | "behavior" = "model",
): string {
  const cause = gap.kind === "not-plain-object"
    ? gap.annotated
      ? "Behavior export has a type annotation, so it is not read as a plain " +
        `export const ${exportName} = { ... } object`
      : `Behavior export is not a plain export const ${exportName} = { ... } ` +
        "object literal"
    : gap.missing.length === 2
    ? "Behavior export has neither a string-literal type nor a string-literal " +
      `version in its export const ${exportName} object`
    : `Behavior export has no string-literal ${
      gap.missing[0]
    } in its export const ${exportName} object`;
  return `${cause}, so the registry catalog will not list this behavior type. ` +
    "The extension still installs and the behavior still runs.";
}

/**
 * The name a model entry point's export is spelled with: `behavior` when
 * the source declares `export const behavior` and no `export const model`
 * (swamp-club#3338), else `model`.
 */
function exportNameOf(source: string): "model" | "behavior" {
  return !declaresExport(source, /export\s+const\s+model\s*[=:]/) &&
      declaresExport(source, /export\s+const\s+behavior\s*[=:]/)
    ? "behavior"
    : "model";
}

/**
 * Where the extension uses the behavior spelling (swamp-club#3338): the
 * `behaviors:` manifest key, the behaviors directory, and entry points
 * exporting `behavior`. Empty for a model-spelled extension.
 */
async function behaviorSpellingUses(
  input: ExtensionPushPrepareInput,
): Promise<string[]> {
  const uses: string[] = [];
  if (input.manifest.modelsKey === "behaviors") {
    uses.push("the behaviors: manifest key");
  }
  if (
    input.allModelFiles.some((f) =>
      modelsArchiveBase(input, f) !== input.modelsDir
    )
  ) {
    uses.push("the extensions/behaviors/ directory");
  }
  let behaviorExports = 0;
  for (const file of input.modelEntryPoints) {
    try {
      if (exportNameOf(await Deno.readTextFile(file)) === "behavior") {
        behaviorExports++;
      }
    } catch {
      // Unreadable — the other gates report it.
    }
  }
  if (behaviorExports > 0) {
    uses.push(
      `export const behavior in ${behaviorExports} entry point${
        behaviorExports === 1 ? "" : "s"
      }`,
    );
  }
  return uses;
}

/**
 * The secret-unsafe-docs findings, over the files the shared selector picks
 * from the archive push builds (swamp-club#3781): Markdown that is not a
 * binary, an include file or data a module imports, the describe and
 * description strings of every code module, and the manifest's parsed
 * description. Findings are reported at the author's own files and lines.
 * Symlinks are never read. Documentation a cap leaves unread is reported
 * as one finding no acceptance can cover, since the registry fails the
 * factor while any is unchecked.
 */
async function secretUnsafeDocs(
  input: ExtensionPushPrepareInput,
  files: string[],
  schemas: ArgumentSchemas | undefined,
): Promise<ReviewFinding[]> {
  const candidates = new Set([
    ...files,
    ...input.sourcePlan.entries.map((e) => e.sourcePath),
  ]);
  const authorOf = new Map<string, string>();
  const listing: ArchiveFile[] = [];
  for (const file of candidates) {
    const archivePath = archivePathFor(input, file);
    if (archivePath === undefined || authorOf.has(archivePath)) continue;
    let size: number;
    try {
      const info = await Deno.lstat(file);
      if (info.isSymlink || !info.isFile) continue;
      size = info.size;
    } catch {
      continue;
    }
    authorOf.set(archivePath, file);
    listing.push({ path: archivePath, size });
  }

  const importedMarkdown = new Set<string>();
  for (const { path } of listing) {
    if (!isAuditedCodeFile(path)) continue;
    const content = await readUnlessSymlink(authorOf.get(path)!);
    if (content === undefined) continue;
    for (const md of markdownImports(path, content)) importedMarkdown.add(md);
  }
  const { targets, unread } = secretDocsTargets(
    listing,
    input.manifest,
    importedMarkdown,
  );

  const findings: ReviewFinding[] = [];
  const report = (file: string, line: number, message: string) =>
    findings.push({
      ruleId: SECRET_UNSAFE_DOCS_RULE,
      dimension: "Credentials & Secrets",
      severity: "medium",
      file,
      line,
      message,
      remediation: remediationFor("secret-unsafe-docs"),
    });

  for (const { path, form } of targets) {
    const file = authorOf.get(path)!;
    const content = await readUnlessSymlink(file);
    if (content === undefined) continue;
    for (const f of detectSecretDocs(content, form, schemas)) {
      report(file, f.line, f.message);
    }
  }

  // The parsed description, as the registry reads it: a YAML comment or an
  // escape is never documentation. Its findings all sit on the description
  // line, so accepting that line accepts them all, as the registry's
  // fileless description acceptance does.
  const description = input.manifest.description;
  if (typeof description === "string" && description.length > 0) {
    const manifestPath = input.manifestPath ??
      join(input.manifestDir, "manifest.yaml");
    const manifestText = await readUnlessSymlink(manifestPath);
    const keyLine = manifestText === undefined ? 1 : Math.max(
      1,
      manifestText.split("\n").findIndex((l) =>
        /^["']?description["']?\s*:/.test(l)
      ) + 1,
    );
    for (const f of detectSecretDocs(description, "plain", schemas)) {
      report(
        manifestPath,
        keyLine,
        f.message.replace(/^Line \d+/, `Line ${keyLine} (description)`),
      );
    }
  }
  if (unread.length > 0) {
    findings.push({
      ruleId: SECRET_UNSAFE_DOCS_RULE,
      dimension: "Credentials & Secrets",
      severity: "medium",
      file: "(extension)",
      message:
        `Documentation not checked for secrets: ${
          unread.slice(0, 3).join(", ")
        }${unread.length > 3 ? ` and ${unread.length - 3} more` : ""}. ` +
        `Files over ${MAX_SECRET_DOCS_FILE_BYTES / (1024 * 1024)} MiB, or ` +
        `past ${MAX_SECRET_DOCS_FILES} files, are not read, and the ` +
        "registry scores unchecked documentation as unsafe.",
      remediation: "Split or shrink the listed files.",
    });
  }
  return findings;
}

/** A file's text, or undefined when it is a symlink or cannot be read. */
async function readUnlessSymlink(file: string): Promise<string | undefined> {
  try {
    if ((await Deno.lstat(file)).isSymlink) return undefined;
    return await Deno.readTextFile(file);
  } catch {
    return undefined;
  }
}

/**
 * Runs the review rules, the bare-specifier check, the uncatalogued-model
 * check and the declared acceptances over an extension. Push calls it from
 * prepare; quality calls it on every run, including a cache hit, so both
 * report the same findings and the same acceptances for the same source.
 */
export async function runQualityFindings(
  ctx: LibSwampContext,
  deps: Pick<ExtensionPushPrepareDeps, "checkReviewRules">,
  { input, sidecar, safetyWarnings, files, argumentSchemas: schemas }:
    QualityFindingsInput,
): Promise<QualityFindings> {
  // Static review rules, plus the adversarial-review report when the caller
  // computed a content hash. Report findings are warnings: a missing or
  // stale report surfaces the "continue despite warnings?" prompt rather
  // than a hard block, so a benign version bump nudges the reviewer instead
  // of bricking the push.
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

  // Bare imports that ship as written: the server-side scorer cannot
  // resolve them (it strips deno.json and writes a controlled one). Push
  // rewrites the ones Deno resolves under the project config
  // (swamp-club#3637, #3612) or to an installed package.json dependency
  // (swamp-club#3630), so only the rest count; without either, every bare
  // import does.
  const sourceFiles = [
    ...input.allModelFiles,
    ...input.allVaultFiles,
    ...input.allDatastoreFiles,
    ...input.allReportFiles,
    ...input.allWebhookFiles,
  ];
  const resolver = bareImportResolverFor(input);
  const bareSpecifiers = new Set<string>();
  for (const file of sourceFiles) {
    try {
      const src = await Deno.readTextFile(file);
      for (
        const name of planBareImports(src, resolver, file).shippedAsWritten
      ) {
        bareSpecifiers.add(name);
      }
    } catch {
      // File unreadable — skip.
    }
  }
  if (bareSpecifiers.size > 0) {
    reviewRulesResult.warnings.push({
      ruleId: "bare-specifiers",
      dimension: "scoring",
      severity: "medium",
      file: "(multiple files)",
      message: bareSpecifiersMessage([...bareSpecifiers].sort()),
      remediation: remediationFor("bare-specifiers"),
    });
  }

  // Uncatalogued models: an entry point whose type or version the push
  // metadata cannot read is shipped in the archive but left out of the
  // registry catalog, so say so per file (swamp-club#2486).
  for (const file of input.modelEntryPoints) {
    let src: string;
    try {
      src = await Deno.readTextFile(file);
    } catch {
      continue;
    }
    const gap = modelCatalogGap(src);
    if (gap) {
      reviewRulesResult.warnings.push({
        ruleId: "uncatalogued-model",
        dimension: "Registry catalog",
        severity: "medium",
        file,
        message: uncataloguedModelMessage(gap, exportNameOf(src)),
        remediation: remediationFor("uncatalogued-model"),
      });
    }
  }

  // Behavior spelling: an extension written with the behavior export,
  // directory or manifest key loads only on this release and later, so say
  // so once (swamp-club#3338).
  const behaviorSpelling = await behaviorSpellingUses(input);
  if (behaviorSpelling.length > 0) {
    reviewRulesResult.warnings.push({
      ruleId: "behavior-spelling",
      dimension: "Compatibility",
      severity: "medium",
      file: "(extension)",
      message:
        `Extension uses the behavior spelling (${
          behaviorSpelling.join(", ")
        }). swamp clients and workers older than this release cannot load ` +
        "it: they read only export const model, extensions/models/ and the " +
        "models: manifest key.",
      remediation: remediationFor("behavior-spelling"),
    });
  }

  // Docs that put a secret in plaintext or reference a vault with syntax
  // swamp does not support (swamp-club#3757).
  for (const finding of await secretUnsafeDocs(input, files, schemas)) {
    reviewRulesResult.warnings.push(finding);
  }

  // Declared acceptances: inline directives from every packaged file with a
  // comment form, and the sidecar's entries.
  const directives: AcceptanceDirective[] = [];
  const invalid: InvalidAcceptance[] = [];
  // The warned lines of each file, where the report may offer a comment.
  const warned = new Map<string, number[]>();
  for (const w of [...safetyWarnings, ...reviewRulesResult.warnings]) {
    if (w.line !== undefined) {
      warned.set(w.file, [...warned.get(w.file) ?? [], w.line]);
    }
  }
  const commentSitesByFile: Record<string, CommentSites> = {};
  for (const file of files) {
    if (commentFormFor(file) === "none") continue;
    let content: string;
    try {
      content = await Deno.readTextFile(file);
    } catch {
      continue;
    }
    const warnedLines = warned.get(file);
    if (warnedLines) {
      const sites = commentSites(content, file, warnedLines);
      // A Markdown line no comment can go above (inside a fenced code block)
      // is accepted by a quality.yaml entry naming its line. A comment
      // inserted elsewhere in the same file would move that line, so the
      // whole file then takes line entries and is never edited
      // (swamp-club#3757).
      const barrier = commentFormFor(file) === "html" &&
        warnedLines.some((line) => sites[line] === undefined);
      commentSitesByFile[file] = barrier ? {} : sites;
    }
    const parsed = parseAcceptanceDirectives(content, file);
    for (const d of parsed.directives) directives.push(d);
    for (const i of parsed.invalid) invalid.push(i);
  }
  if (sidecar) {
    const parsed = sidecarDirectives(
      sidecar.value,
      sidecar.path,
      input.manifestDir,
    );
    for (const d of parsed.directives) directives.push(d);
    for (const i of parsed.invalid) invalid.push(i);
  }
  ctx.logger
    .debug`Declared acceptances: ${directives.length} directive(s), ${invalid.length} invalid`;

  const applied = applyAcceptances(
    [...safetyWarnings, ...reviewRulesResult.warnings],
    directives,
  );
  // Unread documentation is unknown, not accepted: no directive covers it.
  const unread = applied.accepted.filter((a) =>
    a.finding.ruleId === SECRET_UNSAFE_DOCS_RULE &&
    a.finding.file === "(extension)"
  );
  if (unread.length > 0) {
    applied.accepted = applied.accepted.filter((a) => !unread.includes(a));
    for (const a of unread) applied.remaining.push(a.finding);
  }
  const remainingSafety: SafetyIssue[] = [];
  const remainingReview: ReviewFinding[] = [];
  for (const finding of applied.remaining) {
    if (isReviewFinding(finding)) remainingReview.push(finding);
    else remainingSafety.push(finding);
  }
  for (const stale of applied.stale) {
    remainingReview.push(staleAcceptanceFinding(stale));
  }
  const errors = [
    ...reviewRulesResult.errors,
    ...invalid.map(invalidAcceptanceFinding),
  ];

  const accepted: DeclaredAcceptance[] = applied.accepted.map((a) => {
    const archivePath = archivePathFor(input, a.finding.file);
    return {
      ruleId: a.finding.ruleId,
      ...(a.finding.file.startsWith("(") ? {} : {
        file: fileRelativeToManifest(
          input.manifestDir,
          a.finding.file,
          input.repoDir,
        ),
      }),
      ...(archivePath !== undefined ? { archivePath } : {}),
      ...(a.finding.line !== undefined ? { line: a.finding.line } : {}),
      ...(a.reason !== undefined ? { reason: a.reason } : {}),
      source: a.source,
      message: a.finding.message,
    };
  });

  return {
    safetyWarnings: remainingSafety,
    reviewRulesResult: {
      errors,
      warnings: collapseTestingCompleteness(remainingReview, input),
      passed: errors.length === 0,
    },
    acceptances: {
      accepted,
      ...(sidecar?.value.generated
        ? { generated: sidecar.value.generated }
        : {}),
    },
    commentSites: commentSitesByFile,
  };
}

function isReviewFinding(
  finding: SafetyIssue | ReviewFinding,
): finding is ReviewFinding {
  return "dimension" in finding;
}

const TESTING_COMPLETENESS_LISTED = 5;

/**
 * Collapses the per-file testing-completeness findings that survive the
 * acceptances into one finding per extension ("N of M entry points have no
 * sibling test"), carrying the remaining files so each can still be
 * accepted on its own. Every other finding passes through unchanged.
 */
function collapseTestingCompleteness(
  warnings: ReviewFinding[],
  input: ExtensionPushPrepareInput,
): ReviewFinding[] {
  const untested = warnings.filter((w) => w.ruleId === "testing-completeness");
  if (untested.length <= 1) return warnings;
  const rest = warnings.filter((w) => w.ruleId !== "testing-completeness");
  const files = untested.map((w) => w.file);
  const total = input.modelEntryPoints.length + input.vaultEntryPoints.length +
    input.datastoreEntryPoints.length + input.reportEntryPoints.length +
    input.webhookEntryPoints.length;
  const listed = files.slice(0, TESTING_COMPLETENESS_LISTED).map((f) =>
    fileRelativeToManifest(input.manifestDir, f, input.repoDir)
  );
  const more = files.length - listed.length;
  const first = untested[0];
  return [
    ...rest,
    {
      ruleId: "testing-completeness",
      dimension: first.dimension,
      severity: first.severity,
      file: `(${files.length} files)`,
      message:
        `${files.length} of ${total} entry points have no sibling \`_test.ts\`: ${
          listed.join(", ")
        }${
          more > 0 ? `, and ${more} more` : ""
        }. Cover success and failure paths with unit tests before publishing.`,
      ...(first.remediation ? { remediation: first.remediation } : {}),
      files,
    },
  ];
}

/** True when `file` is `dir` itself or lies under it. */
function isWithin(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return !(rel === ".." || rel.startsWith(".." + SEPARATOR) ||
    isAbsolute(rel));
}

/**
 * The directory a model source or include file is packed from: the
 * behaviors directory for a file under it, else the models directory
 * (swamp-club#3338). The file lands at `models/<path from that directory>`,
 * so a behavior-spelled extension's archive matches its model-spelled
 * twin's and never holds a `models/../behaviors/` path.
 */
function modelsArchiveBase(
  input: Pick<ExtensionPushPrepareInput, "modelsDir" | "behaviorsDir">,
  file: string,
): string {
  return input.behaviorsDir !== undefined &&
      input.behaviorsDir !== input.modelsDir &&
      isWithin(input.behaviorsDir, file)
    ? input.behaviorsDir
    : input.modelsDir;
}

/**
 * Refuses a source plan whose archive pull would refuse to install
 * (swamp-club#3384): a shared module packed at a path pull's entry rules
 * reject, such as a `deno.json` imported from one level above a kind's
 * directory. Publishing it would ship a version nobody can pull.
 */
function assertPullInstallsSourcePlan(input: ExtensionPushPrepareInput): void {
  for (const entry of input.sourcePlan.entries) {
    const refusal = archiveEntryRefusal({
      path: `extension/${entry.archivePath}`,
      kind: "file",
    });
    if (refusal) {
      throw validationFailed(
        `Extension pull would refuse this archive: ${refusal.path} ` +
          `${refusal.reason}. It is packed from ${entry.sourcePath}; move ` +
          "or rename the module, or import it from inside the kind's " +
          "directory.",
        { archivePath: entry.archivePath, files: [entry.sourcePath] },
      );
    }
  }
}

/**
 * Refuses two model sources or include files that would be packed at the
 * same `models/` path, one from the models directory and one from the
 * behaviors directory (swamp-club#3338): the archive can hold only one.
 */
function assertDistinctModelArchivePaths(
  input: ExtensionPushPrepareInput,
): void {
  if (
    input.behaviorsDir === undefined || input.behaviorsDir === input.modelsDir
  ) {
    return;
  }
  const packed = new Map<string, string>();
  for (const file of [...input.allModelFiles, ...input.includeFilePaths]) {
    const archivePath = `models/${
      relative(modelsArchiveBase(input, file), file).replaceAll("\\", "/")
    }`;
    const other = packed.get(archivePath);
    if (other !== undefined && other !== file) {
      throw validationFailed(
        `${other} and ${file} would both be packed as ${archivePath}. ` +
          "Files under the behaviors directory are packed under models/, " +
          "like files under the models directory; rename or move one of them.",
        { archivePath, files: [other, file] },
      );
    }
    packed.set(archivePath, file);
  }
}

/**
 * The path a packaged file has inside the archive, mirroring
 * {@link createArchive} exactly: additional files and binaries land at
 * `files/<manifest entry>` by index wherever they sit on disk, include
 * files under `models/` by their path from the models directory, and typed
 * sources under their kind. Undefined for a file the archive does not
 * carry, so no local path ever leaves the machine.
 */
function archivePathFor(
  input: ExtensionPushPrepareInput,
  file: string,
): string | undefined {
  const fwd = (p: string) => p.replaceAll("\\", "/");
  const additional = input.additionalFilePaths.indexOf(file);
  if (additional !== -1 && input.manifest.additionalFiles[additional]) {
    return `files/${fwd(input.manifest.additionalFiles[additional])}`;
  }
  const binary = input.binaryFilePaths.indexOf(file);
  if (binary !== -1 && input.manifest.binaries[binary]) {
    return `files/${fwd(input.manifest.binaries[binary])}`;
  }
  const under = (dir: string): string | undefined => {
    const rel = relative(dir, file);
    return rel === ".." || rel.startsWith(".." + SEPARATOR) || isAbsolute(rel)
      ? undefined
      : fwd(rel);
  };
  if (input.includeFilePaths.includes(file)) {
    const rel = under(modelsArchiveBase(input, file));
    return rel !== undefined ? `models/${rel}` : undefined;
  }
  // A module copied into several kinds names the copy of the first kind
  // that lists it, as before; a shared module has a single copy.
  const planned = input.sourcePlan.entries.filter((e) => e.sourcePath === file);
  const typed: Array<[string, string[]]> = [
    ["models", input.allModelFiles],
    ["vaults", input.allVaultFiles],
    ["datastores", input.allDatastoreFiles],
    ["reports", input.allReportFiles],
    ["webhooks", input.allWebhookFiles],
  ];
  for (const [kind, files] of typed) {
    if (!files.includes(file)) continue;
    const inKind = planned.find((e) => e.archivePath.startsWith(`${kind}/`));
    if (inKind) return inKind.archivePath;
  }
  return planned[0]?.archivePath;
}

/**
 * The acceptances as content metadata carries them to the registry: files
 * by their archive path, never a local one.
 */
function toContentMetadataAcceptances(
  acceptances: DeclaredAcceptances,
): ExtensionAcceptances {
  const accepted: ExtensionAcceptance[] = acceptances.accepted.map((a) => ({
    rule: a.ruleId,
    ...(a.archivePath !== undefined ? { file: a.archivePath } : {}),
    ...(a.line !== undefined ? { line: a.line } : {}),
    ...(a.reason !== undefined ? { reason: a.reason } : {}),
    source: a.source,
  }));
  return {
    accepted,
    ...(acceptances.generated ? { generated: acceptances.generated } : {}),
  };
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
        ...(input.manifest.license ? { license: input.manifest.license } : {}),
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
        warnings?: RegistryWarnings;
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
          ...(confirmResult.warnings &&
              confirmResult.warnings.messages.length > 0
            ? { registryWarnings: confirmResult.warnings }
            : {}),
        },
      };
    })(),
  );
}

// ── Helpers ───────────────────────────────────────────────────────────

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/**
 * Reads and validates the `quality.yaml` sidecar beside the manifest.
 * Returns undefined when there is none; throws a validation error, naming
 * every problem, when there is one that does not parse.
 */
export async function readQualitySidecar(
  manifestDir: string,
): Promise<{ path: string; value: QualitySidecar } | undefined> {
  const path = qualitySidecarPath(manifestDir);
  let raw: string | undefined;
  try {
    // A symlinked sidecar is never read: its parse errors would quote the
    // target (swamp-club#3420).
    if (!(await Deno.lstat(path)).isSymlink) {
      raw = await Deno.readTextFile(path);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw validationFailed(
      `Could not read ${QUALITY_SIDECAR_FILENAME}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (raw === undefined) {
    throw validationFailed(
      `${QUALITY_SIDECAR_FILENAME} beside the manifest is a symlink. Replace ` +
        `it with a regular file; symlinks are not allowed in extensions.`,
    );
  }
  const parsed = parseQualitySidecar(raw);
  if (!parsed.ok) {
    throw validationFailed(
      `${QUALITY_SIDECAR_FILENAME} beside the manifest is invalid:\n` +
        parsed.errors.map((e) => `  ${e}`).join("\n"),
      { sidecarErrors: parsed.errors },
    );
  }
  return { path, value: parsed.sidecar };
}

const CONTENT_COLLECTIVES_MESSAGE =
  "Extension content uses collectives that don't match the extension package. " +
  "All behavior types, vault types, workflow names, datastore types, report names, and webhook types must use the same collective as the extension.";

/**
 * Installs the archive into a private temp repository, laid out as an
 * install lays it out (sources under the pulled-extensions root, each
 * shipped bundle where the loader looks for it), and indexes it there. The
 * bundles are the ones this push just built, so the indexer loads them
 * rather than bundling every source a second time. Nothing is written to
 * the real repository, and everything goes with the temp directory.
 */
async function indexArchiveTree(
  archiveBytes: Uint8Array,
  extensionName: string,
  indexerFor: (tmpRepo: string) => ExtensionTreeIndexer,
): Promise<ExtensionTreeIndex> {
  const tmpRepo = await Deno.makeTempDir({ prefix: "swamp_ext_index_" });
  try {
    const extractDir = join(tmpRepo, "archive");
    await extractTarGz(
      ReadableStream.from([archiveBytes]),
      extractDir,
      undefined,
      { maxDecompressedBytes: MAX_EXTENSION_ARCHIVE_DECOMPRESSED_BYTES },
    );
    const roots = extensionInstallRoots(tmpRepo, extensionName);
    await Deno.mkdir(dirname(roots.extensionRoot), { recursive: true });
    await Deno.rename(join(extractDir, "extension"), roots.extensionRoot);
    for (const root of roots.bundleRoots) {
      const shipped = join(roots.extensionRoot, bundleKindOf(root.sourceKind));
      try {
        await Deno.mkdir(dirname(root.live), { recursive: true });
        await Deno.rename(shipped, root.live);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    return await indexerFor(tmpRepo)(roots.extensionRoot);
  } finally {
    await Deno.remove(tmpRepo, { recursive: true }).catch(() => {});
  }
}

/** The archive directory that holds a source kind's shipped bundles. */
function bundleKindOf(
  sourceKind: typeof EXTENSION_BUNDLE_KINDS[number]["sourceKind"],
): string {
  return EXTENSION_BUNDLE_KINDS.find((k) => k.sourceKind === sourceKind)!
    .bundleKind;
}

function loadedKey(kindDir: ExtensionKindDir, fileName: string): string {
  return `${kindDir}\0${fileName}`;
}

/**
 * The type each loaded source registers, or for an extension source the
 * type it extends, by kind directory and file.
 */
function loadedTypesByFile(
  runtimeIndex: ExtensionTreeIndex | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const source of runtimeIndex?.sources ?? []) {
    if (!source.indexed) continue;
    out.set(
      loadedKey(source.kindDir, source.fileName),
      source.indexed.typeNormalized,
    );
  }
  return out;
}

/**
 * The loaded-type mismatches the static check has not already reported for
 * the same file, so a source is listed once.
 */
function newRuntimeMismatches(
  runtimeMismatches: CollectiveMismatch[],
  contentMetadata: ExtensionContentMetadata | undefined,
  extensionName: string,
): CollectiveMismatch[] {
  if (runtimeMismatches.length === 0) return [];
  const reported = new Set(
    contentMetadata
      ? validateContentCollectives(extensionName, contentMetadata).mismatches
        .map((m) => `${m.kind}\0${m.fileName}`)
      : [],
  );
  return runtimeMismatches.filter((m) =>
    !reported.has(`${m.kind}\0${m.fileName}`)
  );
}

/**
 * A source whose type neither the static metadata nor loading it could
 * give: its collective was not checked, so say so rather than pass it
 * silently. A source the static metadata reads was checked statically.
 */
function unverifiedCollectiveWarnings(
  input: ExtensionPushPrepareInput,
  contentMetadata: ExtensionContentMetadata | undefined,
  runtimeIndex: ExtensionTreeIndex | undefined,
): ReviewFinding[] {
  const statically = new Set<string>([
    ...(contentMetadata?.models ?? []).map((m) =>
      loadedKey("models", m.fileName)
    ),
    ...(contentMetadata?.extensions ?? []).map((e) =>
      loadedKey("models", e.fileName)
    ),
    ...(contentMetadata?.vaults ?? []).map((v) =>
      loadedKey("vaults", v.fileName)
    ),
    ...(contentMetadata?.datastores ?? []).map((d) =>
      loadedKey("datastores", d.fileName)
    ),
    ...(contentMetadata?.reports ?? []).map((r) =>
      loadedKey("reports", r.fileName)
    ),
    ...(contentMetadata?.webhooks ?? []).map((w) =>
      loadedKey("webhooks", w.fileName)
    ),
  ]);
  const sources = entryPointsByKey(input);
  const unverified: Array<{ file: string; reason: string }> = [];
  if (runtimeIndex) {
    for (const failure of runtimeIndex.failures) {
      const key = loadedKey(failure.kindDir, failure.fileName);
      if (statically.has(key)) continue;
      unverified.push({
        file: sources.get(key) ?? `${failure.kindDir}/${failure.fileName}`,
        reason: failure.reason,
      });
    }
  } else {
    for (const [key, file] of sources) {
      if (statically.has(key)) continue;
      unverified.push({ file, reason: "the archive could not be indexed" });
    }
  }
  return unverified.map(({ file, reason }) => ({
    ruleId: "unverified-collective",
    dimension: "Registry catalog",
    severity: "medium",
    file,
    message: "Push could not read this source's type from its text or by " +
      `loading it (${firstLine(reason)}), so its collective was not ` +
      "checked. Consumers that cannot load it will not register it either.",
    remediation: remediationFor("unverified-collective"),
  }));
}

/** Each entry point by its kind directory and content file name. */
function entryPointsByKey(
  input: ExtensionPushPrepareInput,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of input.modelEntryPoints) {
    out.set(
      loadedKey("models", contentFileName(modelsArchiveBase(input, f), f)),
      f,
    );
  }
  for (const f of input.vaultEntryPoints) {
    out.set(loadedKey("vaults", contentFileName(input.vaultsDir, f)), f);
  }
  for (const f of input.datastoreEntryPoints) {
    out.set(
      loadedKey("datastores", contentFileName(input.datastoresDir, f)),
      f,
    );
  }
  for (const f of input.reportEntryPoints) {
    out.set(loadedKey("reports", contentFileName(input.reportsDir, f)), f);
  }
  for (const f of input.webhookEntryPoints) {
    out.set(loadedKey("webhooks", contentFileName(input.webhooksDir, f)), f);
  }
  return out;
}

function firstLine(text: string): string {
  const line = text.split("\n")[0].trim();
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

function buildResolvedData(
  input: ExtensionPushPrepareInput,
  contentMetadata: ExtensionContentMetadata | undefined,
  runtimeIndex: ExtensionTreeIndex | undefined,
): ExtensionPushResolvedData {
  const extractedModelsByFile = new Map(
    (contentMetadata?.models ?? []).map((m) => [m.fileName, m]),
  );
  const extractedExtensionsByFile = new Map(
    (contentMetadata?.extensions ?? []).map((e) => [e.fileName, e]),
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
  // A type the static metadata could not read is shown as the loaded
  // source registers it, never as the file's path (swamp-club#3456).
  const loaded = loadedTypesByFile(runtimeIndex);

  const resolvedModels = input.modelEntryPoints.map((f) => {
    const relPath = relative(input.repoDir, f);
    const name = contentFileName(modelsArchiveBase(input, f), f);
    const extracted = extractedModelsByFile.get(name);
    const type = extracted?.type ??
      extractedExtensionsByFile.get(name)?.extendsType ??
      loaded.get(loadedKey("models", name));
    return {
      ...(type !== undefined ? { type } : {}),
      fileName: relPath,
      globalArguments: extracted?.globalArguments,
    };
  });

  const resolvedVaults = input.vaultEntryPoints.map((f) => {
    const relPath = relative(input.repoDir, f);
    const name = contentFileName(input.vaultsDir, f);
    const extracted = extractedVaultsByFile.get(name);
    const type = extracted?.type ?? loaded.get(loadedKey("vaults", name));
    return {
      ...(type !== undefined ? { type } : {}),
      fileName: relPath,
      name: extracted?.name,
      hasConfigSchema: extracted?.hasConfigSchema,
      configFields: extracted?.configFields,
    };
  });

  const resolvedDatastores = input.datastoreEntryPoints.map((f) => {
    const relPath = relative(input.repoDir, f);
    const name = contentFileName(input.datastoresDir, f);
    const extracted = extractedDatastoresByFile.get(name);
    const type = extracted?.type ??
      loaded.get(loadedKey("datastores", name));
    return {
      ...(type !== undefined ? { type } : {}),
      fileName: relPath,
      name: extracted?.name,
      hasConfigSchema: extracted?.hasConfigSchema,
      configFields: extracted?.configFields,
    };
  });

  const resolvedReports = input.reportEntryPoints.map((f) => {
    const relPath = relative(input.repoDir, f);
    const fileKey = contentFileName(input.reportsDir, f);
    const extracted = extractedReportsByFile.get(fileKey);
    const name = extracted?.name ?? loaded.get(loadedKey("reports", fileKey));
    return {
      ...(name !== undefined ? { name } : {}),
      fileName: relPath,
      description: extracted?.description,
      scope: extracted?.scope,
      labels: extracted?.labels,
    };
  });

  const resolvedWebhooks = input.webhookEntryPoints.map((f) => {
    const relPath = relative(input.repoDir, f);
    const name = contentFileName(input.webhooksDir, f);
    const extracted = extractedWebhooksByFile.get(name);
    const type = extracted?.type ?? loaded.get(loadedKey("webhooks", name));
    return {
      ...(type !== undefined ? { type } : {}),
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
    license: input.manifest.license ?? null,
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

/**
 * Every non-test code file the archive ships, as the registry reads it
 * (swamp-club#3781): the planned sources exist before the archive is built
 * and on a cache hit alike; include and additional files ship beside them
 * (a worker under files/ runs as code too).
 */
function auditedCodeFiles(input: ExtensionPushPrepareInput): string[] {
  return [
    ...new Set([
      ...input.sourcePlan.entries
        .filter((e) => isAuditedCodeFile(e.archivePath))
        .map((e) => e.sourcePath),
      ...[...input.includeFilePaths, ...input.additionalFilePaths].filter((
        p,
      ) => isAuditedCodeFile(p.replaceAll("\\", "/"))),
    ]),
  ];
}

/**
 * Refuses a bundle the import scan cannot read. `deno bundle` writes valid
 * JavaScript, so one that does not parse with the shared parse means
 * swamp's parse is wrong, not the extension: the registry, reading the
 * bundle the same way, would see no imports in it (swamp-club#3983).
 */
function assertBundlesParse(bundles: ReadonlyMap<string, string>[]): void {
  for (const group of bundles) {
    for (const [entryName, js] of group) {
      const parsed = parseExtensionModule(js, { path: `${entryName}.js` });
      if (parsed.ok) continue;
      throw validationFailed(
        `swamp built a bundle for ${entryName} that its import scan cannot ` +
          `read (${parsed.reason}). This is a swamp bug, not a problem in ` +
          `the extension: report it with \`swamp issue bug\` and include ` +
          `this message.`,
      );
    }
  }
}

async function bundleAndArchive(
  input: ExtensionPushPrepareInput,
  deps: ExtensionPushPrepareDeps,
  denoPath: string,
  ctx: LibSwampContext,
  auditRecord: DependencyAuditRecord,
): Promise<{ archiveBytes: Uint8Array; totalBundles: number }> {
  // Under a Deno config the bundler reuses the graph's bare-import
  // resolutions to decide zod externalization rather than reading it again.
  const project = input.denoConfigPath
    ? { denoConfigPath: input.denoConfigPath, bareImports: input.bareImports }
    : input.packageJsonDir
    ? { packageJsonDir: input.packageJsonDir }
    : undefined;
  // Push never writes the author's lockfile: a stale lock fails the bundle
  // rather than being rewritten, so the lock the audit read is what ships.
  const bundleOptions = project
    ? { ...project, readOnlyLock: await readOnlyLockFor(project) }
    : undefined;

  assertDistinctModelArchivePaths(input);
  assertPullInstallsSourcePlan(input);

  const bundles = new Map<string, string>();
  const compilationErrors: CompilationError[] = [];

  await bundleEntryPoints(
    input.modelEntryPoints,
    (entryPoint) => modelsArchiveBase(input, entryPoint),
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

  assertBundlesParse([
    bundles,
    vaultBundles,
    datastoreBundles,
    reportBundles,
    webhookBundles,
  ]);

  const totalBundles = bundles.size + vaultBundles.size +
    datastoreBundles.size + reportBundles.size + webhookBundles.size;

  const archiveBytes = await createArchive(
    input,
    bundles,
    vaultBundles,
    datastoreBundles,
    reportBundles,
    webhookBundles,
    auditRecord,
    ctx,
  );

  return { archiveBytes, totalBundles };
}

async function bundleEntryPoints(
  entryPoints: string[],
  baseDir: string | ((entryPoint: string) => string),
  bundles: Map<string, string>,
  compilationErrors: CompilationError[],
  deps: ExtensionPushPrepareDeps,
  denoPath: string,
  bundleOptions:
    | {
      denoConfigPath?: string;
      packageJsonDir?: string;
      bareImports?: readonly ResolvedBareImport[];
    }
    | undefined,
  ctx: LibSwampContext,
  label: string,
): Promise<void> {
  // Each bundle is its own `deno bundle` run, so several run side by side.
  // Results are recorded in entry point order whatever order they finish
  // in: the archive, and so its hash, depends on that order.
  const outcomes: Array<
    | { entryName: string; js: string }
    | { entryPoint: string; error: string }
  > = new Array(entryPoints.length);
  let next = 0;
  const lane = async () => {
    while (next < entryPoints.length) {
      const i = next++;
      const entryPoint = entryPoints[i];
      const base = typeof baseDir === "string" ? baseDir : baseDir(entryPoint);
      const entryName = relative(base, entryPoint).replace(/\.ts$/, "");
      try {
        const js = await deps.bundleEntryPoint(
          entryPoint,
          denoPath,
          { ...bundleOptions, env: deps.getDenoEnv() },
        );
        outcomes[i] = { entryName, js };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        outcomes[i] = { entryPoint, error: msg };
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(defaultConcurrency(), entryPoints.length) },
      lane,
    ),
  );
  for (const outcome of outcomes) {
    if ("js" in outcome) {
      bundles.set(outcome.entryName, outcome.js);
      ctx.logger
        .debug`Bundled ${label} ${outcome.entryName} (${outcome.js.length} bytes)`;
    } else {
      compilationErrors.push({
        file: outcome.entryPoint,
        error: outcome.error,
      });
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
  auditRecord: DependencyAuditRecord,
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
        ...(input.manifest.license ? { license: input.manifest.license } : {}),
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

    // The quality sidecar travels at the archive root beside manifest.yaml,
    // byte for byte, so the registry sees the acceptances as written.
    const sidecarPath = qualitySidecarPath(input.manifestDir);
    if (await fileExists(sidecarPath)) {
      await Deno.copyFile(sidecarPath, join(extDir, QUALITY_SIDECAR_FILENAME));
    }

    // The version the audit checked for each dependency, which these
    // bundles ship, so the registry audits the same one (swamp-club#3662).
    // Always written, so an empty record tells "nothing to audit" from an
    // archive that predates it.
    await Deno.writeTextFile(
      join(extDir, DEPENDENCY_AUDIT_RECORD_FILENAME),
      serializeDependencyAuditRecord(auditRecord),
    );

    // Copy every local module the entry points reach to its planned path,
    // rewriting the imports the plan names and, under a Deno config, each
    // bare import Deno resolves from that module to an npm:, jsr:, node: or
    // URL specifier (swamp-club#3637, #3612), or in a package.json project
    // to the installed package's npm:<name>@<version> (swamp-club#3630), so
    // the archive's source resolves without the project config. Data
    // modules and files with nothing to rewrite are byte for byte.
    const resolver = bareImportResolverFor(input);
    const codeModules = new Set([
      ...input.allModelFiles,
      ...input.allVaultFiles,
      ...input.allDatastoreFiles,
      ...input.allReportFiles,
      ...input.allWebhookFiles,
    ]);
    for (const entry of input.sourcePlan.entries) {
      const parts = entry.archivePath.split("/");
      if (
        isAbsolute(entry.archivePath) || parts.includes("..") ||
        parts.includes("")
      ) {
        throw markErrorPaths(
          new Error(`Unsafe archive path: ${entry.archivePath}`),
          [entry.archivePath, entry.sourcePath],
        );
      }
      const destPath = join(extDir, ...parts);
      await Deno.mkdir(dirname(destPath), { recursive: true });
      let text: string | undefined;
      let rewrites = entry.rewrites;
      if (resolver && codeModules.has(entry.sourcePath)) {
        text = await Deno.readTextFile(entry.sourcePath);
        rewrites = mergeSpecifierRewrites(
          entry.rewrites,
          bareImportRewrites(text, resolver, entry.sourcePath),
        );
      }
      if (rewrites.length === 0) {
        await Deno.copyFile(entry.sourcePath, destPath);
      } else {
        await Deno.writeTextFile(
          destPath,
          applySpecifierRewrites(
            text ?? await Deno.readTextFile(entry.sourcePath),
            rewrites,
          ),
        );
      }
    }

    // Copy include files (alongside model sources, not bundled). A file the
    // source plan already wrote keeps the plan's copy, which may carry
    // rewritten imports.
    const planned = new Set(
      input.sourcePlan.entries.map((e) => `${e.sourcePath}\0${e.archivePath}`),
    );
    for (const incFile of input.includeFilePaths) {
      const relPath = relative(modelsArchiveBase(input, incFile), incFile);
      const archivePath = `models/${relPath.replaceAll("\\", "/")}`;
      if (planned.has(`${incFile}\0${archivePath}`)) continue;
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

    // Write compiled vault bundles
    for (const [entryName, js] of vaultBundles) {
      const destPath = join(extDir, "vault-bundles", `${entryName}.js`);
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await Deno.writeTextFile(destPath, js);
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

    // Write compiled report bundles
    for (const [entryName, js] of reportBundles) {
      const destPath = join(extDir, "report-bundles", `${entryName}.js`);
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await Deno.writeTextFile(destPath, js);
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
    // The archive never holds a symlink: staging copies files, so one
    // here is a bug, refused before it can be packaged (swamp-club#3421).
    const stagedLink = await firstSymlinkUnder(extDir);
    if (stagedLink !== undefined) {
      throw validationFailed(
        `Refusing to archive the symlink ${
          relative(extDir, stagedLink)
        }: an extension archive holds regular files only. This is a bug in push.`,
      );
    }
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
