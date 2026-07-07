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
import { extractVaultReferences } from "./vault_reference_extractor.ts";

Deno.test("extractVaultReferences: extracts single quoted reference", () => {
  const data = { apiKey: "${{ vault.get('default', 'api-key') }}" };
  const result = extractVaultReferences(data);
  assertEquals(result.staticRefs, [
    { vaultName: "default", secretKey: "api-key" },
  ]);
  assertEquals(result.hasDynamicRefs, false);
});

Deno.test("extractVaultReferences: extracts double quoted reference", () => {
  const data = { token: '${{ vault.get("infra", "token") }}' };
  const result = extractVaultReferences(data);
  assertEquals(result.staticRefs, [
    { vaultName: "infra", secretKey: "token" },
  ]);
  assertEquals(result.hasDynamicRefs, false);
});

Deno.test("extractVaultReferences: extracts from nested objects", () => {
  const data = {
    outer: {
      inner: {
        secret: "${{ vault.get('v1', 'k1') }}",
      },
    },
    top: "${{ vault.get('v2', 'k2') }}",
  };
  const result = extractVaultReferences(data);
  assertEquals(result.staticRefs.length, 2);
  assertEquals(result.staticRefs[0], { vaultName: "v1", secretKey: "k1" });
  assertEquals(result.staticRefs[1], { vaultName: "v2", secretKey: "k2" });
  assertEquals(result.hasDynamicRefs, false);
});

Deno.test("extractVaultReferences: extracts from arrays", () => {
  const data = [
    "${{ vault.get('default', 'secret-a') }}",
    "${{ vault.get('default', 'secret-b') }}",
  ];
  const result = extractVaultReferences(data);
  assertEquals(result.staticRefs.length, 2);
  assertEquals(result.hasDynamicRefs, false);
});

Deno.test("extractVaultReferences: detects dynamic vault name", () => {
  const data = { key: "${{ vault.get(inputs.vault, 'key') }}" };
  const result = extractVaultReferences(data);
  assertEquals(result.staticRefs, []);
  assertEquals(result.hasDynamicRefs, true);
});

Deno.test("extractVaultReferences: detects dynamic secret key", () => {
  const data = { key: "${{ vault.get('default', inputs.key) }}" };
  const result = extractVaultReferences(data);
  assertEquals(result.staticRefs, []);
  assertEquals(result.hasDynamicRefs, true);
});

Deno.test("extractVaultReferences: handles mixed static and dynamic", () => {
  const data = {
    static: "${{ vault.get('default', 'api-key') }}",
    dynamic: "${{ vault.get('default', inputs.key) }}",
  };
  const result = extractVaultReferences(data);
  assertEquals(result.staticRefs, [
    { vaultName: "default", secretKey: "api-key" },
  ]);
  assertEquals(result.hasDynamicRefs, true);
});

Deno.test("extractVaultReferences: deduplicates identical references", () => {
  const data = {
    a: "${{ vault.get('default', 'shared-key') }}",
    b: "${{ vault.get('default', 'shared-key') }}",
  };
  const result = extractVaultReferences(data);
  assertEquals(result.staticRefs.length, 1);
  assertEquals(result.staticRefs[0], {
    vaultName: "default",
    secretKey: "shared-key",
  });
});

Deno.test("extractVaultReferences: returns empty for no vault references", () => {
  const data = { plain: "hello", num: 42 };
  const result = extractVaultReferences(data);
  assertEquals(result.staticRefs, []);
  assertEquals(result.hasDynamicRefs, false);
});

Deno.test("extractVaultReferences: handles null and undefined values", () => {
  const data = { a: null, b: undefined, c: "plain" };
  const result = extractVaultReferences(data);
  assertEquals(result.staticRefs, []);
  assertEquals(result.hasDynamicRefs, false);
});

Deno.test("extractVaultReferences: handles empty object", () => {
  const result = extractVaultReferences({});
  assertEquals(result.staticRefs, []);
  assertEquals(result.hasDynamicRefs, false);
});

Deno.test("extractVaultReferences: handles multiple data sources", () => {
  const globals = { apiKey: "${{ vault.get('default', 'api-key') }}" };
  const methodArgs = { token: "${{ vault.get('infra', 'token') }}" };
  const result = extractVaultReferences(globals, methodArgs);
  assertEquals(result.staticRefs.length, 2);
  assertEquals(result.staticRefs[0], {
    vaultName: "default",
    secretKey: "api-key",
  });
  assertEquals(result.staticRefs[1], {
    vaultName: "infra",
    secretKey: "token",
  });
});

Deno.test("extractVaultReferences: handles secret keys with spaces", () => {
  const data = { key: "${{ vault.get('infra', 'Client ID') }}" };
  const result = extractVaultReferences(data);
  assertEquals(result.staticRefs, [
    { vaultName: "infra", secretKey: "Client ID" },
  ]);
});
