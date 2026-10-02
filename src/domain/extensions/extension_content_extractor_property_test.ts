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

/** Characters that confuse a scanner that counts braces in literals. */
const noiseArb = fc.string({
  unit: fc.constantFrom(
    ..."{}[]()\"'`/\\$*,;: ab".split(""),
  ),
  maxLength: 12,
});

const escapeFor = (quote: string) => (s: string) =>
  s.replace(/\\/g, "\\\\").replaceAll(quote, `\\${quote}`);

/**
 * Well-formed literals holding noise, each placed where the scanner can
 * classify it: strings with escaped quotes, templates with escaped dollars,
 * comments, and regex literals in regex position with every symbol escaped.
 */
const literalStatementArb = fc.oneof(
  noiseArb.map((s) => `log("${escapeFor('"')(s)}");`),
  noiseArb.map((s) => `log('${escapeFor("'")(s)}');`),
  noiseArb.map((s) => `log(\`${escapeFor("`")(s).replaceAll("$", "\\$")}\`);`),
  noiseArb.map((s) => `// ${s}`),
  noiseArb.map((s) => `/* ${s.replaceAll("*/", "")} */`),
  noiseArb.map((s) =>
    `const re = /x${s.replace(/[^\w ]/g, (c) => `\\${c}`)}/g;`
  ),
);

const methodsWithNoiseArb = fc.uniqueArray(
  fc.record({
    key: methodKeyArb,
    body: fc.array(literalStatementArb, { maxLength: 4 }),
  }),
  { minLength: 1, maxLength: 6, selector: (m) => m.key.name },
);

Deno.test("extractContentMetadata: literals in execute bodies never change the extracted methods", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });
    const file = join(modelsDir, "model.ts");

    await fc.assert(
      fc.asyncProperty(methodsWithNoiseArb, async (methods) => {
        const source = [
          'import { z } from "npm:zod@4";',
          "export const model = {",
          '  type: "@test/property",',
          '  version: "2026.10.02.1",',
          "  methods: {",
          ...methods.flatMap((m) => [
            `    ${m.key.source}: {`,
            `      description: "method ${m.key.name}",`,
            "      arguments: z.object({}),",
            "      execute: () => {",
            ...m.body.map((line) => `        ${line}`),
            "        return Promise.resolve({ dataHandles: [] });",
            "      },",
            "    },",
          ]),
          "  },",
          "};",
        ].join("\n");
        await Deno.writeTextFile(file, source);

        const result = await extractContentMetadata([file], modelsDir, []);
        assertEquals(
          result.models[0]?.methods.map((m) => [m.name, m.description]),
          methods.map((m) => [m.key.name, `method ${m.key.name}`]),
        );
      }),
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

/**
 * Describe text with braces, brackets, quotes and slashes. Parens and colons
 * are left out: field boundaries are found by a paren count and a key pattern
 * that this property does not cover.
 */
const describeNoiseArb = fc.string({
  unit: fc.constantFrom(..."{}[]\"'`/\\$ ab".split("")),
  maxLength: 12,
});

const globalArgsArb = fc.uniqueArray(
  fc.record({
    name: identifierArb,
    describe: describeNoiseArb,
    quote: fc.constantFrom('"', "'"),
    optional: fc.boolean(),
  }),
  { minLength: 1, maxLength: 6, selector: (a) => a.name },
);

Deno.test("extractContentMetadata: braces in describe text never change the extracted global arguments", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const modelsDir = join(tmpDir, "models");
    await Deno.mkdir(modelsDir, { recursive: true });
    const file = join(modelsDir, "model.ts");

    await fc.assert(
      fc.asyncProperty(globalArgsArb, async (args) => {
        const source = [
          'import { z } from "npm:zod@4";',
          "export const model = {",
          '  type: "@test/property",',
          '  version: "2026.10.02.1",',
          "  globalArguments: z.object({",
          ...args.map((a) => {
            const text = `${a.quote}${
              escapeFor(a.quote)(a.describe)
            }${a.quote}`;
            return `    ${a.name}: z.string()${
              a.optional ? ".optional()" : ""
            }.describe(${text}),`;
          }),
          "  }),",
          "  methods: {},",
          "};",
        ].join("\n");
        await Deno.writeTextFile(file, source);

        const result = await extractContentMetadata([file], modelsDir, []);
        assertEquals(
          result.models[0]?.globalArguments.map((a) => [a.name, a.required]),
          args.map((a) => [a.name, !a.optional]),
        );
      }),
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
