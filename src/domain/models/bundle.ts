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

import esbuild from "esbuild-wasm";
import { denoPlugins } from "@luca/esbuild-deno-loader";
import { dirname, fromFileUrl } from "@std/path";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["swamp", "models", "bundle"]);

/** Promise singleton for lazy esbuild WASM initialization. */
let initPromise: Promise<void> | null = null;

/**
 * Lazily initializes the esbuild WASM runtime on first call.
 * Uses the browser build of esbuild-wasm which loads WASM directly
 * (no subprocess), making it compatible with `deno compile`.
 * Subsequent calls return the same promise.
 */
function ensureInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      // Resolve the WASM binary from the npm package
      const browserJsUrl = import.meta.resolve("esbuild-wasm");
      const wasmUrl = new URL("../esbuild.wasm", browserJsUrl).href;
      const wasmBytes = await Deno.readFile(fromFileUrl(wasmUrl));
      const wasmModule = await WebAssembly.compile(wasmBytes);
      await esbuild.initialize({ wasmModule, worker: false });
    })();
  }
  return initPromise;
}

/**
 * Custom esbuild plugin that handles npm: specifiers for compiled binary compatibility.
 *
 * - `npm:zod*` → virtual module re-exporting from `globalThis.__swampZod`
 *   (preserves instanceof checks by sharing swamp's zod instance)
 * - Other `npm:*` → rewrites to `https://esm.sh/*` URLs for portable resolution
 * - `https:` namespace → resolves relative imports and fetches remote modules
 */
const swampNpmPlugin: esbuild.Plugin = {
  name: "swamp-npm",
  setup(build) {
    // Intercept npm:zod imports → virtual globalThis shim
    build.onResolve({ filter: /^npm:zod(@|$)/ }, () => ({
      path: "swamp-zod",
      namespace: "swamp-virtual",
    }));

    build.onLoad(
      { filter: /.*/, namespace: "swamp-virtual" },
      () => ({
        contents: "export const { z } = globalThis.__swampZod;",
        loader: "js" as esbuild.Loader,
      }),
    );

    // Intercept npm: imports → rewrite to esm.sh URLs in the https namespace
    build.onResolve({ filter: /^npm:/ }, (args) => {
      const spec = args.path.slice(4);
      return {
        path: `https://esm.sh/${spec}`,
        namespace: "https",
      };
    });

    // Mark node: builtins as external (Deno provides them natively).
    // This catches node: imports from within esm.sh modules.
    build.onResolve({ filter: /^node:/ }, (args) => ({
      path: args.path,
      external: true,
    }));

    // Resolve relative/absolute imports within the https namespace
    // (prevents the deno-resolver from re-resolving already-resolved URLs)
    build.onResolve({ filter: /.*/, namespace: "https" }, (args) => {
      if (
        args.path.startsWith("https://") || args.path.startsWith("http://")
      ) {
        return { path: args.path, namespace: "https" };
      }
      // Relative import within a remote module
      const resolved = new URL(args.path, args.importer).href;
      return { path: resolved, namespace: "https" };
    });

    // Fetch and load remote modules in the https namespace
    build.onLoad(
      { filter: /.*/, namespace: "https" },
      async (args) => {
        const url = args.path;
        logger.debug`Fetching remote module: ${url}`;
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(
            `Failed to fetch ${url}: ${response.status} ${response.statusText}`,
          );
        }
        const contents = await response.text();
        return { contents, loader: "js" as esbuild.Loader };
      },
    );
  },
};

/**
 * Bundles a TypeScript extension file into JavaScript using esbuild WASM.
 *
 * Uses a custom plugin chain:
 * 1. swamp-npm: Handles npm: specifiers (zod via globalThis shim, others via esm.sh),
 *    and fetches remote https modules
 * 2. deno-loader (portable): Handles local .ts files, jsr: specifiers, import maps
 *
 * @param absolutePath - Absolute filesystem path to the TypeScript file
 * @returns Bundled JavaScript source code as a string
 */
export async function bundleExtension(absolutePath: string): Promise<string> {
  logger.debug`Bundling extension: ${absolutePath}`;

  await ensureInitialized();

  const result = await esbuild.build({
    entryPoints: [absolutePath],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    absWorkingDir: dirname(absolutePath),
    plugins: [
      swampNpmPlugin,
      ...denoPlugins({ loader: "portable" }),
    ],
  });

  const outputFile = result.outputFiles?.[0];
  if (!outputFile) {
    throw new Error(`esbuild produced no output for: ${absolutePath}`);
  }
  const js = outputFile.text;

  logger.debug`Bundled ${absolutePath} (${js.length} bytes)`;

  return js;
}

/**
 * Shuts down the esbuild WASM worker thread for clean process exit.
 */
export function stopBundler(): void {
  if (initPromise) {
    esbuild.stop();
    initPromise = null;
  }
}
