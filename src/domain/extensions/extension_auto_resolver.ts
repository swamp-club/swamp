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

import { AsyncLocalStorage } from "node:async_hooks";
import { getLogger } from "@logtape/logtape";
import { withSpan } from "../../infrastructure/tracing/tracer.ts";
import { CalVer } from "../models/calver.ts";
import { ModelType } from "../models/model_type.ts";
import { type ModelDefinition, modelRegistry } from "../models/model.ts";
import type { ExtensionContentMetadata } from "./extension_content.ts";
import { vaultTypeRegistry } from "../vaults/vault_type_registry.ts";
import { datastoreTypeRegistry } from "../datastore/datastore_type_registry.ts";
import { webhookTypeRegistry } from "../webhooks/webhook_type_registry.ts";
import {
  type LockInfo,
  LockTimeoutError,
} from "../datastore/distributed_lock.ts";
import { RegistryUnavailableError } from "./registry_unavailable_error.ts";

const logger = getLogger(["swamp", "extensions", "auto-resolver"]);

/** the full registry record, so one lookup can be handed on to the install */
export interface ExtensionLookupInfo {
  name: string;
  description: string;
  latestVersion: string | null;
  latestRc?: string | null;
  latestBeta?: string | null;
  deprecatedAt?: string | null;
  deprecationReason?: string | null;
  supersededBy?: string | null;
}

/** info is the direct lookup's record, or null when a search found the name */
export interface ExtensionMatch {
  name: string;
  info: ExtensionLookupInfo | null;
}

export interface ExtensionSearchResultEntry {
  name: string;
}

export interface ExtensionLookupPort {
  getExtension(name: string): Promise<ExtensionLookupInfo | null>;
  searchExtensions(params: {
    q?: string;
    collective?: string;
    perPage?: number;
  }): Promise<{ extensions: ExtensionSearchResultEntry[] }>;
  /** optional: a lookup without it cannot describe a type before install */
  getLatestVersionDetail?(
    name: string,
  ): Promise<{ contentMetadata: ExtensionContentMetadata | null } | null>;
}

export interface ExtensionInstallResultInfo {
  version: string;
}

/**
 * missing may carry lockedVersion so progress shows the pinned version;
 * truncated looks installed but lacks listed files; legacy is never migrated
 * here since that can delete tracked files
 */
export type InstallationInspection =
  | { state: "missing"; lockedVersion?: string }
  | {
    state: "intact";
    path: string;
    installedVersion?: string;
    loadFailures?: boolean;
  }
  | { state: "truncated"; path: string; missing: string[] }
  | { state: "legacy"; paths: string[] };

export interface ExtensionInstallerPort {
  inspectInstallation(
    extensionName: string,
  ): Promise<InstallationInspection>;
  /** extInfo is the record the resolver already looked up for extensionName */
  install(
    extensionName: string,
    extInfo: ExtensionLookupInfo,
  ): Promise<ExtensionInstallResultInfo | null>;
  hotLoadModels(): Promise<number>;
  hotLoadVaults(): Promise<void>;
  hotLoadDatastores(): Promise<void>;
  hotLoadWebhooks(): Promise<void>;
  /**
   * distinguishes a local indexing failure from an untrusted registry
   * collective
   */
  failedLocalSourceMatchesType(typeNormalized: string): boolean;
  /** serializes auto-installs across processes sharing the repository */
  withInstallLock<T>(fn: () => Promise<T>): Promise<T>;
  providesType(normalizedType: string): Promise<boolean>;
  /**
   * undefined when the installer cannot tell; the installed line then reports
   * only types this hot-load loaded, which is 0 when another caller loaded them
   * first
   */
  registeredModelCount?(extensionName: string): number | undefined;
}

export interface AutoResolveOutputPort {
  searching(type: string): void;
  installing(
    extension: string,
    version: string,
    description: string | undefined,
  ): void;
  installed(extension: string, version: string, modelsRegistered: number): void;
  notFound(type: string): void;
  networkError(type: string, error: string): void;
  /**
   * emitted instead of re-installing an extension on disk, because local edits
   * may be preventing the type from registering
   */
  alreadyInstalledButFailed(extension: string, path: string): void;
  /**
   * also emitted when a fresh install lacks the type; newerVersion is set when
   * the registry has a newer version that may provide it
   */
  installedWithoutType(
    extension: string,
    type: string,
    installedVersion: string | undefined,
    newerVersion: string | undefined,
  ): void;
  /**
   * the tree itself is broken (lockfile files missing), unlike
   * alreadyInstalledButFailed, so the user must re-pull with --force
   */
  alreadyInstalledTruncated(
    extension: string,
    path: string,
    missing: string[],
  ): void;
  /**
   * auto-resolution refuses to migrate a legacy location; the user must run
   * extension pull to accept the migration
   */
  legacyInstallation(extension: string, paths: string[]): void;
  /**
   * membership collectives are not trusted by default; this surfaces the swamp
   * extension trust add opt-in instead of an opaque unknown type error
   */
  collectiveNotTrusted(collective: string, type: string): void;
  /**
   * surfaces the real local failure with swamp doctor extensions guidance
   * instead of the misleading collectiveNotTrusted hint
   */
  localSourceFailed(type: string): void;
  noStableVersion(extension: string): void;
  /**
   * another process held the install lock longer than this one would wait;
   * holder is null when the lock file could not be read
   */
  installBusy(
    type: string,
    extension: string,
    holder: InstallLockHolder | null,
    waitedMs: number,
  ): void;
}

export type InstallLockHolder = Pick<LockInfo, "holder" | "hostname" | "pid">;

export interface ExtensionAutoResolverConfig {
  allowedCollectives: string[];
  extensionLookup: ExtensionLookupPort;
  extensionInstaller: ExtensionInstallerPort;
  output: AutoResolveOutputPort;
}

export class ExtensionAutoResolver {
  private readonly config: ExtensionAutoResolverConfig;
  /**
   * keyed by type without its leading @ so serve's two spellings share one; a
   * caller finding its type here awaits it rather than failing
   */
  private readonly inFlight = new Map<string, Promise<boolean>>();
  private readonly insideResolution = new AsyncLocalStorage<true>();
  /**
   * serve sets it so an install takes its turn with the per-run refresh of
   * local models and hot-reload, which rebundle the same sources
   */
  private installScheduler: <T>(fn: () => Promise<T>) => Promise<T> = (fn) =>
    fn();
  /**
   * several types from one untrusted collective show the trust hint once, not
   * once per type
   */
  private readonly warnedUntrusted = new Set<string>();

  constructor(config: ExtensionAutoResolverConfig) {
    this.config = config;
  }

  setInstallScheduler(
    scheduler: <T>(fn: () => Promise<T>) => Promise<T>,
  ): void {
    this.installScheduler = scheduler;
  }

  updateAllowedCollectives(collectives: string[]): void {
    this.config.allowedCollectives = collectives;
    this.warnedUntrusted.clear();
  }

  /**
   * returns null whenever the answer is unknown (untrusted collective, no
   * provider, no version detail, failed request); callers check after install
   * instead
   */
  async describeTypeInRegistry(
    normalizedType: string,
  ): Promise<ExtensionContentMetadata | null> {
    const lookup = this.config.extensionLookup;
    if (!lookup.getLatestVersionDetail) return null;
    const collective = this.extractCollective(normalizedType);
    if (!collective || !this.config.allowedCollectives.includes(collective)) {
      return null;
    }
    try {
      const match = await findExtensionForType(
        normalizedType,
        collective,
        lookup,
      );
      if (!match) return null;
      const detail = await lookup.getLatestVersionDetail(match.name);
      return detail?.contentMetadata ?? null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger
        .debug`Could not describe ${normalizedType} from the registry: ${message}`;
      return null;
    }
  }

  async resolve(normalizedType: string): Promise<boolean> {
    const key = normalizedType.startsWith("@")
      ? normalizedType.slice(1)
      : normalizedType;
    const running = this.inFlight.get(key);
    if (running) {
      // A call made from inside a resolution never waits for another: that
      // one may be waiting on the install lock this chain holds.
      if (this.insideResolution.getStore()) {
        logger.debug`Skipping re-entrant resolution for ${normalizedType}`;
        return false;
      }
      logger.debug`Waiting for the running resolution of ${normalizedType}`;
      return await running;
    }

    const collective = this.extractCollective(normalizedType);
    if (!collective) {
      logger.debug`Cannot extract collective from type ${normalizedType}`;
      return false;
    }

    if (!this.config.allowedCollectives.includes(collective)) {
      logger
        .debug`Collective '${collective}' not in trusted list, skipping auto-resolution`;
      if (
        ModelType.isUserNamespace(normalizedType) &&
        !this.warnedUntrusted.has(collective)
      ) {
        this.warnedUntrusted.add(collective);
        if (
          this.config.extensionInstaller.failedLocalSourceMatchesType(
            normalizedType,
          )
        ) {
          this.config.output.localSourceFailed(normalizedType);
        } else {
          this.config.output.collectiveNotTrusted(collective, normalizedType);
        }
      }
      return false;
    }

    const resolution = this.insideResolution.run(
      true,
      () => this.doResolve(normalizedType, collective),
    );
    this.inFlight.set(key, resolution);
    try {
      return await resolution;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private extractCollective(normalizedType: string): string | undefined {
    return typeCollective(normalizedType);
  }

  private async doResolve(
    normalizedType: string,
    collective: string,
  ): Promise<boolean> {
    const { output } = this.config;

    output.searching(normalizedType);

    try {
      const match = await withSpan(
        "swamp.extension.registry_lookup",
        { "swamp.extension.type": normalizedType },
        () =>
          findExtensionForType(
            normalizedType,
            collective,
            this.config.extensionLookup,
          ),
      );

      if (match) {
        return await this.installAndLoad(match, normalizedType);
      }

      output.notFound(normalizedType);
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.isNetworkError(error)) {
        output.networkError(normalizedType, message);
      } else {
        output.notFound(normalizedType);
        logger.debug`Auto-resolution error: ${message}`;
      }
      return false;
    }
  }

  private async installAndLoad(
    match: ExtensionMatch,
    normalizedType: string,
  ): Promise<boolean> {
    const { extensionLookup, extensionInstaller, output } = this.config;
    const extensionName = match.name;

    const extInfo = match.info ??
      await extensionLookup.getExtension(extensionName);
    if (!extInfo) return false;

    const version = extInfo.latestVersion;
    if (!version) {
      output.noStableVersion(extensionName);
      return false;
    }

    // Set once the install lock is held, so a lock timeout from work inside
    // the locked section is not mistaken for another process installing.
    let lockHeld = false;
    try {
      return await extensionInstaller.withInstallLock(() => {
        lockHeld = true;
        return this.installScheduler(() =>
          this.installAndLoadLocked(
            extensionName,
            normalizedType,
            extInfo,
            version,
          )
        );
      });
    } catch (error) {
      if (error instanceof LockTimeoutError && lockHeld) {
        logger.warn`${error.message}`;
        return false;
      }
      if (error instanceof LockTimeoutError) {
        logger.debug`${error.message}`;
        const holder = error.holder
          ? {
            holder: error.holder.holder,
            hostname: error.holder.hostname,
            pid: error.holder.pid,
          }
          : null;
        output.installBusy(
          normalizedType,
          extensionName,
          holder,
          error.waitedMs,
        );
        return false;
      }
      throw error;
    }
  }

  private async installAndLoadLocked(
    extensionName: string,
    normalizedType: string,
    extInfo: ExtensionLookupInfo,
    version: string,
  ): Promise<boolean> {
    const { extensionInstaller, output } = this.config;

    // inspect first: on-disk extensions are never overwritten without --force,
    // and a truncated tree gets its own error because the Unknown type fallback
    // hid the real cause
    const inspection = await extensionInstaller.inspectInstallation(
      extensionName,
    );
    if (inspection.state === "intact") {
      // another process may have installed the extension after this one loaded
      // its registries: load it before blaming the install
      const adopted = await this.hotLoadAll();
      if (await extensionInstaller.providesType(normalizedType)) {
        output.installed(
          extensionName,
          inspection.installedVersion ?? version,
          this.registeredModelCount(extensionName, adopted),
        );
        return true;
      }
      // blame local edits only when a source failed to load or the adapter
      // cannot tell; a clean load that lacks the type is usually an older
      // version
      if (inspection.loadFailures === false) {
        output.installedWithoutType(
          extensionName,
          normalizedType,
          inspection.installedVersion,
          newerVersionThan(inspection.installedVersion, version),
        );
      } else {
        output.alreadyInstalledButFailed(extensionName, inspection.path);
      }
      return false;
    }
    if (inspection.state === "truncated") {
      output.alreadyInstalledTruncated(
        extensionName,
        inspection.path,
        inspection.missing,
      );
      return false;
    }
    if (inspection.state === "legacy") {
      output.legacyInstallation(extensionName, inspection.paths);
      return false;
    }
    // report the lockfile-pinned version the installer honors, else
    // registry-latest, so the progress line matches what lands
    const versionToInstall = inspection.lockedVersion ?? version;

    output.installing(extensionName, versionToInstall, extInfo.description);

    let installResult: ExtensionInstallResultInfo | null;
    try {
      installResult = await extensionInstaller.install(extensionName, extInfo);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn`Failed to install extension ${extensionName}: ${message}`;
      return false;
    }

    if (!installResult) return false;

    const newModelsCount = await this.hotLoadAll();

    // a direct candidate is matched by name alone and a lookup without version
    // detail keeps an unchecked hit, so the install may lack the type: say so
    // rather than claim success
    if (!await extensionInstaller.providesType(normalizedType)) {
      output.installedWithoutType(
        extensionName,
        normalizedType,
        installResult.version,
        undefined,
      );
      return false;
    }

    output.installed(
      extensionName,
      installResult.version,
      this.registeredModelCount(extensionName, newModelsCount),
    );

    return true;
  }

  /**
   * The behavior types `extensionName` has registered, and never fewer than
   * the `loaded` this resolution's hot-load registered itself, in case the
   * installer cannot see them in its catalog.
   */
  private registeredModelCount(extensionName: string, loaded: number): number {
    return Math.max(
      this.config.extensionInstaller.registeredModelCount?.(extensionName) ??
        0,
      loaded,
    );
  }

  private async hotLoadAll(): Promise<number> {
    const { extensionInstaller } = this.config;
    return await withSpan("swamp.extension.hot_load", {}, async () => {
      const newModelsCount = await extensionInstaller.hotLoadModels();
      await extensionInstaller.hotLoadVaults();
      await extensionInstaller.hotLoadDatastores();
      await extensionInstaller.hotLoadWebhooks();
      return newModelsCount;
    });
  }

  private isNetworkError(error: unknown): boolean {
    if (error instanceof RegistryUnavailableError) {
      return true;
    }
    if (error instanceof TypeError) {
      return true;
    }
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return true;
    }
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      return msg.includes("connect") || msg.includes("timeout") ||
        msg.includes("network") || msg.includes("dns") ||
        msg.includes("econnrefused");
    }
    return false;
  }
}

function newerVersionThan(
  installed: string | undefined,
  latest: string,
): string | undefined {
  if (!installed || !CalVer.isValid(installed) || !CalVer.isValid(latest)) {
    return undefined;
  }
  return CalVer.compare(CalVer.create(latest), CalVer.create(installed)) > 0
    ? latest
    : undefined;
}

export function typeCollective(normalizedType: string): string | undefined {
  if (ModelType.isUserNamespace(normalizedType)) {
    return ModelType.getUserNamespace(normalizedType);
  }
  const firstSlash = normalizedType.indexOf("/");
  if (firstSlash === -1) return undefined;
  return normalizedType.slice(0, firstSlash);
}

export function extensionCandidateNames(normalizedType: string): string[] {
  const candidates: string[] = [];

  if (ModelType.getSegmentCount(normalizedType) >= 2) {
    const full = normalizedType.startsWith("@")
      ? normalizedType
      : `@${normalizedType}`;
    candidates.push(full);
  }

  let current = normalizedType;
  while (true) {
    const lastSlash = current.lastIndexOf("/");
    if (lastSlash === -1) break;
    current = current.slice(0, lastSlash);
    if (ModelType.getSegmentCount(current) >= 2) {
      const candidate = current.startsWith("@") ? current : `@${current}`;
      candidates.push(candidate);
    }
  }

  return candidates;
}

const SEARCH_CANDIDATE_LIMIT = 5;

/**
 * metadata carries types as written in source (@acme/Azure.Firewall) while the
 * resolver has them normalized (@acme/azure/firewall), so both sides are
 * compared normalized
 */
export function contentMetadataProvidesType(
  metadata: ExtensionContentMetadata,
  normalizedType: string,
): boolean {
  const wanted = normalizedTypeOrNull(normalizedType);
  if (wanted === null) return false;
  return [
    ...metadata.models,
    ...metadata.vaults,
    ...metadata.datastores,
    ...metadata.webhooks,
  ].some((entry) =>
    typeof entry?.type === "string" &&
    normalizedTypeOrNull(entry.type) === wanted
  );
}

function normalizedTypeOrNull(type: string): string | null {
  try {
    return ModelType.create(type).normalized;
  } catch {
    return null;
  }
}

/**
 * search ranks by words, so hits are guesses: return the top hit whose latest
 * metadata lists the type; without version detail keep the first hit and check
 * after install
 */
export async function findExtensionForType(
  normalizedType: string,
  collective: string,
  extensionLookup: ExtensionLookupPort,
): Promise<ExtensionMatch | null> {
  for (const candidate of extensionCandidateNames(normalizedType)) {
    logger.debug`Trying direct lookup: ${candidate}`;
    const extInfo = await extensionLookup.getExtension(candidate);
    if (extInfo) {
      return { name: candidate, info: extInfo };
    }
  }

  let searchTerms = normalizedType;
  if (searchTerms.startsWith("@")) {
    searchTerms = searchTerms.slice(1);
  }
  if (searchTerms.startsWith(collective + "/")) {
    searchTerms = searchTerms.slice(collective.length + 1);
  }
  searchTerms = searchTerms.replace(/\//g, " ");

  logger.debug`Search fallback: q=${searchTerms}, collective=${collective}`;

  const result = await extensionLookup.searchExtensions({
    q: searchTerms,
    collective,
    perPage: SEARCH_CANDIDATE_LIMIT,
  });
  const hits = result.extensions.slice(0, SEARCH_CANDIDATE_LIMIT);

  if (!extensionLookup.getLatestVersionDetail) {
    return hits[0] ? { name: hits[0].name, info: null } : null;
  }

  for (const hit of hits) {
    const detail = await extensionLookup.getLatestVersionDetail(hit.name);
    const metadata = detail?.contentMetadata;
    if (metadata && contentMetadataProvidesType(metadata, normalizedType)) {
      return { name: hit.name, info: null };
    }
    logger.debug`Search hit ${hit.name} does not provide ${normalizedType}`;
  }

  return null;
}

export async function resolveModelType(
  type: string | ModelType,
  resolver: ExtensionAutoResolver | null,
): Promise<ModelDefinition | undefined> {
  await modelRegistry.ensureTypeLoaded(type);
  const def = modelRegistry.get(type);
  if (def) return def;

  // internal types are registered without @ but the CLI adds it; check the
  // stripped form first since they are compiled in and must never cause a
  // registry fetch
  const normalized = typeof type === "string"
    ? ModelType.create(type).normalized
    : type.normalized;
  if (normalized.startsWith("@")) {
    const stripped = normalized.slice(1);
    if (modelRegistry.isInternal(stripped)) {
      await modelRegistry.ensureTypeLoaded(stripped);
      const internalDef = modelRegistry.get(stripped);
      if (internalDef) return internalDef;
    }
  }

  if (!resolver) return undefined;
  const resolved = await resolver.resolve(normalized);
  if (!resolved) return undefined;
  await modelRegistry.ensureTypeLoaded(type);
  return modelRegistry.get(type);
}

export async function resolveVaultType(
  type: string,
  resolver: ExtensionAutoResolver | null,
): Promise<boolean> {
  await vaultTypeRegistry.ensureTypeLoaded(type);
  if (vaultTypeRegistry.has(type)) return true;
  if (!resolver) return false;
  if (!type.startsWith("@")) return false;

  return await resolver.resolve(type);
}

export async function resolveDatastoreType(
  type: string,
  resolver: ExtensionAutoResolver | null,
): Promise<boolean> {
  await datastoreTypeRegistry.ensureTypeLoaded(type);
  if (datastoreTypeRegistry.has(type)) return true;
  if (!resolver) return false;
  if (!type.startsWith("@")) return false;

  // named span: a fresh checkout installs its datastore extension here
  return await withSpan(
    "swamp.extension.auto_resolve",
    { "swamp.extension.type": type },
    () => resolver.resolve(type),
  );
}

export async function resolveWebhookType(
  type: string,
  resolver: ExtensionAutoResolver | null,
): Promise<boolean> {
  await webhookTypeRegistry.ensureTypeLoaded(type);
  if (webhookTypeRegistry.has(type)) return true;
  if (!resolver) return false;
  if (!type.startsWith("@")) return false;

  return await resolver.resolve(type);
}
