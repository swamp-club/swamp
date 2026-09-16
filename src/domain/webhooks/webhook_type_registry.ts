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
import type { WebhookHandler } from "./webhook_handler.ts";

/**
 * Information about a registered webhook type. Built-in schemes (github,
 * stripe, ...) are not registered here — only extension types.
 */
export interface WebhookTypeInfo {
  /** The type identifier (e.g., "@swamp/telegram") */
  type: string;
  /** Human-readable name */
  name: string;
  /** Description of the webhook type */
  description: string;
  /** Zod schema for validating the endpoint's `config` */
  configSchema?: z.ZodTypeAny;
  /** Factory creating a handler for an endpoint's validated config */
  createHandler: (config: Record<string, unknown>) => WebhookHandler;
}

/**
 * Metadata for a lazily-indexed webhook type. The type is known to exist
 * (from the bundle catalog) but its bundle has not been imported yet.
 */
export interface LazyWebhookEntry {
  type: string;
  bundlePath: string;
  sourcePath: string;
  version: string;
  description?: string;
}

/**
 * Registry of available extension webhook types.
 * Map-backed singleton that allows registration and lookup by type identifier.
 *
 * Supports lazy loading of user extensions via {@link setLoader} and
 * {@link ensureLoaded}. With per-bundle lazy loading, the registry also
 * tracks "lazy entries" — types that are known to exist (from the bundle
 * catalog) but whose bundles have not been imported yet.
 */
export class WebhookTypeRegistry {
  private readonly types = new Map<string, WebhookTypeInfo>();
  private readonly lazyTypes = new Map<string, LazyWebhookEntry>();
  private extensionLoader: (() => Promise<void>) | null = null;
  private extensionLoadPromise: Promise<void> | null = null;
  private extensionsLoaded = false;
  private typeLoadPromises = new Map<string, Promise<void>>();
  private typeLoader: ((type: string) => Promise<void>) | null = null;

  /** Configures the lazy loader for user webhook extensions. */
  setLoader(loader: () => Promise<void>): void {
    this.extensionLoader = loader;
  }

  /** Configures the per-type loader for on-demand bundle imports. */
  setTypeLoader(loader: (type: string) => Promise<void>): void {
    this.typeLoader = loader;
  }

  /**
   * Registers a lazy webhook entry — a type known to exist from the bundle
   * catalog but not yet imported. Does nothing if the type is already
   * registered (either fully loaded or lazy).
   */
  registerLazy(entry: LazyWebhookEntry): void {
    const key = entry.type.toLowerCase();
    if (this.types.has(key) || this.lazyTypes.has(key)) return;
    this.lazyTypes.set(key, entry);
  }

  /** Returns true if a type is registered as lazy (not yet imported). */
  isLazy(type: string): boolean {
    return this.lazyTypes.has(type.toLowerCase());
  }

  /** Ensures user webhook extensions have been loaded. */
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
   * {@link ensureLoaded} re-runs the configured loader.
   */
  resetLoadedFlag(): void {
    this.extensionsLoaded = false;
    this.extensionLoadPromise = null;
  }

  /**
   * Surgically removes a single type from the registry so it can be
   * re-registered with updated metadata after a bundle upgrade.
   */
  invalidateType(type: string): void {
    const key = type.toLowerCase();
    this.types.delete(key);
    this.lazyTypes.delete(key);
    this.typeLoadPromises.delete(key);
  }

  /**
   * Ensures a specific webhook type's bundle has been imported.
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
  promoteFromLazy(info: WebhookTypeInfo): void {
    const key = info.type.toLowerCase();
    this.lazyTypes.delete(key);
    if (!this.types.has(key)) {
      this.register(info);
    }
  }

  /**
   * Registers a webhook type. Throws if the type is already registered.
   */
  register(info: WebhookTypeInfo): void {
    const key = info.type.toLowerCase();
    if (this.types.has(key)) {
      throw new Error(`Webhook type '${info.type}' is already registered.`);
    }
    this.types.set(key, info);
  }

  /**
   * Gets a webhook type by its identifier. Returns undefined for lazy types.
   */
  get(type: string): WebhookTypeInfo | undefined {
    return this.types.get(type.toLowerCase());
  }

  /**
   * Returns all fully loaded webhook types.
   */
  getAll(): WebhookTypeInfo[] {
    return Array.from(this.types.values());
  }

  /**
   * Returns all lazy webhook entries (not yet imported).
   */
  getAllLazy(): LazyWebhookEntry[] {
    return Array.from(this.lazyTypes.values());
  }

  /**
   * Checks if a webhook type is registered (either fully loaded or lazy).
   */
  has(type: string): boolean {
    const key = type.toLowerCase();
    return this.types.has(key) || this.lazyTypes.has(key);
  }
}

/** Global webhook type registry singleton. */
export const webhookTypeRegistry = new WebhookTypeRegistry();
