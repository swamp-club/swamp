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

/**
 * Worker-side bundle cache (see design/remote-execution.md, "Shipping
 * extension code").
 *
 * A dispatch references its model by bundle fingerprint. `builtin:<type>`
 * sentinels resolve from the worker's own registry — built-ins ship inside
 * the swamp binary, and enrollment already guaranteed version lockstep.
 * Anything else is fetched once from the data plane, written under the
 * cache directory, imported in-process, and memoized; co-located assets are
 * prefetched beside it so the synchronous `extensionFile()` context member
 * can resolve local paths.
 */

import { dirname, join, toFileUrl } from "@std/path";
import { modelRegistry } from "../domain/models/model.ts";
import type { ModelDefinition } from "../domain/models/model.ts";
import type { DataPlaneClient } from "./data_plane_client.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["worker", "bundle-cache"]);

/** Sentinel prefix for models compiled into the swamp binary. */
export const BUILTIN_BUNDLE_PREFIX = "builtin:";

export interface LoadedBundle {
  modelDef: ModelDefinition;
  /** Local directory the bundle's co-located assets were prefetched to. */
  filesDir?: string;
}

export class WorkerBundleCache {
  readonly #cacheDir: string;
  readonly #client: DataPlaneClient;
  readonly #loaded = new Map<string, Promise<LoadedBundle>>();

  constructor(cacheDir: string, client: DataPlaneClient) {
    this.#cacheDir = cacheDir;
    this.#client = client;
  }

  /** Resolve a dispatch's model, fetching and importing on cache miss. */
  load(fingerprint: string, signal?: AbortSignal): Promise<LoadedBundle> {
    const cached = this.#loaded.get(fingerprint);
    if (cached !== undefined) {
      return cached;
    }
    const loading = this.#loadUncached(fingerprint, signal);
    this.#loaded.set(fingerprint, loading);
    loading.catch(() => this.#loaded.delete(fingerprint));
    return loading;
  }

  async #loadUncached(
    fingerprint: string,
    signal?: AbortSignal,
  ): Promise<LoadedBundle> {
    if (fingerprint.startsWith(BUILTIN_BUNDLE_PREFIX)) {
      const type = fingerprint.slice(BUILTIN_BUNDLE_PREFIX.length);
      const modelDef = modelRegistry.get(type);
      if (!modelDef) {
        throw new Error(
          `Built-in model '${type}' is not registered in this worker — ` +
            "orchestrator and worker binaries disagree",
        );
      }
      return { modelDef };
    }

    const bundleDir = join(this.#cacheDir, fingerprint);
    const bundlePath = join(bundleDir, "bundle.js");
    let js: string | null = null;
    try {
      js = await Deno.readTextFile(bundlePath);
      logger.debug("Bundle {fingerprint} served from disk cache", {
        fingerprint,
      });
    } catch {
      js = null;
    }
    if (js === null) {
      js = await this.#client.fetchBundle(fingerprint, signal);
      await Deno.mkdir(bundleDir, { recursive: true });
      await Deno.writeTextFile(bundlePath, js);
    }

    const filesDir = await this.#prefetchAssets(fingerprint, bundleDir, signal);

    const module = await import(toFileUrl(bundlePath).href) as {
      model?: ModelDefinition;
      default?: ModelDefinition;
    };
    const modelDef = module.model ?? module.default;
    if (!modelDef || typeof modelDef !== "object" || !("methods" in modelDef)) {
      throw new Error(
        `Bundle '${fingerprint}' does not export a model definition`,
      );
    }
    return {
      modelDef: filesDir === undefined
        ? modelDef
        : { ...modelDef, extensionFilesRoot: filesDir },
      filesDir,
    };
  }

  async #prefetchAssets(
    fingerprint: string,
    bundleDir: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const files = await this.#client.listAssets(fingerprint, signal);
    if (files.length === 0) {
      return undefined;
    }
    const filesDir = join(bundleDir, "files");
    for (const relPath of files) {
      const target = join(filesDir, ...relPath.split("/"));
      try {
        await Deno.stat(target);
        continue; // Cached by fingerprint: immutable once fetched.
      } catch {
        // Fall through to fetch.
      }
      const bytes = await this.#client.fetchAsset(fingerprint, relPath, signal);
      await Deno.mkdir(dirname(target), { recursive: true });
      await Deno.writeFile(target, bytes);
    }
    return filesDir;
  }
}
