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
import {
  consumeStream,
  type VaultReadSecretEvent,
} from "../../libswamp/mod.ts";
import { createVaultReadSecretRenderer } from "./vault_read_secret.ts";
import { UserError } from "../../domain/errors.ts";

function makeData() {
  return {
    vaultName: "test-vault",
    secretKey: "my-key",
    vaultType: "local_encryption",
    value: "super_secret_value",
  };
}

async function* toStream(
  events: VaultReadSecretEvent[],
): AsyncGenerator<VaultReadSecretEvent> {
  for (const event of events) {
    yield event;
  }
}

Deno.test("LogVaultReadSecretRenderer: writes only the secret value to stdout", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createVaultReadSecretRenderer("log");
    const events: VaultReadSecretEvent[] = [
      { kind: "resolving" },
      { kind: "completed", data: makeData() },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    assertEquals(logs.length, 1);
    assertEquals(logs[0], "super_secret_value");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("LogVaultReadSecretRenderer: error event throws UserError", () => {
  const renderer = createVaultReadSecretRenderer("log");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "vault_not_found", message: "Vault not found" },
      }),
    UserError,
    "Vault not found",
  );
});

Deno.test("JsonVaultReadSecretRenderer: completed serializes correct JSON", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createVaultReadSecretRenderer("json");
    const events: VaultReadSecretEvent[] = [
      { kind: "resolving" },
      { kind: "completed", data: makeData() },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    assertEquals(logs.length, 1);
    const parsed = JSON.parse(logs[0]);
    assertEquals(parsed.vaultName, "test-vault");
    assertEquals(parsed.secretKey, "my-key");
    assertEquals(parsed.value, "super_secret_value");
  } finally {
    console.log = originalLog;
  }
});

Deno.test("JsonVaultReadSecretRenderer: error event throws UserError", () => {
  const renderer = createVaultReadSecretRenderer("json");
  const handlers = renderer.handlers();
  assertThrows(
    () =>
      handlers.error({
        kind: "error",
        error: { code: "vault_not_found", message: "Vault not found" },
      }),
    UserError,
    "Vault not found",
  );
});
