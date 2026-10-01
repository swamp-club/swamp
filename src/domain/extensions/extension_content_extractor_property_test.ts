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
import fc from "fast-check";
import { extractContentMetadata } from "./extension_content_extractor.ts";

const identifierArb = fc.stringMatching(/^[a-z][a-zA-Z0-9_]{0,10}$/);
const kebabArb = fc.stringMatching(/^[a-z][a-z0-9]{0,6}(-[a-z0-9]{1,6}){1,3}$/);

/** A method key and how it is written in source. */
const methodKeyArb = fc.oneof(
  identifierArb.map((name) => ({ name, source: name })),
  kebabArb.map((name) => ({ name, source: `"${name}"` })),
  kebabArb.map((name) => ({ name, source: `'${name}'` })),
);

/** Properties nested inside a method that must never be listed as methods. */
const nestedArb = fc.array(
  fc.oneof(identifierArb, kebabArb.map((k) => `"${k}"`)).map((key) =>
    `      ${key}: { description: "nested", inner: { x: 1 } },`
  ),
  { maxLength: 3 },
);

const methodsArb = fc.uniqueArray(
  fc.record({ key: methodKeyArb, nested: nestedArb }),
  { minLength: 1, maxLength: 8, selector: (m) => m.key.name },
);

Deno.test("extractContentMetadata: extracted method names are exactly the top-level keys of methods", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });
    const file = join(modelsDir, "model.ts");

    await fc.assert(
      fc.asyncProperty(methodsArb, async (methods) => {
        const source = [
          'import { z } from "npm:zod@4";',
          "export const model = {",
          '  type: "@test/property",',
          '  version: "2026.10.01.1",',
          "  methods: {",
          ...methods.flatMap((m) => [
            `    ${m.key.source}: {`,
            ...m.nested,
            `      description: "method ${m.key.name}",`,
            "      arguments: z.object({}),",
            "      execute: () => Promise.resolve({ dataHandles: [] }),",
            "    },",
          ]),
          "  },",
          "};",
        ].join("\n");
        await Deno.writeTextFile(file, source);

        const result = await extractContentMetadata([file], modelsDir, []);
        assertEquals(
          result.models[0].methods.map((m) => [m.name, m.description]),
          methods.map((m) => [m.key.name, `method ${m.key.name}`]),
        );
      }),
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
