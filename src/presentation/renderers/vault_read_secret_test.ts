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
import { consumeStream } from "../../libswamp/stream.ts";
import type { VaultReadSecretEvent } from "../../libswamp/vaults/read_secret.ts";
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

Deno.test("LogVaultReadSecretRenderer: writes secret with newline when stdout is a TTY", async () => {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);

  try {
    const renderer = createVaultReadSecretRenderer("log", () => true);
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

Deno.test("LogVaultReadSecretRenderer: writes exact bytes without trailing newline when piped", async () => {
  const written: Uint8Array[] = [];
  const originalWriteSync = Deno.stdout.writeSync.bind(Deno.stdout);
  Deno.stdout.writeSync = (data: Uint8Array): number => {
    written.push(new Uint8Array(data));
    return data.length;
  };

  try {
    const renderer = createVaultReadSecretRenderer("log", () => false);
    const events: VaultReadSecretEvent[] = [
      { kind: "resolving" },
      { kind: "completed", data: makeData() },
    ];
    await consumeStream(toStream(events), renderer.handlers());
    assertEquals(written.length, 1);
    const output = new TextDecoder().decode(written[0]);
    assertEquals(output, "super_secret_value");
  } finally {
    Deno.stdout.writeSync = originalWriteSync;
  }
});

/**
 * Replaces Deno.stdout.writeSync with `mock` for the duration of `body` and
 * returns every chunk the mock was handed, copied at call time.
 */
function withMockedStdoutWriteSync(
  mock: (data: Uint8Array, call: number) => number,
  body: () => void,
): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  const originalWriteSync = Deno.stdout.writeSync.bind(Deno.stdout);
  Deno.stdout.writeSync = (data: Uint8Array): number => {
    const written = mock(data, chunks.length);
    chunks.push(new Uint8Array(data.subarray(0, written)));
    return written;
  };
  try {
    body();
  } finally {
    Deno.stdout.writeSync = originalWriteSync;
  }
  return chunks;
}

function concat(chunks: Uint8Array[]): string {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(joined);
}

function completedWith(value: string): void {
  const renderer = createVaultReadSecretRenderer("log", () => false);
  renderer.handlers().completed({
    kind: "completed",
    data: { ...makeData(), value },
  });
}

Deno.test("LogVaultReadSecretRenderer: piped output keeps a 1024+ char last line after a short write at the last newline", () => {
  // Deno's line-buffered stdout writer emits complete lines and returns a
  // short count when the trailing partial line is 1024+ bytes
  // (swamp-club#3006). Model that cut: the first call writes through the
  // last newline only; later calls take everything.
  const lastLine = "k: " + "x".repeat(1021);
  const value = `a: b\n${lastLine}`;
  const encoded = new TextEncoder().encode(value);

  const chunks = withMockedStdoutWriteSync(
    (data, call) =>
      call === 0 ? data.lastIndexOf("\n".charCodeAt(0)) + 1 : data.length,
    () => completedWith(value),
  );

  assertEquals(chunks.length, 2);
  assertEquals(new TextDecoder().decode(chunks[0]), "a: b\n");
  assertEquals(new TextDecoder().decode(chunks[1]), lastLine);
  assertEquals(concat(chunks), value);
  assertEquals(concat(chunks).length, encoded.length);
});

Deno.test("LogVaultReadSecretRenderer: piped output is complete and in order however stdout cuts the writes", () => {
  const value = "super_secret_value\nsecond line";

  const chunks = withMockedStdoutWriteSync(
    (data, call) => Math.min(data.length, (call % 3) + 1),
    () => completedWith(value),
  );

  assertEquals(concat(chunks), value);
  assertEquals(chunks.every((c) => c.length > 0), true);
});

Deno.test("LogVaultReadSecretRenderer: a zero-byte write to piped stdout throws UserError instead of looping", () => {
  const value = "super_secret_value";

  assertThrows(
    () =>
      withMockedStdoutWriteSync(
        (_data, call) => (call === 0 ? 5 : 0),
        () => completedWith(value),
      ),
    UserError,
    "13 of 18 bytes of the secret unwritten",
  );
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
