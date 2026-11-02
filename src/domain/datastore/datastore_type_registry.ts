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
import type { DatastoreProvider } from "./datastore_provider.ts";

export interface DatastoreTypeInfo {
  type: string;
  name: string;
  description: string;
  configSchema?: z.ZodTypeAny;
  createProvider?: (config: Record<string, unknown>) => DatastoreProvider;
  isBuiltIn: boolean;
  sourcePath?: string;
}

export interface LazyDatastoreEntry {
  type: string;
  bundlePath: string;
  sourcePath: string;
  version: string;
}

export class DatastoreTypeRegistry {
  private readonly types = new Map<string, DatastoreTypeInfo>();
  private readonly lazyTypes = new Map<string, LazyDatastoreEntry>();
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

  registerLazy(entry: LazyDatastoreEntry): void {
    const key = entry.type.toLowerCase();
    if (this.types.has(key) || this.lazyTypes.has(key)) return;
    this.lazyTypes.set(key, entry);
  }

  isLazy(type: string): boolean {
    return this.lazyTypes.has(type.toLowerCase());
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

  clearLoadersForTesting(): void {
    this.extensionLoader = null;
    this.typeLoader = null;
    this.extensionsLoaded = false;
    this.extensionLoadPromise = null;
  }

  invalidateType(type: string): void {
    const key = type.toLowerCase();
    this.types.delete(key);
    this.lazyTypes.delete(key);
    this.typeLoadPromises.delete(key);
  }

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
        // a loader that skipped a stale or broken bundle never promoted the
        // type; drop the lazy entry so later lookups report it unknown instead
        // of retrying
        if (!this.types.has(key)) {
          this.lazyTypes.delete(key);
        }
        this.typeLoadPromises.delete(key);
      }).catch((err) => {
        this.typeLoadPromises.delete(key);
        throw err;
      });
      this.typeLoadPromises.set(key, promise);
    }
    await promise;
  }

  promoteFromLazy(info: DatastoreTypeInfo): void {
    const key = info.type.toLowerCase();
    this.lazyTypes.delete(key);
    if (!this.types.has(key)) {
      this.register(info);
    }
  }

  register(info: DatastoreTypeInfo): void {
    const key = info.type.toLowerCase();
    if (this.types.has(key)) {
      throw new Error(`Datastore type '${info.type}' is already registered.`);
    }
    this.types.set(key, info);
  }

  get(type: string): DatastoreTypeInfo | undefined {
    return this.types.get(type.toLowerCase());
  }

  getAll(): DatastoreTypeInfo[] {
    return Array.from(this.types.values());
  }

  getAllLazy(): LazyDatastoreEntry[] {
    return Array.from(this.lazyTypes.values());
  }

  has(type: string): boolean {
    const key = type.toLowerCase();
    return this.types.has(key) || this.lazyTypes.has(key);
  }
}

export const datastoreTypeRegistry = new DatastoreTypeRegistry();
