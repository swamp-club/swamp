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

import type { CreekDefinition, LazyCreekEntry } from "./creek.ts";

/**
 * Registry of all known creek definitions. Supports lazy loading from the
 * extension bundle catalog (see {@link setLoader} / {@link setTypeLoader}).
 *
 * Type keys are stored lowercased to match the case-insensitive normalisation
 * used by the extension catalog. Callers may pass either form to {@link get}
 * / {@link has} / {@link ensureTypeLoaded}.
 */
export class CreekRegistry {
  private readonly creeks = new Map<string, CreekDefinition>();
  private readonly lazyTypes = new Map<string, LazyCreekEntry>();
  private extensionLoader: (() => Promise<void>) | null = null;
  private extensionLoadPromise: Promise<void> | null = null;
  private extensionsLoaded = false;
  private readonly typeLoadPromises = new Map<string, Promise<void>>();
  private typeLoader: ((type: string) => Promise<void>) | null = null;

  /** Configures the lazy loader for user creek extensions. */
  setLoader(loader: () => Promise<void>): void {
    this.extensionLoader = loader;
  }

  /** Configures the per-type loader for on-demand bundle imports. */
  setTypeLoader(loader: (type: string) => Promise<void>): void {
    this.typeLoader = loader;
  }

  /**
   * Registers a lazy creek entry — a type known to exist from the bundle
   * catalog but not yet imported. Does nothing if the type is already
   * registered (either fully loaded or lazy).
   */
  registerLazy(entry: LazyCreekEntry): void {
    const key = entry.type.toLowerCase();
    if (this.creeks.has(key) || this.lazyTypes.has(key)) return;
    this.lazyTypes.set(key, entry);
  }

  /** Returns true if a type is registered as lazy (not yet imported). */
  isLazy(type: string): boolean {
    return this.lazyTypes.has(type.toLowerCase());
  }

  /** Ensures user creek extensions have been loaded. */
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
   * Clears the extension-loaded flag so the next call to {@link ensureLoaded}
   * re-runs the configured loader. Used by commands that re-scan extensions
   * at runtime (e.g. `swamp doctor extensions`).
   */
  resetLoadedFlag(): void {
    this.extensionsLoaded = false;
    this.extensionLoadPromise = null;
  }

  /**
   * Ensures a specific creek type's bundle has been imported. If the type
   * is lazy, invokes the type loader to import just that bundle. Concurrent
   * callers for the same type share the same promise.
   */
  async ensureTypeLoaded(type: string): Promise<void> {
    const key = type.toLowerCase();
    if (this.creeks.has(key)) return;
    if (!this.lazyTypes.has(key)) return;

    if (!this.typeLoader) {
      await this.ensureLoaded();
      return;
    }

    let promise = this.typeLoadPromises.get(key);
    if (!promise) {
      const loader = this.typeLoader;
      promise = loader(key).then(() => {
        this.typeLoadPromises.delete(key);
      }).catch((err) => {
        this.typeLoadPromises.delete(key);
        throw err;
      });
      this.typeLoadPromises.set(key, promise);
    }
    await promise;
  }

  /**
   * Promotes a lazy entry to a fully loaded creek. Called by the type loader
   * after importing a bundle.
   */
  promoteFromLazy(definition: CreekDefinition): void {
    const key = definition.type.toLowerCase();
    this.lazyTypes.delete(key);
    if (!this.creeks.has(key)) {
      this.register(definition);
    }
  }

  /** Registers a creek definition. Throws if the type is already registered. */
  register(definition: CreekDefinition): void {
    const key = definition.type.toLowerCase();
    if (this.creeks.has(key)) {
      throw new Error(`Creek type '${definition.type}' is already registered.`);
    }
    this.creeks.set(key, definition);
  }

  /** Gets a creek definition by type. Returns undefined for lazy types. */
  get(type: string): CreekDefinition | undefined {
    return this.creeks.get(type.toLowerCase());
  }

  /** Returns all fully loaded creek definitions. */
  getAll(): CreekDefinition[] {
    return Array.from(this.creeks.values());
  }

  /** Returns all lazy creek entries (not yet imported). */
  getAllLazy(): LazyCreekEntry[] {
    return Array.from(this.lazyTypes.values());
  }

  /** Checks if a creek type is registered (either fully loaded or lazy). */
  has(type: string): boolean {
    const key = type.toLowerCase();
    return this.creeks.has(key) || this.lazyTypes.has(key);
  }

  /** Returns all known creek type identifiers, normalized. */
  types(): string[] {
    return [
      ...this.creeks.keys(),
      ...this.lazyTypes.keys(),
    ];
  }
}

/**
 * Global creek registry instance. Uses `globalThis` so the same registry is
 * shared across module boundaries when extensions are loaded outside the
 * main bundle.
 */
const CREEK_REGISTRY_KEY = "__swampCreekRegistry";
// deno-lint-ignore no-explicit-any
export const creekRegistry: CreekRegistry = (globalThis as any)[
  CREEK_REGISTRY_KEY
] ??= new CreekRegistry();
