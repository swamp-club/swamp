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

export interface ResolvedModelEntry {
  /** Absent when neither the source text nor loading it gave a type. */
  type?: string;
  fileName: string;
  globalArguments?: ExtractedArgument[];
}

export interface ResolvedVaultEntry {
  /** Absent when neither the source text nor loading it gave a type. */
  type?: string;
  fileName: string;
  name?: string;
  hasConfigSchema?: boolean;
  configFields?: ExtractedArgument[];
}

export interface ResolvedDatastoreEntry {
  /** Absent when neither the source text nor loading it gave a type. */
  type?: string;
  fileName: string;
  name?: string;
  hasConfigSchema?: boolean;
  configFields?: ExtractedArgument[];
}

export interface ResolvedReportEntry {
  /** Absent when neither the source text nor loading it gave a name. */
  name?: string;
  fileName: string;
  description?: string;
  scope?: string;
  labels?: string[];
}

export interface ResolvedWebhookEntry {
  /** Absent when neither the source text nor loading it gave a type. */
  type?: string;
  fileName: string;
  name?: string;
  description?: string;
}

export interface ExtensionPushResolvedData {
  name: string;
  version: string;
  /** Requested intent, not a prediction of registry authorization or defaults. */
  visibility: PublishVisibility | "default";
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
  /** Set when public was requested explicitly but the extension stayed private. */
  visibilityWarning?: string;
  registryWarnings?: RegistryWarnings;
}

export interface CompilationError {
  file: string;
  error: string;
}

export interface ExtensionPushPrepareInput {
  manifest: ExtensionManifest;
  repoDir: string;
  manifestDir: string;
  manifestPath?: string;
  modelsDir: string;
  /**
   * files under it are packed at models/<path from it>, as files under
   * modelsDir are packed at models/<path from modelsDir>.
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
  sourcePlan: SourceArchivePlan;
  missingModules?: MissingLocalModule[];
  /**
   * the bundler would follow a symlink and quote the target in its errors, so
   * these entry points are never bundled.
   */
  entryPointsReachingSymlinks?: string[];
  /**
   * nothing reads these files; the safety gate refuses each by the symlink
   * rule.
   */
  symlinkedPaths?: ReadonlyMap<string, string>;
  dryRun: boolean;
  /**
   * a real push enforces the registry checks, a dry run collects their
   * verdicts, and packaging-only callers skip them and never contact the
   * registry.
   */
  registryChecks: RegistryChecksMode;
  /**
   * a push enforces local gates (first failure throws); `extension quality`
   * collects them so it can still score the archive. Defaults to enforce.
   */
  localGates?: LocalGatesMode;
  channel?: string;
  releaseNotes?: string;
  denoConfigPath?: string;
  packageJsonDir?: string;
  /**
   * the workspace root denoConfigPath is a member of, whose lock push bundles
   * against and the audit reads.
   */
  workspaceRootConfigPath?: string;
  /**
   * bundle with --no-config: no Deno config inside the repository, so none
   * above it applies.
   */
  noConfig?: boolean;
  /** a workspace member's own lock, which Deno ignores. */
  ignoredMemberLock?: string;
  /**
   * push rewrites, audits and reports bare imports from these resolutions
   * alone.
   */
  bareImports: ResolvedBareImport[];
  /** push pins every import it ships to these versions. */
  graphDependencies: GraphDependencies;
  leftOutProjectFiles?: string[];
  contentHash?: string;
  /**
   * the caller must validate that the cache key matches the current source
   * state.
   */
  cachedArchive?: Uint8Array;
  /**
   * used only with cachedArchive, so the collective check does not reload every
   * source of an archive it already judged.
   */
  cachedArchiveIndex?: StoredArchiveIndex;
}

export type LocalGatesMode = "enforce" | "collect";

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

export interface LocalGateFailure {
  gate: LocalGate;
  message: string;
  details?: unknown;
}

/**
 * in collect mode a file carrying one of these is left out, so a rejected
 * symlink's target is not packaged; a bundled entry point that imports it can
 * still resolve it.
 */
const FILE_REJECTING_SAFETY_RULES: ReadonlySet<string> = new Set([
  "hidden-file",
  "file-type",
  "symlink",
  "file-size",
  "unreadable-file",
]);

export interface ExtensionPushPrepared {
  resolvedData: ExtensionPushResolvedData;
  safetyWarnings: SafetyIssue[];
  dependencyTrustResult: DependencyTrustResult;
  reviewRulesResult: ReviewRulesResult;
  /** a license is optional, so this never blocks a push. */
  licenseWarning: ManifestLicenseWarning | undefined;
  sidecar: { path: string; value: QualitySidecar } | undefined;
  /**
   * safetyWarnings and reviewRulesResult.warnings hold only findings no
   * acceptance covers, so the warnings gate counts those alone.
   */
  acceptances: DeclaredAcceptances;
  commentSites: Record<string, CommentSites>;
  archiveBytes: Uint8Array;
  archiveIndex: StoredArchiveIndex | undefined;
  manifest: ExtensionManifest;
  contentMetadata: ExtensionContentMetadata | undefined;
  counts: ExtensionPushCounts;
  isDryRun: boolean;
  /**
   * empty when the checks were skipped; in enforce mode every entry passed,
   * since a failure throws.
   */
  registryChecks: RegistryCheckResult[];
  contentHash: string | undefined;
  /**
   * always empty under enforce. When non-empty the archive was built without
   * the rejected files and must be neither uploaded nor cached.
   */
  gateFailures: LocalGateFailure[];
  excludedFromArchive: string[];
  /**
   * held in memory for the push that follows and never written to disk:
   * entitlement is the registry's to decide, and a cached plan would make a
   * confidently wrong message.
   */
  collectiveEntitlement: CollectiveEntitlement | undefined;
}

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

export interface ExtensionPushExecuteInput {
  manifest: ExtensionManifest;
  archiveBytes: Uint8Array;
  contentMetadata: ExtensionContentMetadata | undefined;
  counts: ExtensionPushCounts;
  releaseNotes?: string;
  channel?: string;
  collectiveEntitlement?: CollectiveEntitlement;
}

export type ExtensionPushEvent =
  | { kind: "pushing"; phase: "initiate" | "upload" | "confirm" }
  | { kind: "completed"; data: ExtensionPushSuccessData }
  | { kind: "error"; error: SwampError };

/**
 * an undefined field means the registry sent none (entitlements: an older
 * server), which the private check reports as undecided. identity names the
 * credential and never decides membership.
 */
export interface CollectiveLookup {
  collectives: string[] | undefined;
  entitlements: CollectiveEntitlement[] | undefined;
  identity?: CollectiveLookupIdentity;
}

export interface CollectiveLookupIdentity {
  username?: string;
  collectiveToken?: boolean;
  collectiveSlug?: string;
}

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
      workspaceRootConfigPath?: string;
      noConfig?: boolean;
      readOnlyLock?: ReadOnlyLock;
      env?: Record<string, string>;
      bareImports?: readonly ResolvedBareImport[];
    },
  ) => Promise<string>;
  extractDependencySpecifiers: (
    sourceFiles: string[],
    resolver?: BareImportResolver,
  ) => Promise<DependencySpecifier[]>;
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
   * loads every source as a consumer's install does, so the collective check
   * judges the type the consumer gets, not only what static metadata could
   * read.
   */
  indexArchive: (
    archiveBytes: Uint8Array,
    extensionName: string,
  ) => Promise<ExtensionTreeIndex>;
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
  license?: string;
  /** Public/default selection is represented by omission on the wire. */
  visibility?: "private";
  contentMetadata?: ExtensionContentMetadata;
}

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
  BUNDLE_FORMAT_VERSION,
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
  type ListingLimitBreach,
  registryListingLimitBreaches,
} from "../../domain/extensions/registry_listing_limits.ts";
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
  buildDependencyAuditRecordV2,
  canonicalShippedSpecifierIssue,
  DEPENDENCY_AUDIT_RECORD_FILENAME,
  exactVersion,
  parseSpecifier,
  serializeDependencyAuditRecordV2,
  type ShippedImport,
  specifierText,
  withUnauditedCode,
} from "@swamp-club/extension-scoring/dependency-audit";
import {
  canonicalImportRewrites,
  canonicalTarget,
} from "../../domain/extensions/dependency_resolution/canonical_form.ts";
import type {
  GraphDependencies,
  PackageVersions,
} from "../../domain/extensions/dependency_resolution/package_versions.ts";
import { scanImportSites } from "../../domain/extensions/dependency_resolution/import_sites.ts";
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
  type SpecifierRewrite,
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

export interface ExtensionPushPrepareDepsOptions {
  recorder?: ApiCallRecorder;
  fetch?: Fetcher;
}

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
      // no identity: uploadArchive PUTs to a presigned S3 URL, and identity
      // headers would break the signature and leak the bearer token to S3
      // access logs.
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

export async function extensionPushPrepare(
  ctx: LibSwampContext,
  deps: ExtensionPushPrepareDeps,
  input: ExtensionPushPrepareInput,
): Promise<ExtensionPushPrepared> {
  // no Deno config, lock or package.json file ships: consumers and the registry
  // read only the canonical source.
  input = withoutProjectFiles(input);
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
  // a real push (enforce) stops at the first failure; a dry run (collect)
  // records every verdict; packaging-only callers (skip) never contact the
  // registry.
  const mode = input.registryChecks;
  const registryChecks: RegistryCheckResult[] = [];
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
        // membership nobody could settle refuses the push.
        if (
          mode === "enforce" && membership.status === "not-run" &&
          membership.cause === "registry-unavailable"
        ) {
          throw validationFailed(
            `${membership.message} Try again when ${creds.serverUrl} is reachable.`,
          );
        }
        registryChecks.push(reserved, membership);
        // private entitlement comes from the same whoami answer: omitted when
        // membership did not pass, unasked when whoami did not answer,
        // undecided (the registry decides) when none was reported.
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

  // a file with a symlink on its path is never read: the safety gate refuses
  // it.
  const symlinked = input.symlinkedPaths ?? new Map<string, string>();
  const readable = symlinked.size > 0
    ? withoutFiles(input, new Set(symlinked.keys()))
    : input;
  let contentMetadata: ExtensionContentMetadata | undefined;
  try {
    // entry points under the behaviors directory are read from it, so each
    // fileName is the entry point's path inside the archive's models/.
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

  // pre-check additionalFiles against the extension allowlist so the error can
  // name the manifest field and suggest `binaries`. Rejected files are left out
  // of the archive in collect mode.
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

  // read and validated here so a malformed sidecar blocks like a malformed
  // manifest, before any gate runs.
  const sidecar = await readQualitySidecar(input.manifestDir);

  // include files are safety-checked but excluded from quality checks, since
  // they may have their own tooling and conventions.
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
  // a file with a symlink on its path is refused by the symlink rule without
  // being stat'd or read; the analyzer sees the rest.
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

  // every shipped code file must parse: push and the registry read imports from
  // the syntax tree, so an unparseable module has no imports to audit or
  // rewrite, and `deno info` reports it as a module it cannot load.
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

  // a rejected file (only collect mode gets here) is left out of later gates
  // too: fmt, lint and review read a symlink's target and would quote it.
  const gated = rejectedFiles.size > 0
    ? withoutFiles(input, rejectedFiles)
    : input;
  const notRejected = (file: string) => !rejectedFiles.has(file);

  let dependencyTrustResult: DependencyTrustResult;
  const sourceFiles = auditedCodeFiles(gated);
  // each import is audited at the version its bundle holds, so what ships, what
  // is bundled and what is audited agree.
  const specifiers = withBundledVersions(
    await deps.extractDependencySpecifiers(
      sourceFiles,
      bareImportResolverFor(input),
    ),
    input.graphDependencies,
    await projectLockInUse(input),
  );
  if (specifiers.length > 0) {
    ctx.logger.debug`Auditing ${specifiers.length} dependency specifier(s)`;
    dependencyTrustResult = await deps.checkDependencyTrust(
      specifiers,
      pushProject(input) ?? {},
    );
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
  // code from outside npm and JSR that the bundles hold is not audited and
  // costs the dependency-trust points, as on the registry.
  dependencyTrustResult = withUnauditedCode(
    dependencyTrustResult,
    input.graphDependencies?.unaudited ?? [],
  );

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

  const usingCachedArchive = input.cachedArchive !== undefined;
  let denoPath = "";
  if (!usingCachedArchive) {
    denoPath = await deps.ensureDenoPath();
  }

  // skipped on a cache hit: the cached archive was written only after quality
  // checks passed.
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

  // always runs, not gated on a cache hit, since it is a fast file read.
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

  // one pass shared with `swamp extension quality`, after the mechanical gates
  // (safety, deps, fmt) so those fire first.
  const findings = await runQualityFindings(ctx, deps, {
    input: gated,
    sidecar,
    safetyWarnings: safetyResult.warnings,
    files: allFiles.filter(notRejected),
    ...(contentMetadata
      ? { argumentSchemas: argumentSchemas(contentMetadata), contentMetadata }
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

  // a missing local module fails the push as a compilation error, models never
  // bundled included. A module a gate rejected is reported by that gate.
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

  // skipped on a cache hit unless a check rejected files: the cached archive
  // may hold them, so collect mode rebuilds without them.
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
      shippedImportsOf(specifiers),
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

  // Load the archive's sources as a consumer's install will and check their
  // types against the collective; static metadata reads only literal types.
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

  // a type the static metadata could not read is taken from the loaded source
  // rather than shown as its file path.
  const resolvedData = buildResolvedData(
    input,
    contentMetadata,
    runtimeIndex,
  );

  // the version must not be published on any channel. Runs after packaging so
  // the cheaper local gates fire first.
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
 * additionalFiles/additionalFilePaths and binaries/binaryFilePaths are parallel
 * arrays, so each pair is filtered in lockstep. Used only in collect mode.
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

export interface DeclaredAcceptance {
  ruleId: string;
  /**
   * relative to the manifest's directory, with forward slashes and a `../` path
   * for a typed directory beside it; absent for extension-scoped rules.
   */
  file?: string;
  /**
   * the path inside the archive, which is what the registry receives; absent
   * when the file is not packaged under a known directory.
   */
  archivePath?: string;
  line?: number;
  reason?: string;
  source: AcceptanceSource;
  message: string;
}

export interface DeclaredAcceptances {
  accepted: DeclaredAcceptance[];
  generated?: GeneratedDeclaration;
}

export interface QualityFindings {
  safetyWarnings: SafetyIssue[];
  /**
   * warnings hold findings no acceptance covers plus one stale-acceptance
   * warning per directive that matched nothing; errors hold invalid acceptances
   * and any blocking finding.
   */
  reviewRulesResult: ReviewRulesResult;
  acceptances: DeclaredAcceptances;
  /** the findings report offers no comment acceptance on any other line. */
  commentSites: Record<string, CommentSites>;
}

export interface QualityFindingsInput {
  input: ExtensionPushPrepareInput;
  sidecar: { path: string; value: QualitySidecar } | undefined;
  safetyWarnings: SafetyIssue[];
  files: string[];
  argumentSchemas?: ArgumentSchemas;
  contentMetadata?: ExtensionContentMetadata;
}

/**
 * without a Deno config or package.json project, bare imports are not resolved
 * and each ships as written.
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

function exportNameOf(source: string): "model" | "behavior" {
  return !declaresExport(source, /export\s+const\s+model\s*[=:]/) &&
      declaresExport(source, /export\s+const\s+behavior\s*[=:]/)
    ? "behavior"
    : "model";
}

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
 * symlinks are never read. Documentation a cap leaves unread is reported as one
 * finding no acceptance can cover, since the registry fails the factor while
 * any is unchecked.
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

  // the parsed description, as the registry reads it. Its findings all sit on
  // the description line, so accepting that line accepts them all.
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

async function readUnlessSymlink(file: string): Promise<string | undefined> {
  try {
    if ((await Deno.lstat(file)).isSymlink) return undefined;
    return await Deno.readTextFile(file);
  } catch {
    return undefined;
  }
}

const LISTING_LIST_LABELS: Readonly<Record<string, string>> = {
  models: "behaviors",
  extensions: "model extensions",
  globalArguments: "global arguments",
  configFields: "config fields",
};

function registryListingLimitMessage(breach: ListingLimitBreach): string {
  const list = LISTING_LIST_LABELS[breach.list] ?? breach.list;
  const where = breach.owner ? ` for ${breach.owner}` : "";
  return `The registry lists at most ${breach.limit} ${list}${where}; this ` +
    `extension has ${breach.count}, so its page can list none of its ` +
    "behaviors, methods or arguments.";
}

/**
 * quality calls it on every run, including a cache hit, so push and quality
 * report the same findings for the same source.
 */
export async function runQualityFindings(
  ctx: LibSwampContext,
  deps: Pick<ExtensionPushPrepareDeps, "checkReviewRules">,
  {
    input,
    sidecar,
    safetyWarnings,
    files,
    argumentSchemas: schemas,
    contentMetadata,
  }: QualityFindingsInput,
): Promise<QualityFindings> {
  // report findings are warnings: a missing or stale report prompts rather than
  // blocks, so a benign version bump nudges the reviewer instead of bricking
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

  // the server-side scorer cannot resolve bare imports that ship as written;
  // push rewrites those Deno resolves or an installed package.json dependency
  // covers, so only the rest count.
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

  for (const file of input.leftOutProjectFiles ?? []) {
    reviewRulesResult.warnings.push({
      ruleId: "archive-project-file",
      dimension: "Packaging",
      severity: "medium",
      file,
      message:
        `${file} is a Deno config, lock or package file, so push leaves it out of the archive: the archive's source ships every dependency pinned instead.`,
      remediation: remediationFor("archive-project-file"),
    });
  }
  if (input.ignoredMemberLock) {
    reviewRulesResult.warnings.push({
      ruleId: "workspace-member-lock",
      dimension: "Packaging",
      severity: "medium",
      file: input.ignoredMemberLock,
      message:
        `${input.ignoredMemberLock} is a workspace member's own lock, which Deno ignores: push bundles against the lock of the workspace root${
          input.workspaceRootConfigPath
            ? ` ${input.workspaceRootConfigPath}`
            : ""
        } instead.`,
      remediation: remediationFor("workspace-member-lock"),
    });
  }
  const packageLockWarning = input.graphDependencies?.packageLock?.warning;
  if (packageLockWarning) {
    reviewRulesResult.warnings.push({
      ruleId: "package-lock-mismatch",
      dimension: "scoring",
      severity: "medium",
      file: "package-lock.json",
      message: packageLockWarning,
      remediation: remediationFor("package-lock-mismatch"),
    });
  }

  // an entry point whose type or version the metadata cannot read ships in the
  // archive but is left out of the registry catalog, so say so per file.
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

  // the registry discards the whole listing on any breach
  for (
    const breach of contentMetadata
      ? registryListingLimitBreaches(contentMetadata)
      : []
  ) {
    reviewRulesResult.warnings.push({
      ruleId: "registry-listing-limit",
      dimension: "Registry catalog",
      severity: "medium",
      file: "(extension)",
      message: registryListingLimitMessage(breach),
      remediation: remediationFor("registry-listing-limit"),
    });
  }

  // an extension using the behavior export, directory or manifest key loads
  // only on this release and later, so say so once.
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

  for (const finding of await secretUnsafeDocs(input, files, schemas)) {
    reviewRulesResult.warnings.push(finding);
  }

  const directives: AcceptanceDirective[] = [];
  const invalid: InvalidAcceptance[] = [];
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
      // A Markdown line no comment can go above (inside a fenced block) is
      // accepted by a quality.yaml line entry, so the whole file takes line
      // entries.
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

function isWithin(dir: string, file: string): boolean {
  const rel = relative(dir, file);
  return !(rel === ".." || rel.startsWith(".." + SEPARATOR) ||
    isAbsolute(rel));
}

/**
 * the file lands at models/<path from that directory>, so a behavior-spelled
 * extension's archive matches its model-spelled twin's and never holds a
 * models/../behaviors/ path.
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
 * refuses a source plan pull would refuse to install, such as a deno.json
 * imported from above a kind's directory; publishing it would ship a version
 * nobody can pull.
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
 * the archive can hold only one file per models/ path, so a models-dir and a
 * behaviors-dir file that map to the same path are refused.
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
 * mirrors createArchive exactly. Undefined for a file the archive does not
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

/** files by their archive path, never a local one. */
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
        // legacy servers omit applied visibility; public or default intent uses
        // a best-effort lookup, since explicit privacy was checked above.
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
      const visibilityWarning =
        requestedVisibility === "public" && visibility === "private"
          ? `Public visibility was requested, but ${confirmResult.name} stays private: a push keeps an existing extension's visibility. To make it public, run: swamp extension visibility ${confirmResult.name} --set public`
          : undefined;

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
          ...(visibilityWarning ? { visibilityWarning } : {}),
          ...(confirmResult.warnings &&
              confirmResult.warnings.messages.length > 0
            ? { registryWarnings: confirmResult.warnings }
            : {}),
        },
      };
    })(),
  );
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

export async function readQualitySidecar(
  manifestDir: string,
): Promise<{ path: string; value: QualitySidecar } | undefined> {
  const path = qualitySidecarPath(manifestDir);
  let raw: string | undefined;
  try {
    // a symlinked sidecar is never read: its parse errors would quote the
    // target.
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
 * the bundles are the ones this push just built, so the indexer loads them
 * rather than bundling every source again. Nothing is written to the real
 * repository.
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

function bundleKindOf(
  sourceKind: typeof EXTENSION_BUNDLE_KINDS[number]["sourceKind"],
): string {
  return EXTENSION_BUNDLE_KINDS.find((k) => k.sourceKind === sourceKind)!
    .bundleKind;
}

function loadedKey(kindDir: ExtensionKindDir, fileName: string): string {
  return `${kindDir}\0${fileName}`;
}

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
 * a source whose type neither static metadata nor loading could give was not
 * collective-checked, so say so rather than pass it silently.
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
  // a type the static metadata could not read is shown as the loaded source
  // registers it, never as the file's path.
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
 * planned sources exist before the archive is built and on a cache hit alike;
 * include and additional files ship beside them (a worker under files/ runs as
 * code too).
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
 * deno bundle writes valid JavaScript, so one that fails the shared parse means
 * swamp's parse is wrong, and the registry reading it the same way would see no
 * imports. Read as .js, as the registry does.
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
  shippedImports: ShippedImport[],
): Promise<{ archiveBytes: Uint8Array; totalBundles: number }> {
  // under a Deno config the bundler reuses the graph's bare-import resolutions
  // to decide zod externalization.
  const base = pushProject(input);
  const project = base && input.denoConfigPath
    ? { ...base, bareImports: input.bareImports }
    : base;
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
    shippedImports,
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
  shippedImports: ShippedImport[],
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

    // path string arrays pass through verbatim, so the on-wire manifest matches
    // the author's intent and the registry stores what was pushed.
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

    // copy each reached module to its planned path, rewriting resolved bare
    // imports to npm:, jsr:, node: or URL specifiers so the source resolves
    // without the project config
    const resolver = bareImportResolverFor(input);
    const versions = input.graphDependencies?.packageVersions ?? {};
    const codeModules = new Set([
      ...input.allModelFiles,
      ...input.allVaultFiles,
      ...input.allDatastoreFiles,
      ...input.allReportFiles,
      ...input.allWebhookFiles,
    ]);
    const shippedSites: { written: string; shipped: string; file: string }[] =
      [];
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
      if (
        codeModules.has(entry.sourcePath) ||
        CODE_MODULE_RE.test(entry.sourcePath)
      ) {
        text = await Deno.readTextFile(entry.sourcePath);
        const bare = resolver
          ? bareImportRewrites(text, resolver, entry.sourcePath).map((r) => ({
            ...r,
            to: canonicalTarget(r.to, versions, entry.sourcePath),
          }))
          : [];
        rewrites = mergeSpecifierRewrites(
          mergeSpecifierRewrites(entry.rewrites, bare),
          canonicalImportRewrites(text, entry.sourcePath, versions),
        );
        const at = (span: SpecifierRewrite["span"]) =>
          `${span.start.line}:${span.start.character}`;
        const to = new Map(rewrites.map((r) => [at(r.span), r.to]));
        for (const site of scanImportSites(text, entry.sourcePath) ?? []) {
          shippedSites.push({
            written: site.specifier,
            shipped: to.get(at(site.span)) ?? site.specifier,
            file: entry.archivePath,
          });
        }
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

    // a file the source plan already wrote keeps the plan's copy, which may
    // carry rewritten imports.
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

    for (const [entryName, js] of bundles) {
      const destPath = join(extDir, "bundles", `${entryName}.js`);
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await Deno.writeTextFile(destPath, js);
    }

    for (const wf of input.workflowFiles) {
      const destPath = join(extDir, "workflows", wf.archiveName);
      await Deno.copyFile(wf.sourcePath, destPath);
    }

    for (const [entryName, js] of vaultBundles) {
      const destPath = join(extDir, "vault-bundles", `${entryName}.js`);
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await Deno.writeTextFile(destPath, js);
    }

    for (const [entryName, js] of datastoreBundles) {
      const destPath = join(
        extDir,
        "datastore-bundles",
        `${entryName}.js`,
      );
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await Deno.writeTextFile(destPath, js);
    }

    for (const [entryName, js] of reportBundles) {
      const destPath = join(extDir, "report-bundles", `${entryName}.js`);
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await Deno.writeTextFile(destPath, js);
    }

    for (const [entryName, js] of webhookBundles) {
      const destPath = join(extDir, "webhook-bundles", `${entryName}.js`);
      await Deno.mkdir(dirname(destPath), { recursive: true });
      await Deno.writeTextFile(destPath, js);
    }

    // always written, so an empty record tells "nothing to audit" from an
    // archive that predates it; the bundle format lets a consumer tell it can
    // run these bundles.
    const record = buildDependencyAuditRecordV2({
      bundleFormat: BUNDLE_FORMAT_VERSION,
      imports: [
        ...shippedImports,
        ...unauditedImportsOf(
          shippedSites,
          shippedImports,
          versions,
          await projectLockInUse(input),
        ),
      ],
      bundles: await bundleHashes([
        ["bundles", bundles],
        ["vault-bundles", vaultBundles],
        ["datastore-bundles", datastoreBundles],
        ["report-bundles", reportBundles],
        ["webhook-bundles", webhookBundles],
      ]),
      unaudited: input.graphDependencies?.unaudited ?? [],
    });
    // Every npm: and jsr: import the archive's source writes keeps the
    // canonical form and names a version the record lists.
    for (const { shipped: specifier, file } of shippedSites) {
      const issue = canonicalShippedSpecifierIssue(specifier, record);
      if (issue) {
        throw validationFailed(
          `${file}: ${issue}. This is a bug in push; report it with the import.`,
        );
      }
    }
    await Deno.writeTextFile(
      join(extDir, DEPENDENCY_AUDIT_RECORD_FILENAME),
      serializeDependencyAuditRecordV2(record),
    );

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

    // additionalFiles (relative) and additionalFilePaths (absolute) are
    // parallel arrays; copy preserving the relative paths declared in the
    // manifest.
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

    // the archive never holds a symlink: staging copies files, so one here is a
    // bug, refused before it can be packaged.
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

const PROJECT_FILE_NAMES: ReadonlySet<string> = new Set([
  "deno.json",
  "deno.jsonc",
  "deno.lock",
  "package.json",
  "package-lock.json",
  ".npmrc",
]);

export function isProjectFile(path: string): boolean {
  const parts = path.split(/[\\/]/);
  return PROJECT_FILE_NAMES.has(parts[parts.length - 1]) ||
    parts.includes("node_modules");
}

/**
 * pull refuses config, lock and package files, and the archive's source ships
 * its dependencies pinned instead; one a module imports stays, so the
 * shared-source check refuses it by name
 */
function withoutProjectFiles(
  input: ExtensionPushPrepareInput,
): ExtensionPushPrepareInput {
  const imported = new Set(input.sourcePlan.entries.map((e) => e.sourcePath));
  const candidates = [
    ...input.additionalFilePaths,
    ...input.includeFilePaths,
  ].filter((path) => !imported.has(path));
  const left = new Set(candidates.filter(isProjectFile));
  if (left.size === 0) return input;
  return {
    ...withoutFiles(input, left),
    leftOutProjectFiles: [...left]
      .map((path) => relative(input.manifestDir, path).replaceAll("\\", "/"))
      .sort(),
  };
}

async function projectLockInUse(
  input: ExtensionPushPrepareInput,
): Promise<boolean> {
  const project = pushProject(input);
  return project !== undefined &&
    (await readOnlyLockFor(project)).lockPath !== undefined;
}

/**
 * noConfig rides with the package.json and no-project cases, so no config Deno
 * would discover above the repository applies.
 */
function pushProject(
  input: ExtensionPushPrepareInput,
): ExtensionProject | undefined {
  if (input.denoConfigPath) {
    return {
      denoConfigPath: input.denoConfigPath,
      ...(input.workspaceRootConfigPath
        ? { workspaceRootConfigPath: input.workspaceRootConfigPath }
        : {}),
    };
  }
  const noConfig = input.noConfig ? { noConfig: true } : {};
  if (input.packageJsonDir) {
    return { packageJsonDir: input.packageJsonDir, ...noConfig };
  }
  return input.noConfig ? { noConfig: true } : undefined;
}

/**
 * a version is locked when the bundle was built against a deno.lock or, for an
 * installed package, a package-lock.json that node_modules matches; a specifier
 * the graph cannot answer is left to the audit
 */
export function withBundledVersions(
  specifiers: readonly DependencySpecifier[],
  graph: GraphDependencies | undefined,
  denoLock: boolean,
): DependencySpecifier[] {
  return specifiers.map((spec) => {
    const lockedInstall = denoLock || graph?.packageLock?.valid === true;
    const locked = (yes: boolean) => yes ? { locked: true as const } : {};
    if (spec.installedVersion !== undefined) {
      return {
        ...spec,
        bundled: {
          version: spec.installedVersion,
          from: "installed",
          ...locked(lockedInstall),
        },
      };
    }
    const exact = exactVersion(spec.version);
    if (exact !== null) {
      return {
        ...spec,
        bundled: { version: exact, from: "exact", ...locked(denoLock) },
      };
    }
    const root = graph?.packageVersions[specifierText(spec)];
    if (root === undefined) return spec;
    const version = root.specifier.slice(root.specifier.lastIndexOf("@") + 1);
    return {
      ...spec,
      bundled: root.installed
        ? { version, from: "installed", ...locked(lockedInstall) }
        : denoLock
        ? { version, from: "lockfile", locked: true }
        : { version, from: "registry" },
    };
  });
}

function shippedImportsOf(
  specifiers: readonly DependencySpecifier[],
): ShippedImport[] {
  return specifiers.flatMap((spec) =>
    spec.bundled
      ? [{
        registry: spec.registry,
        name: spec.name,
        writtenAs: spec.importedAs ?? specifierText(spec),
        shipped: spec.bundled,
      }]
      : []
  );
}

async function bundleHashes(
  kinds: readonly [string, ReadonlyMap<string, string>][],
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const [dir, bundles] of kinds) {
    for (const [entryName, js] of bundles) {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(js),
      );
      hashes[`${dir}/${entryName.replaceAll("\\", "/")}.js`] = `sha256:${
        Array.from(
          new Uint8Array(digest),
          (b) => b.toString(16).padStart(2, "0"),
        )
          .join("")
      }`;
    }
  }
  return hashes;
}

const CODE_MODULE_RE = /\.(?:[cm]?[jt]s|[jt]sx)$/;

/**
 * covers shipped npm: and jsr: imports the audit did not read (a test module
 * the plan places, for one), so the record lists every version the archive's
 * source names.
 */
function unauditedImportsOf(
  sites: readonly { written: string; shipped: string }[],
  audited: readonly ShippedImport[],
  versions: PackageVersions,
  denoLock: boolean,
): ShippedImport[] {
  const known = new Set(
    audited.map((i) => `${i.registry}:${i.name}@${i.shipped.version}`),
  );
  const extra: ShippedImport[] = [];
  for (const { written, shipped } of sites) {
    const parsed = parseSpecifier(shipped);
    if (!parsed || parsed.version === null) continue;
    const key = `${parsed.registry}:${parsed.name}@${parsed.version}`;
    if (known.has(key)) continue;
    known.add(key);
    const writtenSpec = parseSpecifier(written);
    const exact = writtenSpec !== null && writtenSpec.version !== null &&
      exactVersion(writtenSpec.version) !== null;
    const installed = versions[written]?.installed === true;
    extra.push({
      registry: parsed.registry,
      name: parsed.name,
      writtenAs: written.replace(
        /^((?:npm|jsr):(?:@[^/@]+\/)?[^/@]+(?:@[^/]*)?).*$/,
        "$1",
      ),
      shipped: {
        version: parsed.version,
        from: exact
          ? "exact"
          : installed
          ? "installed"
          : denoLock
          ? "lockfile"
          : "registry",
        ...(denoLock ? { locked: true as const } : {}),
      },
    });
  }
  return extra;
}
