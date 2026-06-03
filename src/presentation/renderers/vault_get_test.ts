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

import { assertEquals, assertThrows } from "@std/assert";
import { consumeStream } from "../../libswamp/mod.ts";
import type { VaultGetEvent } from "../../libswamp/mod.ts";
import { UserError } from "../../domain/errors.ts";
import { createVaultGetRenderer } from "./vault_get.ts";

const testData = {
  id: "vault-1",
  name: "my-vault",
  type: "user-defined",
  config: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  storagePath: ".swamp/vaults/my-vault",
};

async function* toStream(
  events: VaultGetEvent[],
): AsyncGenerator<VaultGetEvent> {
  for (const e of events) yield e;
}

Deno.test("LogVaultGetRenderer - completed event runs without error", async () => {
  const renderer = createVaultGetRenderer("log");
  const events: VaultGetEvent[] = [
    { kind: "resolving" },
    { kind: "completed", data: testData },
  ];
  await consumeStream(toStream(events), renderer.handlers());
});

Deno.test("JsonVaultGetRenderer - completed serializes correct JSON", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createVaultGetRenderer("json");
    const events: VaultGetEvent[] = [
      { kind: "resolving" },
      { kind: "completed", data: testData },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.id, "vault-1");
    assertEquals(parsed.name, "my-vault");
    assertEquals(parsed.storagePath, ".swamp/vaults/my-vault");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("LogVaultGetRenderer - error event throws UserError", () => {
  const renderer = createVaultGetRenderer("log");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "not_found", message: "Vault not found" },
      }),
    UserError,
    "Vault not found",
  );
});

Deno.test("JsonVaultGetRenderer - error event throws UserError", () => {
  const renderer = createVaultGetRenderer("json");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "not_found", message: "Vault not found" },
      }),
    UserError,
    "Vault not found",
  );
});

Deno.test("createVaultGetRenderer - factory returns correct type per mode", () => {
  const logRenderer = createVaultGetRenderer("log");
  const jsonRenderer = createVaultGetRenderer("json");
  assertEquals(typeof logRenderer.handlers, "function");
  assertEquals(typeof jsonRenderer.handlers, "function");
});
