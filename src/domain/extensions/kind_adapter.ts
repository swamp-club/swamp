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

import type { z } from "zod";
import type {
  ExtensionCatalogStore,
  ExtensionKind,
  ExtensionTypeRow,
} from "../../infrastructure/persistence/extension_catalog_store.ts";
import type { DenoRuntime } from "../runtime/deno_runtime.ts";
import type { FreshnessKind } from "./bundle_freshness.ts";
import type { ExtensionContributor } from "./extension_precedence.ts";
import type { SourceSnapshot } from "./source_snapshot.ts";
import { UserError } from "../errors.ts";

export type LoaderKind =
  | "model"
  | "vault"
  | "datastore"
  | "report"
  | "webhook";

export type ValidationResult =
  | { success: true; data: Record<string, unknown> }
  | { success: false; error: z.ZodError };

export interface ExtensionLoadResult {
  loaded: string[];
  extended: string[];
  failed: Array<{
    file: string;
    error: string;
    originalError?: unknown;
    baseDir?: string;
  }>;
}

export interface BundleIndexResult {
  kind: ExtensionKind;
  typeNormalized: string;
  bundlePath: string;
  fingerprint: string;
  fromCache: boolean;
}

export interface RegistrationContext {
  absolutePath: string;
  denoPath: string;
  denoRuntime: DenoRuntime;
  repoDir: string | null;
  /** the source is a pulled extension's, so its rebuilds read no Deno config */
  pulled?: boolean;
  extensionName?: string;
  sourceFingerprint?: string;
  sourceSnapshot?: SourceSnapshot;
}

export interface KindAdapter {
  readonly kind: LoaderKind;
  readonly bundleSubdir: string;
  readonly catalogKinds: readonly FreshnessKind[];
  readonly primaryExportKey: string;
  /**
   * other export names that declare the primary kind, e.g. behavior for model;
   * a module exports the key or one alias, never two, so read it through
   * primaryExport
   */
  readonly primaryExportAliases?: readonly string[];
  readonly secondaryExportKey?: string;
  readonly exportRegex: RegExp;
  readonly useResolver: boolean;

  validatePrimaryExport(exported: unknown): ValidationResult;

  validateSecondaryExport?(exported: unknown): ValidationResult;

  formatValidationError(error: z.ZodError): string;

  normalizeType(validated: Record<string, unknown>): string;

  extractTypeFromSource(
    source: string,
  ): {
    typeNormalized: string;
    version: string;
    kind: ExtensionKind;
    extendsType: string;
  } | null;

  register(
    typeNormalized: string,
    validated: Record<string, unknown>,
    module: Record<string, unknown>,
    context: RegistrationContext,
  ): void;

  registerLazy(entry: ExtensionTypeRow): void;

  promoteFromLazy(
    typeNormalized: string,
    validated: Record<string, unknown>,
    module: Record<string, unknown>,
    context: RegistrationContext,
  ): void;

  // true if registered in any form, including lazy entries not yet promoted;
  // for 'is this type known?' checks such as duplicate detection
  hasType(typeNormalized: string): boolean;

  // true only when fully loaded (bundle imported, definition built), false for
  // lazy entries; for 'skip the import?' checks
  isFullyLoaded(typeNormalized: string): boolean;

  updateSourceFingerprint?(
    typeNormalized: string,
    fingerprint: string,
  ): void;

  validateNamespace?(rawType: string): string | undefined;

  /**
   * contributor ranks it against other extensions adding the same member;
   * attach, when known, marks the catalog source attached so later attach
   * passes skip it
   */
  processSecondaryExport?(
    file: string,
    exported: unknown,
    result: ExtensionLoadResult,
    contributor: ExtensionContributor,
    attach?: { readonly sourcePath: string; readonly fingerprint: string },
  ): void;

  findExtensionsForType?(
    catalog: ExtensionCatalogStore,
    typeNormalized: string,
  ): ExtensionTypeRow[];

  importAndExtendBundle?(
    entry: ExtensionTypeRow,
    importFn: (
      paths: {
        bundlePath: string;
        sourcePath: string;
        sourceFingerprint?: string;
      },
    ) => Promise<Record<string, unknown>>,
    result: ExtensionLoadResult,
    contributor: ExtensionContributor,
  ): Promise<void>;

  attachPendingExtensionsForType?(
    typeNormalized: string,
    catalog: ExtensionCatalogStore,
    importFn: (
      paths: {
        bundlePath: string;
        sourcePath: string;
        sourceFingerprint?: string;
      },
    ) => Promise<Record<string, unknown>>,
    contributorFor: (sourcePath: string) => ExtensionContributor,
  ): Promise<void>;

  migrateOldFlatBundles?(repoDir: string, additionalDirs?: string[]): void;

  resolveDenoConfig?(
    absolutePath: string,
    repoDir: string | null,
  ): string | undefined;
}

export function primaryExportNames(
  adapter: Pick<KindAdapter, "primaryExportKey" | "primaryExportAliases">,
): readonly string[] {
  return [adapter.primaryExportKey, ...(adapter.primaryExportAliases ?? [])];
}

/**
 * an alias export counts only with type and methods: an older module may export
 * an unrelated binding of that name, which must not make a helper an entry
 * point or collide with its real export
 */
function isDefinitionLike(value: unknown): boolean {
  return typeof value === "object" && value !== null && "type" in value &&
    "methods" in value;
}

/**
 * an alias counts only when it reads as a definition; throws when the key and
 * an alias, or two aliases, are definitions, since which is meant cannot be
 * told
 */
export function primaryExport(
  module: Record<string, unknown>,
  adapter: Pick<KindAdapter, "primaryExportKey" | "primaryExportAliases">,
): unknown {
  const key = adapter.primaryExportKey;
  const hasKey = Boolean(module[key]);
  const names = [
    ...(hasKey ? [key] : []),
    ...(adapter.primaryExportAliases ?? []).filter((alias) =>
      isDefinitionLike(module[alias])
    ),
  ];
  if (names.length > 1) {
    throw new UserError(
      `Module exports both ${
        names.map((n) => `'${n}'`).join(" and ")
      }; export only one of them. '${names[1]}' is another spelling of '${
        names[0]
      }'.`,
    );
  }
  return names.length === 1 ? module[names[0]] : undefined;
}
