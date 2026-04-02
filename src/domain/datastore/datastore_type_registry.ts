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
import type { DatastoreProvider } from "./datastore_provider.ts";

/**
 * Information about a registered datastore type.
 */
export interface DatastoreTypeInfo {
  /** The type identifier (e.g., "filesystem", "s3", or "@myorg/custom-store") */
  type: string;
  /** Human-readable name */
  name: string;
  /** Description of the datastore type */
  description: string;
  /** Zod schema for validating datastore config (user-defined types only) */
  configSchema?: z.ZodTypeAny;
  /** Factory function to create a datastore provider (user-defined types only) */
  createProvider?: (config: Record<string, unknown>) => DatastoreProvider;
  /** Whether this is a built-in datastore type */
  isBuiltIn: boolean;
}

/**
 * Registry of available datastore types (built-in and user-defined).
 * Map-backed singleton that allows registration and lookup by type identifier.
 *
 * Supports lazy loading of user extensions via {@link setLoader} and
 * {@link ensureLoaded}.
 */
export class DatastoreTypeRegistry {
  private readonly types = new Map<string, DatastoreTypeInfo>();
  private extensionLoader: (() => Promise<void>) | null = null;
  private extensionLoadPromise: Promise<void> | null = null;
  private extensionsLoaded = false;

  /** Configures the lazy loader for user datastore extensions. */
  setLoader(loader: () => Promise<void>): void {
    this.extensionLoader = loader;
  }

  /** Ensures user datastore extensions have been loaded. */
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
   * Registers a datastore type. Throws if the type is already registered.
   */
  register(info: DatastoreTypeInfo): void {
    const key = info.type.toLowerCase();
    if (this.types.has(key)) {
      throw new Error(`Datastore type '${info.type}' is already registered.`);
    }
    this.types.set(key, info);
  }

  /**
   * Gets a datastore type by its identifier.
   */
  get(type: string): DatastoreTypeInfo | undefined {
    return this.types.get(type.toLowerCase());
  }

  /**
   * Returns all registered datastore types.
   */
  getAll(): DatastoreTypeInfo[] {
    return Array.from(this.types.values());
  }

  /**
   * Checks if a datastore type is registered.
   */
  has(type: string): boolean {
    return this.types.has(type.toLowerCase());
  }
}

/** Global datastore type registry singleton. */
export const datastoreTypeRegistry = new DatastoreTypeRegistry();
