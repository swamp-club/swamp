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

import { assertEquals, assertRejects } from "@std/assert";
import { createVaultTestContext } from "./vault_test_context.ts";

Deno.test("createVaultTestContext: defaults to empty vault named test-vault", () => {
  const { vault, getStoredSecrets } = createVaultTestContext();
  assertEquals(vault.getName(), "test-vault");
  assertEquals(getStoredSecrets(), {});
});

Deno.test("createVaultTestContext: custom name", () => {
  const { vault } = createVaultTestContext({ name: "my-vault" });
  assertEquals(vault.getName(), "my-vault");
});

Deno.test("createVaultTestContext: pre-seeded secrets are returned by get", async () => {
  const { vault } = createVaultTestContext({
    secrets: { "api-key": "sk-123", "db-pass": "hunter2" },
  });
  assertEquals(await vault.get("api-key"), "sk-123");
  assertEquals(await vault.get("db-pass"), "hunter2");
});

Deno.test("createVaultTestContext: get throws for missing key by default", async () => {
  const { vault } = createVaultTestContext();
  await assertRejects(
    () => vault.get("nonexistent"),
    Error,
    "not found in test vault",
  );
});

Deno.test("createVaultTestContext: get returns empty string when throwOnMissing is false", async () => {
  const { vault } = createVaultTestContext({ throwOnMissing: false });
  assertEquals(await vault.get("nonexistent"), "");
});

Deno.test("createVaultTestContext: put stores secret for subsequent get", async () => {
  const { vault, getStoredSecrets } = createVaultTestContext();
  await vault.put("new-key", "new-value");
  assertEquals(await vault.get("new-key"), "new-value");
  assertEquals(getStoredSecrets()["new-key"], "new-value");
});

Deno.test("createVaultTestContext: put overwrites existing secret", async () => {
  const { vault } = createVaultTestContext({
    secrets: { "key": "old-value" },
  });
  await vault.put("key", "new-value");
  assertEquals(await vault.get("key"), "new-value");
});

Deno.test("createVaultTestContext: list returns sorted keys", async () => {
  const { vault } = createVaultTestContext({
    secrets: { "zebra": "z", "alpha": "a", "mid": "m" },
  });
  assertEquals(await vault.list(), ["alpha", "mid", "zebra"]);
});

Deno.test("createVaultTestContext: list includes keys added via put", async () => {
  const { vault } = createVaultTestContext({
    secrets: { "existing": "val" },
  });
  await vault.put("added", "val2");
  assertEquals(await vault.list(), ["added", "existing"]);
});

Deno.test("createVaultTestContext: operations are recorded", async () => {
  const { vault, getOperations } = createVaultTestContext({
    secrets: { "key": "val" },
  });

  vault.getName();
  await vault.get("key");
  await vault.put("key2", "val2");
  await vault.list();

  const ops = getOperations();
  assertEquals(ops.length, 4);
  assertEquals(ops[0].method, "getName");
  assertEquals(ops[1].method, "get");
  assertEquals(ops[1].key, "key");
  assertEquals(ops[2].method, "put");
  assertEquals(ops[2].key, "key2");
  assertEquals(ops[2].value, "val2");
  assertEquals(ops[3].method, "list");
});

Deno.test("createVaultTestContext: getOperationsByMethod filters correctly", async () => {
  const { vault, getOperationsByMethod } = createVaultTestContext({
    secrets: { "a": "1" },
  });

  await vault.get("a");
  await vault.put("b", "2");
  await vault.get("a");

  assertEquals(getOperationsByMethod("get").length, 2);
  assertEquals(getOperationsByMethod("put").length, 1);
  assertEquals(getOperationsByMethod("list").length, 0);
});

Deno.test("createVaultTestContext: getOperations returns a copy", async () => {
  const { vault, getOperations } = createVaultTestContext({
    secrets: { "a": "1" },
  });

  await vault.get("a");
  const ops1 = getOperations();
  await vault.get("a");
  const ops2 = getOperations();

  assertEquals(ops1.length, 1);
  assertEquals(ops2.length, 2);
});

Deno.test("createVaultTestContext: getStoredSecrets returns a copy", async () => {
  const { vault, getStoredSecrets } = createVaultTestContext({
    secrets: { "a": "1" },
  });

  const snap1 = getStoredSecrets();
  await vault.put("b", "2");
  const snap2 = getStoredSecrets();

  assertEquals(Object.keys(snap1).length, 1);
  assertEquals(Object.keys(snap2).length, 2);
});
