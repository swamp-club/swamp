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
  extensionName?: string;
  sourceFingerprint?: string;
  /** The source as it stood at registration (swamp-club#3594). */
  sourceSnapshot?: SourceSnapshot;
}

export interface KindAdapter {
  readonly kind: LoaderKind;
  readonly bundleSubdir: string;
  readonly catalogKinds: readonly FreshnessKind[];
  readonly primaryExportKey: string;
  /**
   * Other export names that declare the primary kind, e.g. `behavior` for
   * the model kind (swamp-club#3338). A module exports the key or one
   * alias, never two of them: read it through {@link primaryExport}.
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

  // Returns true if the type is registered in any form — including
  // lazy entries from buildIndex that haven't been promoted yet.
  // Use for "is this type known?" checks (e.g., duplicate detection
  // during load/register).
  hasType(typeNormalized: string): boolean;

  // Returns true only if the type is fully loaded — bundle imported,
  // definition constructed, ready for invocation. Returns false for
  // lazy entries. Use for "should I skip the import?" checks (e.g.,
  // importAndRegisterBundle's early-return guard).
  isFullyLoaded(typeNormalized: string): boolean;

  updateSourceFingerprint?(
    typeNormalized: string,
    fingerprint: string,
  ): void;

  validateNamespace?(rawType: string): string | undefined;

  /**
   * Attaches a secondary export (e.g. `export const extension`) to its
   * target type. `contributor` ranks it against other extensions that add
   * the same member (swamp-club#2562); `attach`, when known, marks the
   * catalog source attached so later attach passes skip it.
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

/**
 * The names of every export that declares `adapter`'s primary kind: its
 * key first, then its aliases.
 */
export function primaryExportNames(
  adapter: Pick<KindAdapter, "primaryExportKey" | "primaryExportAliases">,
): readonly string[] {
  return [adapter.primaryExportKey, ...(adapter.primaryExportAliases ?? [])];
}

/**
 * True when an alias export reads as a definition: an object with both a
 * `type` and `methods`, as every model definition has. A module that
 * predates the alias may export an unrelated binding of the same name
 * (`export const behavior = "strict"`, or a config object such as
 * `{ type: "retry" }`); such a binding neither makes a helper module an
 * entry point nor collides with the module's real export, so a file that
 * loaded, or was skipped as a helper, before the alias still does.
 */
function isDefinitionLike(value: unknown): boolean {
  return typeof value === "object" && value !== null && "type" in value &&
    "methods" in value;
}

/**
 * The module's primary export, under the adapter's key or one of its
 * aliases (`model` or `behavior` for models), or undefined when it has
 * none. An alias counts only when it reads as a definition (see
 * {@link isDefinitionLike}). Throws when the module exports the key and an
 * alias, or two aliases, as definitions: which one it means cannot be
 * told, so the module is refused rather than one of them winning silently.
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
