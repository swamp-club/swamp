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
