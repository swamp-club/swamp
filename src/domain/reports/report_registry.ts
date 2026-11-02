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

import type { ReportDefinition, ReportScope } from "./report.ts";

export interface LazyReportEntry {
  type: string;
  bundlePath: string;
  sourcePath: string;
  version: string;
}

export class ReportRegistry {
  private reports = new Map<string, ReportDefinition>();
  private readonly lazyTypes = new Map<string, LazyReportEntry>();
  private readonly builtInNames = new Set<string>();
  private extensionLoader: (() => Promise<void>) | null = null;
  private extensionLoadPromise: Promise<void> | null = null;
  private extensionsLoaded = false;
  private typeLoadPromises = new Map<string, Promise<void>>();
  private typeLoader: ((type: string) => Promise<void>) | null = null;

  setLoader(loader: () => Promise<void>): void {
    this.extensionLoader = loader;
  }

  setTypeLoader(loader: (type: string) => Promise<void>): void {
    this.typeLoader = loader;
  }

  registerLazy(entry: LazyReportEntry): void {
    const key = entry.type;
    if (this.reports.has(key) || this.lazyTypes.has(key)) return;
    this.lazyTypes.set(key, entry);
  }

  isLazy(name: string): boolean {
    return this.lazyTypes.has(name);
  }

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

  resetLoadedFlag(): void {
    this.extensionsLoaded = false;
    this.extensionLoadPromise = null;
  }

  /**
   * test-only: removes the configured loaders and loaded state; does not
   * restore loaders set before the test or clear already-registered types
   */
  clearLoadersForTesting(): void {
    this.extensionLoader = null;
    this.typeLoader = null;
    this.extensionsLoaded = false;
    this.extensionLoadPromise = null;
  }

  invalidateType(name: string): void {
    this.reports.delete(name);
    this.lazyTypes.delete(name);
    this.typeLoadPromises.delete(name);
  }

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
        // a loader that skipped a stale or broken bundle never promoted the
        // type; drop the lazy entry so later lookups report it as unknown
        // instead of retrying
        if (!this.reports.has(name)) {
          this.lazyTypes.delete(name);
        }
        this.typeLoadPromises.delete(name);
      }).catch((err) => {
        this.typeLoadPromises.delete(name);
        throw err;
      });
      this.typeLoadPromises.set(name, promise);
    }
    await promise;
  }

  promoteFromLazy(name: string, report: ReportDefinition): void {
    this.lazyTypes.delete(name);
    if (!this.reports.has(name)) {
      this.register(name, report);
    }
  }

  register(name: string, report: ReportDefinition): void {
    if (this.reports.has(name)) {
      throw new Error(`Report already registered: ${name}`);
    }
    this.reports.set(name, report);
  }

  /** built-in reports cannot be replaced or removed by pulled extensions */
  registerBuiltIn(name: string, report: ReportDefinition): void {
    this.register(name, report);
    this.builtInNames.add(name.toLowerCase());
  }

  /** matches any letter case because pulled report rows carry lowercased names */
  isBuiltIn(name: string): boolean {
    return this.builtInNames.has(name.toLowerCase());
  }

  get(name: string): ReportDefinition | undefined {
    return this.reports.get(name);
  }

  getAll(): Array<{ name: string; report: ReportDefinition }> {
    return Array.from(this.reports.entries()).map(([name, report]) => ({
      name,
      report,
    }));
  }

  getAllLazy(): LazyReportEntry[] {
    return Array.from(this.lazyTypes.values());
  }

  getByScope(
    scope: ReportScope,
  ): Array<{ name: string; report: ReportDefinition }> {
    return this.getAll().filter(({ report }) => report.scope === scope);
  }

  has(name: string): boolean {
    return this.reports.has(name) || this.lazyTypes.has(name);
  }
}

/**
 * kept on globalThis so one registry is shared across module boundaries, e.g.
 * extensions loaded outside the bundle
 */
const REPORT_REGISTRY_KEY = "__swampReportRegistry";
// deno-lint-ignore no-explicit-any
export const reportRegistry: ReportRegistry = (globalThis as any)[
  REPORT_REGISTRY_KEY
] ??= new ReportRegistry();
