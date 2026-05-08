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

import type { z } from "zod";
import type {
  ExtensionCatalogStore,
  ExtensionKind,
  ExtensionTypeRow,
} from "../../infrastructure/persistence/extension_catalog_store.ts";
import type { DenoRuntime } from "../runtime/deno_runtime.ts";

export type LoaderKind = "model" | "vault" | "driver" | "datastore" | "report";

export type ValidationResult =
  | { success: true; data: Record<string, unknown> }
  | { success: false; error: z.ZodError };

export interface ExtensionLoadResult {
  loaded: string[];
  extended: string[];
  failed: Array<{ file: string; error: string }>;
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
}

export interface KindAdapter {
  readonly kind: LoaderKind;
  readonly bundleSubdir: string;
  readonly catalogKinds: readonly ExtensionKind[];
  readonly primaryExportKey: string;
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

  validateNamespace?(rawType: string): string | undefined;

  processSecondaryExport?(
    file: string,
    exported: unknown,
    result: ExtensionLoadResult,
  ): void;

  findExtensionsForType?(
    catalog: ExtensionCatalogStore,
    typeNormalized: string,
  ): ExtensionTypeRow[];

  importAndExtendBundle?(
    entry: ExtensionTypeRow,
    importFn: (
      paths: { bundlePath: string; sourcePath: string },
    ) => Promise<Record<string, unknown>>,
    result: ExtensionLoadResult,
  ): Promise<void>;

  attachPendingExtensionsForType?(
    typeNormalized: string,
    catalog: ExtensionCatalogStore,
    importFn: (
      paths: { bundlePath: string; sourcePath: string },
    ) => Promise<Record<string, unknown>>,
  ): Promise<void>;

  migrateOldFlatBundles?(repoDir: string, additionalDirs?: string[]): void;

  resolveDenoConfig?(
    absolutePath: string,
    repoDir: string | null,
  ): string | undefined;
}
