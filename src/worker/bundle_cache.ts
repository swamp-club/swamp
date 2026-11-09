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

import { dirname, join, toFileUrl } from "@std/path";
import { modelRegistry } from "../domain/models/model.ts";
import { wordedError, wordedText } from "../domain/behavior_wording.ts";
import type { ModelDefinition } from "../domain/models/model.ts";
import type { DataPlaneClient } from "./data_plane_client.ts";
import type { WithheldAsset } from "../domain/remote/protocol.ts";
import { primaryExport } from "../domain/extensions/kind_adapter.ts";
import {
  BEHAVIOR_EXPORT_NAME,
  MODEL_EXPORT_NAME,
} from "../domain/terminology/behavior_aliases.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["worker", "bundle-cache"]);

export const BUILTIN_BUNDLE_PREFIX = "builtin:";

export interface LoadedBundle {
  modelDef: ModelDefinition;
  filesDir?: string;
  withheldAssets?: readonly WithheldAsset[];
}

export class WorkerBundleCache {
  readonly #cacheDir: string;
  readonly #client: DataPlaneClient;
  readonly #loaded = new Map<string, Promise<LoadedBundle>>();

  constructor(cacheDir: string, client: DataPlaneClient) {
    this.#cacheDir = cacheDir;
    this.#client = client;
  }

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
        throw wordedError(
          wordedText((w) =>
            `Built-in ${w.noun} '${type}' is not registered in this worker — ` +
            "orchestrator and worker binaries disagree"
          ),
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
      await writeAtomically(bundlePath, new TextEncoder().encode(js), false);
    }

    const { filesDir, withheld } = await this.#prefetchAssets(
      fingerprint,
      bundleDir,
      signal,
    );

    const module = await import(toFileUrl(bundlePath).href) as Record<
      string,
      unknown
    >;
    // `behavior` is the other spelling of `model`; a bundle exporting both as
    // definitions is refused rather than one winning
    const modelDef = (primaryExport(module, {
      primaryExportKey: MODEL_EXPORT_NAME,
      primaryExportAliases: [BEHAVIOR_EXPORT_NAME],
    }) ?? module.default) as ModelDefinition | undefined;
    if (!modelDef || typeof modelDef !== "object" || !("methods" in modelDef)) {
      throw wordedError(
        wordedText((w) =>
          `Bundle '${fingerprint}' does not export a ${w.noun} definition`
        ),
      );
    }
    return {
      modelDef: filesDir === undefined
        ? modelDef
        : { ...modelDef, extensionFilesRoot: filesDir },
      filesDir,
      withheldAssets: withheld,
    };
  }

  async #prefetchAssets(
    fingerprint: string,
    bundleDir: string,
    signal?: AbortSignal,
  ): Promise<{ filesDir?: string; withheld: WithheldAsset[] }> {
    const { files, executables, withheld } = await this.#client.listAssets(
      fingerprint,
      signal,
    );
    if (files.length === 0) {
      return { withheld };
    }
    const filesDir = join(bundleDir, "files");
    const executable = new Set(executables);
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
      await writeAtomically(target, bytes, executable.has(relPath));
    }
    return { filesDir, withheld };
  }
}

/**
 * dispatches on one worker share the cache dir but not this class, so a file
 * appears only complete and with its final mode: a reader never sees a partial
 * write, and a binary is never executed while still open for writing
 */
async function writeAtomically(
  target: string,
  bytes: Uint8Array,
  executable: boolean,
): Promise<void> {
  const temp = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.writeFile(temp, bytes);
    if (executable && Deno.build.os !== "windows") {
      await Deno.chmod(temp, 0o755);
    }
    try {
      await Deno.rename(temp, target);
    } catch (error) {
      // Windows refuses to replace a file another dispatch holds open; that
      // dispatch already wrote the same fingerprinted bytes
      if (!await exists(target)) throw error;
    }
  } finally {
    await Deno.remove(temp).catch(() => {});
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
