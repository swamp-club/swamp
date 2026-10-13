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
import { readDeclaredTypeMetadata } from "./declared_type_metadata.ts";
import {
  extractDatastoreFromSource,
  extractVaultFromSource,
} from "./extension_content_extractor.ts";

const VAULT_SOURCE = `
console.log("printed at import");
Deno.exit(3);

export const vault = {
  type: "@Test/Mock-Vault",
  name: "Mock Vault",
  description:
    "File-backed mock vault for testing.",
  configSchema: z.object({ name: z.string() }),
  createProvider(name: string) {
    return { getName: () => name };
  },
};
`;

const entry = { type: "@test/mock-vault", sourcePath: "/repo/vaults/mock.ts" };
const reads = (source: string) => () => Promise.resolve(source);

Deno.test("readDeclaredTypeMetadata: reads the declared name and description from source text", async () => {
  assertEquals(
    await readDeclaredTypeMetadata(
      entry,
      extractVaultFromSource,
      reads(VAULT_SOURCE),
    ),
    {
      name: "Mock Vault",
      description: "File-backed mock vault for testing.",
    },
  );
});

Deno.test("readDeclaredTypeMetadata: reads a datastore definition", async () => {
  const source = `
export const datastore = {
  type: "@test/custom-store",
  name: "Custom Store",
  description: 'A sprocket-backed store.',
  createProvider: () => ({}),
};
`;
  assertEquals(
    await readDeclaredTypeMetadata(
      { type: "@test/custom-store", sourcePath: "/repo/ds/store.ts" },
      extractDatastoreFromSource,
      reads(source),
    ),
    { name: "Custom Store", description: "A sprocket-backed store." },
  );
});

Deno.test("readDeclaredTypeMetadata: a computed field comes back empty", async () => {
  const source = `
const label = "Computed";
export const vault = {
  type: "@test/mock-vault",
  name: label,
  description: "Plain description",
  createProvider: () => ({}),
};
`;
  assertEquals(
    await readDeclaredTypeMetadata(
      entry,
      extractVaultFromSource,
      reads(source),
    ),
    { name: "", description: "Plain description" },
  );
});

Deno.test("readDeclaredTypeMetadata: undefined when the source cannot be read", async () => {
  assertEquals(
    await readDeclaredTypeMetadata(
      entry,
      extractVaultFromSource,
      () => Promise.reject(new Deno.errors.NotFound("gone")),
    ),
    undefined,
  );
});

Deno.test("readDeclaredTypeMetadata: undefined when the source holds no recognisable definition", async () => {
  assertEquals(
    await readDeclaredTypeMetadata(
      entry,
      extractVaultFromSource,
      reads(`export const vault = wrap(definition);`),
    ),
    undefined,
  );
});

Deno.test("readDeclaredTypeMetadata: undefined when the source defines a different type", async () => {
  assertEquals(
    await readDeclaredTypeMetadata(
      { type: "@test/other", sourcePath: entry.sourcePath },
      extractVaultFromSource,
      reads(VAULT_SOURCE),
    ),
    undefined,
  );
});

Deno.test("readDeclaredTypeMetadata: undefined when the extractor throws", async () => {
  assertEquals(
    await readDeclaredTypeMetadata(
      entry,
      () => {
        throw new Error("extractor failed");
      },
      reads(VAULT_SOURCE),
    ),
    undefined,
  );
});

Deno.test("readDeclaredTypeMetadata: keeps an apostrophe inside a double-quoted name", async () => {
  const source = `
export const vault = {
  type: "@test/mock-vault",
  name: "Bob's Vault",
  description: 'Says "hello"',
  createProvider: () => ({}),
};
`;
  assertEquals(
    await readDeclaredTypeMetadata(
      entry,
      extractVaultFromSource,
      reads(source),
    ),
    { name: "Bob's Vault", description: 'Says "hello"' },
  );
});

Deno.test("readDeclaredTypeMetadata: a computed top-level name does not pick up a nested one", async () => {
  const vaultSource = `
const label = "Computed";
export const vault = {
  type: "@test/mock-vault",
  name: label,
  defaults: { name: "nested", description: "nested description" },
  createProvider: () => ({ name: "provider" }),
};
`;
  assertEquals(
    await readDeclaredTypeMetadata(
      entry,
      extractVaultFromSource,
      reads(vaultSource),
    ),
    { name: "", description: "" },
  );
  assertEquals(
    await readDeclaredTypeMetadata(
      { type: "@test/store", sourcePath: "/repo/ds/store.ts" },
      extractDatastoreFromSource,
      reads(`
export const datastore = {
  type: "@test/store",
  name: label,
  createProvider: () => ({ name: "provider", description: "nested" }),
};
`),
    ),
    { name: "", description: "" },
  );
});

function vaultWith(fields: string): string {
  return `
export const vault = {
  type: "@test/mock-vault",
${fields}
  createProvider: () => ({}),
};
`;
}

async function declared(fields: string) {
  return await readDeclaredTypeMetadata(
    entry,
    extractVaultFromSource,
    reads(vaultWith(fields)),
  );
}

Deno.test("readDeclaredTypeMetadata: joins string literals concatenated with +", async () => {
  assertEquals(
    await declared(`  name: 'Split ' + "Name",
  description: "Long description " +
    "continued " +
    \`to the end\`,`),
    {
      name: "Split Name",
      description: "Long description continued to the end",
    },
  );
});

Deno.test("readDeclaredTypeMetadata: decodes escape sequences", async () => {
  assertEquals(
    await declared(
      String.raw`  name: "Says \"hi\"",
  description: 'It\'s a tab:\t café \x41 \u{1F600} back\\slash',`,
    ),
    {
      name: 'Says "hi"',
      description: "It's a tab:\t café A \u{1F600} back\\slash",
    },
  );
});

Deno.test("readDeclaredTypeMetadata: a template with a substitution is computed", async () => {
  assertEquals(
    await declared(
      "  name: `Vault for ${region}`,\n  description: `Stores ${kind} secrets`,",
    ),
    { name: "", description: "" },
  );
});

Deno.test("readDeclaredTypeMetadata: a literal joined to an expression is computed", async () => {
  assertEquals(
    await declared(`  name: "Foo" + suffix,
  description: "Prefix ".concat(rest),`),
    { name: "", description: "" },
  );
});

Deno.test("readDeclaredTypeMetadata: a plain template literal is a constant string", async () => {
  assertEquals(
    await declared(
      "  name: `Plain Template`,\n  description: `costs $5 {flat}`,",
    ),
    { name: "Plain Template", description: "costs $5 {flat}" },
  );
});
