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

import { getLogger } from "@logtape/logtape";
import { ModelType } from "../models/model_type.ts";
import { type ModelDefinition, modelRegistry } from "../models/model.ts";
import { vaultTypeRegistry } from "../vaults/vault_type_registry.ts";
import { datastoreTypeRegistry } from "../datastore/datastore_type_registry.ts";

const logger = getLogger(["swamp", "extensions", "auto-resolver"]);

/**
 * Port: information about an extension from the registry.
 */
export interface ExtensionLookupInfo {
  name: string;
  description: string;
  latestVersion: string;
}

/**
 * Port: search result entry from the registry.
 */
export interface ExtensionSearchResultEntry {
  name: string;
}

/**
 * Port: interface for looking up extensions in a registry.
 * Decouples the domain service from the HTTP client.
 */
export interface ExtensionLookupPort {
  getExtension(name: string): Promise<ExtensionLookupInfo | null>;
  searchExtensions(params: {
    q?: string;
    collective?: string;
    perPage?: number;
  }): Promise<{ extensions: ExtensionSearchResultEntry[] }>;
}

/**
 * Port: result of installing an extension.
 */
export interface ExtensionInstallResultInfo {
  version: string;
}

/**
 * Tri-state result describing the on-disk state of a pulled extension.
 *
 * - `missing`: no lockfile entry, or the per-extension directory does
 *   not exist. The auto-resolver should proceed to install.
 * - `intact`: lockfile entry exists, the directory exists, and every
 *   file listed in the lockfile is present on disk. If the type still
 *   failed to register, the cause is local (e.g. user edits with a
 *   syntax error) — see `AutoResolveOutputPort.alreadyInstalledButFailed`.
 * - `truncated`: lockfile entry + directory both exist, but one or more
 *   files the lockfile lists are absent from disk. This is the
 *   "present but incomplete" state that looks installed to a directory
 *   stat but produces `Unknown <kind> type` errors downstream. See
 *   swamp-club#133.
 */
export type InstallationInspection =
  | { state: "missing" }
  | { state: "intact"; path: string }
  | { state: "truncated"; path: string; missing: string[] };

/**
 * Port: interface for installing extensions and hot-loading them.
 * Decouples the domain service from the CLI install infrastructure.
 */
export interface ExtensionInstallerPort {
  /**
   * Inspects the on-disk state of a pulled extension. The domain
   * service uses the tri-state return to pick the right branch:
   * install (missing), surface the "local edits" error (intact), or
   * surface the "truncated tree" error (truncated). Carries the
   * install path on the non-missing variants so the domain service
   * can include it in error output without reaching into
   * infrastructure.
   */
  inspectInstallation(
    extensionName: string,
  ): Promise<InstallationInspection>;
  install(extensionName: string): Promise<ExtensionInstallResultInfo | null>;
  hotLoadModels(): Promise<number>;
  hotLoadVaults(): Promise<void>;
  hotLoadDatastores(): Promise<void>;
}

/**
 * Port: interface for rendering auto-resolution output.
 * Decouples the domain service from the presentation layer.
 */
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
   * Emitted when auto-resolution finds an extension on disk but refuses
   * to re-install it because local edits may be preventing the type
   * from registering. Gives the user the file path and the explicit
   * opt-in command to reset to the registry version.
   */
  alreadyInstalledButFailed(extension: string, path: string): void;
  /**
   * Emitted when auto-resolution finds a pulled extension directory
   * that is incomplete — the lockfile says certain files should be
   * present but they are missing on disk. Distinct from
   * `alreadyInstalledButFailed` (which covers intact-but-fails-to-load):
   * here the tree itself is broken, so the user needs to re-pull with
   * `--force` to repair. See swamp-club#133.
   */
  alreadyInstalledTruncated(
    extension: string,
    path: string,
    missing: string[],
  ): void;
}

/**
 * Configuration for the ExtensionAutoResolver.
 */
export interface ExtensionAutoResolverConfig {
  allowedCollectives: string[];
  extensionLookup: ExtensionLookupPort;
  extensionInstaller: ExtensionInstallerPort;
  output: AutoResolveOutputPort;
}

/**
 * Domain service for automatically resolving unknown model/vault types
 * by searching the extension registry, installing matching extensions,
 * and hot-loading them into the live registries.
 */
export class ExtensionAutoResolver {
  private readonly config: ExtensionAutoResolverConfig;
  private readonly resolving = new Set<string>();

  constructor(config: ExtensionAutoResolverConfig) {
    this.config = config;
  }

  /**
   * Attempts to resolve an unknown type by finding and installing
   * the extension that provides it.
   *
   * Returns true if resolution succeeded (extension installed and loaded),
   * false otherwise.
   */
  async resolve(normalizedType: string): Promise<boolean> {
    // Re-entrancy guard
    if (this.resolving.has(normalizedType)) {
      logger.debug`Skipping re-entrant resolution for ${normalizedType}`;
      return false;
    }

    // Check if the collective is allowlisted
    const collective = this.extractCollective(normalizedType);
    if (!collective) {
      logger.debug`Cannot extract collective from type ${normalizedType}`;
      return false;
    }

    if (!this.config.allowedCollectives.includes(collective)) {
      logger
        .debug`Collective '${collective}' not in trusted list, skipping auto-resolution`;
      return false;
    }

    this.resolving.add(normalizedType);
    try {
      return await this.doResolve(normalizedType, collective);
    } finally {
      this.resolving.delete(normalizedType);
    }
  }

  /**
   * Extracts the collective name from a normalized type string.
   * e.g., "@swamp/aws/ec2/instance" -> "swamp"
   *        "swamp/echo" -> "swamp"
   */
  private extractCollective(normalizedType: string): string | undefined {
    if (ModelType.isUserNamespace(normalizedType)) {
      return ModelType.getUserNamespace(normalizedType);
    }
    const firstSlash = normalizedType.indexOf("/");
    if (firstSlash === -1) return undefined;
    return normalizedType.slice(0, firstSlash);
  }

  /**
   * Core resolution logic: direct lookup, then search fallback.
   */
  private async doResolve(
    normalizedType: string,
    collective: string,
  ): Promise<boolean> {
    const { output } = this.config;

    output.searching(normalizedType);

    try {
      // Step 1: Direct lookup — strip trailing segments and try getExtension
      const extensionName = await this.directLookup(
        normalizedType,
        collective,
      );

      if (extensionName) {
        return await this.installAndLoad(extensionName);
      }

      // Step 2: Search fallback
      const searchResult = await this.searchFallback(
        normalizedType,
        collective,
      );

      if (searchResult) {
        return await this.installAndLoad(searchResult);
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

  /**
   * Tries to find an extension by progressively stripping trailing segments
   * from the type. For "@swamp/aws/ec2/instance", tries:
   *   1. @swamp/aws/ec2
   *   2. @swamp/aws
   */
  private async directLookup(
    normalizedType: string,
    _collective: string,
  ): Promise<string | null> {
    const { extensionLookup } = this.config;

    const candidates = this.buildCandidateNames(normalizedType);

    for (const candidate of candidates) {
      logger.debug`Trying direct lookup: ${candidate}`;
      const extInfo = await extensionLookup.getExtension(candidate);
      if (extInfo) {
        return candidate;
      }
    }

    return null;
  }

  /**
   * Builds candidate extension names by stripping trailing segments.
   * For "@swamp/aws/ec2/instance":
   *   ["@swamp/aws/ec2", "@swamp/aws"]
   */
  private buildCandidateNames(normalizedType: string): string[] {
    const candidates: string[] = [];

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

  /**
   * Falls back to searching the registry with a text query derived from the type.
   */
  private async searchFallback(
    normalizedType: string,
    collective: string,
  ): Promise<string | null> {
    const { extensionLookup } = this.config;

    // Convert type to search terms: "@swamp/aws/ec2/instance" -> "aws ec2 instance"
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
      perPage: 1,
    });

    if (result.extensions.length > 0) {
      return result.extensions[0].name;
    }

    return null;
  }

  /**
   * Installs an extension and hot-loads its models/vaults into live registries.
   */
  private async installAndLoad(extensionName: string): Promise<boolean> {
    const { extensionLookup, extensionInstaller, output } = this.config;

    // Get extension info for display
    const extInfo = await extensionLookup.getExtension(extensionName);
    if (!extInfo) return false;

    const version = extInfo.latestVersion;
    if (!version) return false;

    // Inspect the on-disk state before deciding to install. Issue #121
    // introduced the "never overwrite on-disk extensions without --force"
    // rule to protect user WIP; swamp-club#133 extended that rule to
    // cover the truncated case (present but incomplete) with a distinct
    // error because the misleading "Unknown <kind> type" fallback was
    // hiding the real cause.
    const inspection = await extensionInstaller.inspectInstallation(
      extensionName,
    );
    if (inspection.state === "intact") {
      output.alreadyInstalledButFailed(extensionName, inspection.path);
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
    // inspection.state === "missing" — proceed to install.

    output.installing(extensionName, version, extInfo.description);

    // Install the extension
    let installResult: ExtensionInstallResultInfo | null;
    try {
      installResult = await extensionInstaller.install(extensionName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn`Failed to install extension ${extensionName}: ${message}`;
      return false;
    }

    if (!installResult) return false;

    // Hot-load newly installed models, vaults, and datastores
    const newModelsCount = await extensionInstaller.hotLoadModels();
    await extensionInstaller.hotLoadVaults();
    await extensionInstaller.hotLoadDatastores();

    output.installed(extensionName, installResult.version, newModelsCount);

    return true;
  }

  /**
   * Checks if an error is a network-level error.
   */
  private isNetworkError(error: unknown): boolean {
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

/**
 * Standalone helper function for resolving model types at choke points.
 *
 * Checks the registry first (sync fast path), then falls back to
 * auto-resolution if a resolver is available.
 */
export async function resolveModelType(
  type: string | ModelType,
  resolver: ExtensionAutoResolver | null,
): Promise<ModelDefinition | undefined> {
  // Try lazy loading first — the type may be indexed but not imported yet
  await modelRegistry.ensureTypeLoaded(type);
  const def = modelRegistry.get(type);
  if (def) return def;
  if (!resolver) return undefined;

  const normalized = typeof type === "string"
    ? ModelType.create(type).normalized
    : type.normalized;
  const resolved = await resolver.resolve(normalized);
  if (resolved) return modelRegistry.get(type);
  return undefined;
}

/**
 * Standalone helper function for resolving vault types at choke points.
 *
 * Checks the vault type registry first (sync fast path), then falls back
 * to auto-resolution if a resolver is available.
 */
export async function resolveVaultType(
  type: string,
  resolver: ExtensionAutoResolver | null,
): Promise<boolean> {
  // Try lazy loading first — the type may be indexed but not imported yet
  await vaultTypeRegistry.ensureTypeLoaded(type);
  if (vaultTypeRegistry.has(type)) return true;
  if (!resolver) return false;
  if (!type.startsWith("@")) return false;

  return await resolver.resolve(type);
}

/**
 * Standalone helper function for resolving datastore types at choke points.
 *
 * Checks the datastore type registry first (sync fast path), then falls back
 * to auto-resolution if a resolver is available.
 */
export async function resolveDatastoreType(
  type: string,
  resolver: ExtensionAutoResolver | null,
): Promise<boolean> {
  // Try lazy loading first — the type may be indexed but not imported yet
  await datastoreTypeRegistry.ensureTypeLoaded(type);
  if (datastoreTypeRegistry.has(type)) return true;
  if (!resolver) return false;
  if (!type.startsWith("@")) return false;

  return await resolver.resolve(type);
}
