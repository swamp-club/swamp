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

import { getLogger } from "@logtape/logtape";

const logger = getLogger(["swamp", "models", "bundle"]);

/** Options for controlling bundle output. */
export interface BundleOptions {
  /**
   * When true, inline all dependencies (including zod) so the bundle is
   * fully self-contained — no network or shared module graph required.
   * Used for out-of-process execution (e.g., Docker containers).
   */
  selfContained?: boolean;
}

/**
 * Bundles a TypeScript extension file into JavaScript using `deno bundle` subprocess.
 *
 * Transpiles TypeScript syntax (interfaces, type annotations, generics) and
 * inlines all npm packages into the bundle. Only `zod` is externalized so that
 * extensions share the same zod instance as swamp (required for schema
 * `instanceof` checks). All other npm packages are resolved and inlined at
 * bundle time, which ensures they work in the compiled binary where only
 * swamp's own embedded dependency graph is available.
 *
 * When `options.selfContained` is true, zod is also inlined, producing a
 * bundle that needs no external modules at all. This is used for Docker
 * execution where the container has no access to swamp's module graph.
 *
 * @param absolutePath - Absolute filesystem path to the TypeScript file
 * @param denoPath - Absolute path to the deno binary to use for bundling
 * @param options - Optional bundle configuration
 * @returns Bundled JavaScript source code as a string
 */
export async function bundleExtension(
  absolutePath: string,
  denoPath: string,
  options?: BundleOptions,
): Promise<string> {
  logger.debug`Bundling extension: ${absolutePath}`;

  const tempFile = await Deno.makeTempFile({
    prefix: "swamp_bundle_",
    suffix: ".js",
  });

  try {
    const args = ["bundle", "--no-lock"];

    // Externalize zod by default so in-process extensions share the
    // host's zod instance (required for `instanceof` schema checks).
    // Self-contained bundles inline everything for out-of-process use.
    if (!options?.selfContained) {
      args.push("--external", "npm:zod@4", "--external", "npm:zod");
    }

    args.push("--platform", "deno", "-o", tempFile, absolutePath);

    const command = new Deno.Command(denoPath, {
      args,
      stdout: "piped",
      stderr: "piped",
    });

    const output = await command.output();

    if (!output.success) {
      const stderr = new TextDecoder().decode(output.stderr);
      throw new Error(
        `deno bundle failed for ${absolutePath}: ${stderr}`,
      );
    }

    const js = await Deno.readTextFile(tempFile);

    if (!js) {
      throw new Error(
        `deno bundle produced empty output for: ${absolutePath}`,
      );
    }

    logger.debug`Bundled ${absolutePath} (${js.length} bytes)`;
    return js;
  } finally {
    try {
      await Deno.remove(tempFile);
    } catch {
      // Temp file cleanup is best-effort
    }
  }
}
