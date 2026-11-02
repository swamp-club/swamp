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
 * a directory listed where the manifest takes files fails resolution with a
 * validation error naming the entry; quality, push and fmt resolve first, so
 * all give this answer before any hashing
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { stringify as stringifyYaml } from "@std/yaml";
import { getLogger } from "@logtape/logtape";
import { resolveExtensionFiles } from "../src/cli/resolve_extension_files.ts";
import { requireInitializedRepoReadOnly } from "../src/cli/repo_context.ts";
import { UserError } from "../src/domain/errors.ts";
import { collect } from "../src/libswamp/testing.ts";
import { createLibSwampContext } from "../src/libswamp/context.ts";
import { createRepoInitDeps, repoInit } from "../src/libswamp/repo/init.ts";
import { DenoInfoModuleGraphReader } from "../src/infrastructure/runtime/deno_info_module_graph_reader.ts";

const graphReader = new DenoInfoModuleGraphReader(Deno.execPath());

const logger = getLogger(["test"]);

async function withExtensionRepo(
  fn: (repoDir: string) => Promise<void>,
): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp-af-dir-" });
  try {
    const version = "20260101.120000.0";
    const events = await collect(
      repoInit(createLibSwampContext(), createRepoInitDeps(version), {
        path: repoDir,
        force: false,
        version,
        tools: [],
      }),
    );
    assertEquals(events.some((event) => event.kind === "error"), false);
    const modelsDir = join(repoDir, "extensions", "models");
    await Deno.mkdir(join(modelsDir, "helpers"), { recursive: true });
    await Deno.writeTextFile(
      join(modelsDir, "echo.ts"),
      'export const model = { type: "@test/echo" };\n',
    );
    await Deno.writeTextFile(
      join(modelsDir, "helpers", "a.ts"),
      "export const a = 1;\n",
    );
    await Deno.mkdir(join(repoDir, "docs"));
    await Deno.writeTextFile(join(repoDir, "docs", "notes.md"), "# notes\n");
    await fn(repoDir);
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
}

const cases = [
  {
    field: "additionalFiles",
    entry: "docs",
    expected: "Additional file is a directory: docs",
  },
  {
    field: "include",
    entry: "helpers",
    expected: "Include file is a directory: helpers",
  },
];

for (const { field, entry, expected } of cases) {
  Deno.test(`extension quality, push and fmt: a directory in ${field} is a validation error naming it (swamp-club#3119)`, async () => {
    await withExtensionRepo(async (repoDir) => {
      const manifestPath = join(repoDir, "manifest.yaml");
      await Deno.writeTextFile(
        manifestPath,
        stringifyYaml({
          manifestVersion: 1,
          name: "@test/dirfiles",
          version: "2026.10.07.1",
          models: ["echo.ts"],
          [field]: [entry],
        }),
      );

      const { repoContext } = await requireInitializedRepoReadOnly({
        repoDir,
        outputMode: "log",
      });
      const error = await assertRejects(
        () =>
          resolveExtensionFiles({
            repoDir,
            manifestPath,
            repoContext,
            logger,
            extensionsDir: undefined,
            moduleGraphReader: graphReader,
          }),
        UserError,
      );
      assertStringIncludes(error.message, expected);
      assertStringIncludes(error.message, `list each file under ${entry}/`);
    });
  });
}
