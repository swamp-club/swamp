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
import type { ExecutionDriver } from "./execution_driver.ts";

/**
 * Information about a registered execution driver type.
 */
export interface DriverTypeInfo {
  /** The type identifier (e.g., "raw", "docker", or "@myorg/custom-driver") */
  type: string;
  /** Human-readable name */
  name: string;
  /** Description of the driver type */
  description: string;
  /** Zod schema for validating driver config (user-defined types only) */
  configSchema?: z.ZodTypeAny;
  /** Factory function to create a driver instance (user-defined types only) */
  createDriver?: (config: Record<string, unknown>) => ExecutionDriver;
  /** Whether this is a built-in driver type */
  isBuiltIn: boolean;
}

/**
 * Metadata for a lazily-indexed driver type. The type is known to exist
 * (from the bundle catalog) but its bundle has not been imported yet.
 */
export interface LazyDriverEntry {
  type: string;
  bundlePath: string;
  sourcePath: string;
  version: string;
}

/**
 * Registry of available execution driver types (built-in and user-defined).
 * Map-backed singleton that allows registration and lookup by type identifier.
 *
 * Supports lazy loading of user extensions via {@link setLoader} and
 * {@link ensureLoaded}. With per-bundle lazy loading, the registry also
 * tracks "lazy entries" — types that are known to exist (from the bundle
 * catalog) but whose bundles have not been imported yet.
 */
export class DriverTypeRegistry {
  private readonly types = new Map<string, DriverTypeInfo>();
  private readonly lazyTypes = new Map<string, LazyDriverEntry>();
  private extensionLoader: (() => Promise<void>) | null = null;
  private extensionLoadPromise: Promise<void> | null = null;
  private extensionsLoaded = false;
  private typeLoadPromises = new Map<string, Promise<void>>();
  private typeLoader: ((type: string) => Promise<void>) | null = null;

  /** Configures the lazy loader for user driver extensions. */
  setLoader(loader: () => Promise<void>): void {
    this.extensionLoader = loader;
  }

  /** Configures the per-type loader for on-demand bundle imports. */
  setTypeLoader(loader: (type: string) => Promise<void>): void {
    this.typeLoader = loader;
  }

  /**
   * Registers a lazy driver entry — a type known to exist from the bundle
   * catalog but not yet imported. Does nothing if the type is already
   * registered (either fully loaded or lazy).
   */
  registerLazy(entry: LazyDriverEntry): void {
    const key = entry.type.toLowerCase();
    if (this.types.has(key) || this.lazyTypes.has(key)) return;
    this.lazyTypes.set(key, entry);
  }

  /** Returns true if a type is registered as lazy (not yet imported). */
  isLazy(type: string): boolean {
    return this.lazyTypes.has(type.toLowerCase());
  }

  /** Ensures user driver extensions have been loaded. */
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
   * Clears the extension-loaded flag so the next call to
   * {@link ensureLoaded} re-runs the configured loader. Used by commands
   * that re-scan extensions at runtime (e.g. `swamp open`).
   */
  resetLoadedFlag(): void {
    this.extensionsLoaded = false;
    this.extensionLoadPromise = null;
  }

  /**
   * Ensures a specific driver type's bundle has been imported.
   * If the type is lazy, invokes the type loader to import just that bundle.
   * Concurrent callers for the same type share the same promise.
   */
  async ensureTypeLoaded(type: string): Promise<void> {
    const key = type.toLowerCase();

    if (this.types.has(key)) return;
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
   * Promotes a lazy entry to a fully loaded type.
   * Called by the type loader after importing a bundle.
   */
  promoteFromLazy(info: DriverTypeInfo): void {
    const key = info.type.toLowerCase();
    this.lazyTypes.delete(key);
    if (!this.types.has(key)) {
      this.register(info);
    }
  }

  /**
   * Registers a driver type. Throws if the type is already registered.
   */
  register(info: DriverTypeInfo): void {
    const key = info.type.toLowerCase();
    if (this.types.has(key)) {
      throw new Error(`Driver type '${info.type}' is already registered.`);
    }
    this.types.set(key, info);
  }

  /**
   * Gets a driver type by its identifier. Returns undefined for lazy types.
   */
  get(type: string): DriverTypeInfo | undefined {
    return this.types.get(type.toLowerCase());
  }

  /**
   * Returns all fully loaded driver types.
   */
  getAll(): DriverTypeInfo[] {
    return Array.from(this.types.values());
  }

  /**
   * Returns all lazy driver entries (not yet imported).
   */
  getAllLazy(): LazyDriverEntry[] {
    return Array.from(this.lazyTypes.values());
  }

  /**
   * Checks if a driver type is registered (either fully loaded or lazy).
   */
  has(type: string): boolean {
    const key = type.toLowerCase();
    return this.types.has(key) || this.lazyTypes.has(key);
  }
}

/** Global driver type registry singleton. */
export const driverTypeRegistry = new DriverTypeRegistry();
