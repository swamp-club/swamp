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

import type { ReportDefinition, ReportScope } from "./report.ts";

/**
 * Metadata for a lazily-indexed report type. The type is known to exist
 * (from the bundle catalog) but its bundle has not been imported yet.
 */
export interface LazyReportEntry {
  type: string;
  bundlePath: string;
  sourcePath: string;
  version: string;
}

/**
 * Registry of all known report definitions.
 *
 * Supports lazy loading of user extensions via {@link setLoader} and
 * {@link ensureLoaded}. With per-bundle lazy loading, the registry also
 * tracks "lazy entries" — types that are known to exist (from the bundle
 * catalog) but whose bundles have not been imported yet.
 */
export class ReportRegistry {
  private reports = new Map<string, ReportDefinition>();
  private readonly lazyTypes = new Map<string, LazyReportEntry>();
  private extensionLoader: (() => Promise<void>) | null = null;
  private extensionLoadPromise: Promise<void> | null = null;
  private extensionsLoaded = false;
  private typeLoadPromises = new Map<string, Promise<void>>();
  private typeLoader: ((type: string) => Promise<void>) | null = null;

  /** Configures the lazy loader for user report extensions. */
  setLoader(loader: () => Promise<void>): void {
    this.extensionLoader = loader;
  }

  /** Configures the per-type loader for on-demand bundle imports. */
  setTypeLoader(loader: (type: string) => Promise<void>): void {
    this.typeLoader = loader;
  }

  /**
   * Registers a lazy report entry — a type known to exist from the bundle
   * catalog but not yet imported. Does nothing if the type is already
   * registered (either fully loaded or lazy).
   */
  registerLazy(entry: LazyReportEntry): void {
    const key = entry.type;
    if (this.reports.has(key) || this.lazyTypes.has(key)) return;
    this.lazyTypes.set(key, entry);
  }

  /** Returns true if a type is registered as lazy (not yet imported). */
  isLazy(name: string): boolean {
    return this.lazyTypes.has(name);
  }

  /** Ensures user report extensions have been loaded. */
  async ensureLoaded(): Promise<void> {
    if (this.extensionsLoaded) return;
    if (!this.extensionLoader) return;
    if (!this.extensionLoadPromise) {
      const loader = this.extensionLoader;
      this.extensionLoadPromise = loader().then(() => {
        this.extensionsLoaded = true;
      });
    }
    await this.extensionLoadPromise;
  }

  /**
   * Ensures a specific report type's bundle has been imported.
   * If the type is lazy, invokes the type loader to import just that bundle.
   * Concurrent callers for the same type share the same promise.
   */
  async ensureTypeLoaded(name: string): Promise<void> {
    if (this.reports.has(name)) return;
    if (!this.lazyTypes.has(name)) return;

    if (!this.typeLoader) {
      await this.ensureLoaded();
      return;
    }

    let promise = this.typeLoadPromises.get(name);
    if (!promise) {
      const loader = this.typeLoader;
      promise = loader(name).then(() => {
        this.typeLoadPromises.delete(name);
      }).catch((err) => {
        this.typeLoadPromises.delete(name);
        throw err;
      });
      this.typeLoadPromises.set(name, promise);
    }
    await promise;
  }

  /**
   * Promotes a lazy entry to a fully loaded report.
   * Called by the type loader after importing a bundle.
   */
  promoteFromLazy(name: string, report: ReportDefinition): void {
    this.lazyTypes.delete(name);
    if (!this.reports.has(name)) {
      this.register(name, report);
    }
  }

  /**
   * Registers a report definition.
   *
   * @param name - Unique name for the report
   * @param report - The report definition
   * @throws If a report with the same name is already registered
   */
  register(name: string, report: ReportDefinition): void {
    if (this.reports.has(name)) {
      throw new Error(`Report already registered: ${name}`);
    }
    this.reports.set(name, report);
  }

  /**
   * Gets a report definition by name. Returns undefined for lazy types.
   */
  get(name: string): ReportDefinition | undefined {
    return this.reports.get(name);
  }

  /**
   * Returns all fully loaded reports.
   */
  getAll(): Array<{ name: string; report: ReportDefinition }> {
    return Array.from(this.reports.entries()).map(([name, report]) => ({
      name,
      report,
    }));
  }

  /**
   * Returns all lazy report entries (not yet imported).
   */
  getAllLazy(): LazyReportEntry[] {
    return Array.from(this.lazyTypes.values());
  }

  /**
   * Returns all reports matching a specific scope.
   */
  getByScope(
    scope: ReportScope,
  ): Array<{ name: string; report: ReportDefinition }> {
    return this.getAll().filter(({ report }) => report.scope === scope);
  }

  /**
   * Checks if a report is registered (either fully loaded or lazy).
   */
  has(name: string): boolean {
    return this.reports.has(name) || this.lazyTypes.has(name);
  }
}

/**
 * Global report registry instance.
 *
 * Uses globalThis so that the same registry is shared across module
 * boundaries (e.g., when extensions are loaded outside the bundle).
 */
const REPORT_REGISTRY_KEY = "__swampReportRegistry";
// deno-lint-ignore no-explicit-any
export const reportRegistry: ReportRegistry = (globalThis as any)[
  REPORT_REGISTRY_KEY
] ??= new ReportRegistry();
