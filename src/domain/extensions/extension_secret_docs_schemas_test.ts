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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { extractContentMetadata } from "./extension_content_extractor.ts";
import {
  type ArgumentSchemas,
  argumentSchemas,
  detectSecretDocs,
} from "@swamp-club/extension-scoring/secret-docs";

// The schemas swamp's content extractor reads, fed to the shared detector.

const fenced = (...lines: string[]) =>
  ["# Setup", "", "```bash", ...lines, "```", ""].join("\n");

/** The 1-based lines flagged in a fenced block built by {@link fenced}. */
const flaggedLines = (text: string, schemas?: ArgumentSchemas) =>
  detectSecretDocs(text, "markdown", schemas).map((f) => f.line);

Deno.test("detectSecretDocs: a namespaced zod field counts as declared, and as sensitive when marked", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });
    const modelFile = join(modelsDir, "model.ts");
    await Deno.writeTextFile(
      modelFile,
      [
        'import { z } from "npm:zod@4";',
        "export const model = {",
        '  type: "test/namespaced-secrets",',
        '  version: "2026.10.23.1",',
        "  globalArguments: z.object({",
        "    pin: z.coerce.number().meta({ sensitive: true }),",
        "    tokenExpiry: z.iso.datetime(),",
        "  }),",
        "  methods: {},",
        "};",
      ].join("\n"),
    );
    const schemas = argumentSchemas(
      await extractContentMetadata([modelFile], modelsDir, []),
    );

    // As for a z.string() field: the sensitive mark decides, not the name.
    assertEquals(flaggedLines(fenced("--global-arg pin=1234"), schemas), [4]);
    assertEquals(
      flaggedLines(fenced("--global-arg tokenExpiry=2026-10-23"), schemas),
      [],
    );
    assertEquals(
      flaggedLines(fenced("--global-arg tokenExpiry=2026-10-23")),
      [4],
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
