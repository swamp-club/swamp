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

import { toFileUrl } from "@std/path";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["swamp", "models", "bundle"]);

/**
 * Bundles a TypeScript extension file into JavaScript using Deno.bundle().
 *
 * Transpiles TypeScript syntax (interfaces, type annotations, generics) and
 * resolves npm imports, while externalizing zod so extensions share the same
 * instance as swamp (preserving instanceof checks).
 *
 * @param absolutePath - Absolute filesystem path to the TypeScript file
 * @returns Bundled JavaScript source code as a string
 */
export async function bundleExtension(absolutePath: string): Promise<string> {
  logger.debug`Bundling extension: ${absolutePath}`;

  const result = await Deno.bundle({
    entrypoints: [toFileUrl(absolutePath).href],
    platform: "deno",
    write: false,
    external: ["npm:zod@4", "npm:zod"],
  });

  const outputFile = result.outputFiles?.[0];
  if (!outputFile) {
    throw new Error(`Deno.bundle() produced no output for: ${absolutePath}`);
  }
  const js = outputFile.text();

  logger.debug`Bundled ${absolutePath} (${js.length} bytes)`;

  return js;
}
