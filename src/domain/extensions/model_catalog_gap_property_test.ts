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

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import fc from "fast-check";
import { extractContentMetadata } from "./extension_content_extractor.ts";
import { modelCatalogGap } from "./model_catalog_gap.ts";

/** How a model's `type` is written, if at all. */
const typeArb = fc.constantFrom(
  { decl: "", field: '  type: "@acme/thing",' },
  { decl: 'const T = ModelType.create("@acme/thing");', field: "  type: T," },
  { decl: "", field: "  type: TYPE," },
  { decl: "", field: "" },
);

/** How a model's `version` is written, if at all. */
const versionArb = fc.constantFrom(
  '  version: "2026.09.25.1",',
  "  version: VERSION,",
  "",
);

/** How the export opens. */
const headArb = fc.constantFrom(
  "export const model = {",
  "export const model: ModelDefinition = {",
  "export const model = make({",
);

/** Text before the export that mentions the fields without declaring them. */
const noiseArb = fc.constantFrom(
  "",
  '// type: "@acme/other", version: "2026.01.01.1"',
  'const note = "version: 1";',
  "const fixture = `export const model = { ...x }`;",
);

Deno.test("modelCatalogGap: no gap exactly when the push metadata lists the file as a model", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const file = join(tmpDir, "model.ts");
    await fc.assert(
      fc.asyncProperty(
        typeArb,
        versionArb,
        headArb,
        noiseArb,
        fc.boolean(),
        async (type, version, head, noise, spread) => {
          const close = head.endsWith("({") ? "});" : "};";
          const source = [
            type.decl,
            noise,
            head,
            spread ? "  ...definition," : "",
            type.field,
            version,
            close,
            "",
          ].join("\n");
          await Deno.writeTextFile(file, source);

          const listed =
            (await extractContentMetadata([file], tmpDir, [])).models.length ===
              1;
          const gap = modelCatalogGap(source);
          assertEquals(gap === null, listed, source);
          if (gap?.kind === "missing-literals") {
            assert(gap.missing.length > 0, source);
          }
        },
      ),
    );
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});
