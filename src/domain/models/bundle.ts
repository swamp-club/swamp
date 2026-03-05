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

/**
 * Bundles a TypeScript extension file into JavaScript using `deno bundle` subprocess.
 *
 * Transpiles TypeScript syntax (interfaces, type annotations, generics) and
 * externalizes all npm packages so they resolve at runtime via Deno's native
 * npm resolver (preserving correct CJS/ESM interop and zod instanceof checks).
 *
 * @param absolutePath - Absolute filesystem path to the TypeScript file
 * @param denoPath - Absolute path to the deno binary to use for bundling
 * @returns Bundled JavaScript source code as a string
 */
export async function bundleExtension(
  absolutePath: string,
  denoPath: string,
): Promise<string> {
  logger.debug`Bundling extension: ${absolutePath}`;

  const tempFile = await Deno.makeTempFile({
    prefix: "swamp_bundle_",
    suffix: ".js",
  });

  try {
    const command = new Deno.Command(denoPath, {
      args: [
        "bundle",
        "--no-lock",
        "--external",
        "npm:*",
        "--platform",
        "deno",
        "-o",
        tempFile,
        absolutePath,
      ],
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
