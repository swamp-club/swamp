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

// Moving `_token-secrets` from its co-located key to an operator-supplied
// external key (serve.yaml token-secrets, swamp-club#2324), against a real
// control-plane store on disk: concurrent instances, an interrupted
// migration, and what an instance without the key sees afterwards.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { walk } from "@std/fs";
import { join } from "@std/path";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  type EncryptedBlob,
  importAesKey,
} from "../src/domain/crypto/aes_gcm.ts";
import { UserError } from "../src/domain/errors.ts";
import {
  initializeControlPlaneVault,
  type TokenSecretsKeyVaultReader,
} from "../src/domain/vaults/control_plane_vault_init.ts";
import { ControlPlaneVaultProvider } from "../src/domain/vaults/control_plane_vault_provider.ts";
import {
  classifyTokenKeyRecord,
  TokenSecretsKeyError,
} from "../src/domain/vaults/token_secrets_key.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { FileSystemControlPlaneStore } from "../src/infrastructure/persistence/fs_control_plane_store.ts";

await initializeLogging({});

const REF = { vault: "prod-secrets", key: "swamp-token-key" };
const SECRETS: Record<string, string> = {
  "server-token-alice": "alice-secret",
  "server-token-bob": "bob-secret",
  "enrollment-token-ci": "ci-secret",
};

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-token-key-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

/** A control plane written by a swamp without the opt-in: co-located key. */
async function seedCoLocated(dir: string): Promise<Uint8Array> {
  const legacy = new ControlPlaneVaultProvider(
    new FileSystemControlPlaneStore(dir),
  );
  await legacy.initialize();
  for (const [name, value] of Object.entries(SECRETS)) {
    await legacy.put(name, value);
  }
  return await Deno.readFile(keyRecordPath(dir));
}

function keyRecordPath(dir: string): string {
  return join(dir, "_control", "token-secrets", "encryption-key");
}

function external(dir: string, key: Uint8Array): ControlPlaneVaultProvider {
  return new ControlPlaneVaultProvider(new FileSystemControlPlaneStore(dir), {
    externalKey: { ref: REF, key },
  });
}

/** Every file under the control plane that decrypts with the given key. */
async function filesOpenedBy(
  dir: string,
  keyBytes: Uint8Array,
): Promise<string[]> {
  const key = await importAesKey(keyBytes);
  const opened: string[] = [];
  for await (
    const entry of walk(join(dir, "_control"), { includeDirs: false })
  ) {
    let blob: EncryptedBlob;
    try {
      blob = JSON.parse(await Deno.readTextFile(entry.path));
      await aesGcmDecrypt(blob, key);
      opened.push(entry.name);
    } catch {
      // not a blob, or not this key
    }
  }
  return opened;
}

/** Every file under the control plane, keyed by path relative to it. */
async function snapshotControlPlane(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const root = join(dir, "_control");
  for await (const entry of walk(root, { includeDirs: false })) {
    const bytes = await Deno.readFile(entry.path);
    files.set(
      entry.path.slice(root.length),
      btoa(String.fromCharCode(...bytes)),
    );
  }
  return files;
}

function keyReader(value: string | undefined): TokenSecretsKeyVaultReader {
  return {
    get: () =>
      value === undefined
        ? Promise.reject(new Error("Secret 'swamp-token-key' not found"))
        : Promise.resolve(value),
  };
}

Deno.test("token key default: without a token-secrets key the co-located key and its secrets are used as before", async () => {
  await withTempDir(async (dir) => {
    const legacyKey = await seedCoLocated(dir);
    const before = await snapshotControlPlane(dir);

    const { provider } = await initializeControlPlaneVault(
      new FileSystemControlPlaneStore(dir),
      false,
    );
    for (const [name, value] of Object.entries(SECRETS)) {
      assertEquals(await provider.get(name), value);
    }
    assertEquals(await snapshotControlPlane(dir), before);

    // New secrets still go under the same co-located key.
    await provider.put("server-token-new", "new-secret");
    assertEquals(await Deno.readFile(keyRecordPath(dir)), legacyKey);
    assertEquals(
      (await filesOpenedBy(dir, legacyKey)).sort(),
      [...Object.keys(SECRETS), "server-token-new"].sort(),
    );
  });
});

Deno.test("token key error: an unusable key refuses to start and leaves the control plane untouched", async () => {
  await withTempDir(async (dir) => {
    await seedCoLocated(dir);
    const before = await snapshotControlPlane(dir);
    const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

    const cases: Array<[string, string | undefined, string]> = [
      ["missing secret", undefined, "Could not read the token secrets key"],
      ["16-byte key", b64(new Uint8Array(16).fill(7)), "got 16"],
      ["not hex or base64", "not a key!", "not valid hex or base64"],
      ["all-zero key", b64(new Uint8Array(32)), "same value in every byte"],
    ];
    for (const [label, value, message] of cases) {
      await assertRejects(
        () =>
          initializeControlPlaneVault(
            new FileSystemControlPlaneStore(dir),
            true,
            {
              tokenSecretsKey: REF,
              vaultService: () => Promise.resolve(keyReader(value)),
            },
          ),
        TokenSecretsKeyError,
        message,
        label,
      );
      assertEquals(await snapshotControlPlane(dir), before, label);
    }

    // Dropping the block returns to the default with every secret intact.
    const { provider } = await initializeControlPlaneVault(
      new FileSystemControlPlaneStore(dir),
      true,
    );
    for (const [name, value] of Object.entries(SECRETS)) {
      assertEquals(await provider.get(name), value);
    }
  });
});

Deno.test("token key migration: concurrent opted-in instances move every secret and drop the co-located key", async () => {
  await withTempDir(async (dir) => {
    const legacyKey = await seedCoLocated(dir);
    const key = crypto.getRandomValues(new Uint8Array(32));

    const instances = [external(dir, key), external(dir, new Uint8Array(key))];
    await Promise.all(instances.map((p) => p.initialize()));

    for (const provider of instances) {
      for (const [name, value] of Object.entries(SECRETS)) {
        assertEquals(await provider.get(name), value);
      }
    }
    assertEquals(
      classifyTokenKeyRecord(await Deno.readFile(keyRecordPath(dir))).kind,
      "marker",
    );
    // What bucket read access now yields: no 32-byte key anywhere, and no
    // blob opens with the key that used to sit beside them.
    for await (
      const entry of walk(join(dir, "_control"), { includeDirs: false })
    ) {
      assert((await Deno.stat(entry.path)).size !== 32, entry.path);
    }
    assertEquals(await filesOpenedBy(dir, legacyKey), []);
    assertEquals(
      (await filesOpenedBy(dir, key)).sort(),
      Object.keys(SECRETS).sort(),
    );
  });
});

Deno.test("token key migration: the next start completes an interrupted migration", async () => {
  await withTempDir(async (dir) => {
    await seedCoLocated(dir);
    const key = crypto.getRandomValues(new Uint8Array(32));

    // Crash after one secret was re-encrypted, before the marker.
    const blob = await aesGcmEncrypt(
      SECRETS["server-token-bob"],
      await importAesKey(key),
    );
    await Deno.writeTextFile(
      join(dir, "_control", "token-secrets", "values", "server-token-bob"),
      JSON.stringify(blob),
    );
    assertEquals(
      classifyTokenKeyRecord(await Deno.readFile(keyRecordPath(dir))).kind,
      "legacy",
    );

    const resumed = external(dir, key);
    await resumed.initialize();
    for (const [name, value] of Object.entries(SECRETS)) {
      assertEquals(await resumed.get(name), value);
    }
    assertEquals(
      classifyTokenKeyRecord(await Deno.readFile(keyRecordPath(dir))).kind,
      "marker",
    );
  });
});

Deno.test("token key migration: afterwards an instance without the key, or with another key, refuses to start", async () => {
  await withTempDir(async (dir) => {
    await seedCoLocated(dir);
    await external(dir, crypto.getRandomValues(new Uint8Array(32)))
      .initialize();
    const migrated = await snapshotControlPlane(dir);

    await assertRejects(
      () =>
        new ControlPlaneVaultProvider(new FileSystemControlPlaneStore(dir))
          .initialize(),
      UserError,
      "vault 'prod-secrets'",
    );
    await assertRejects(
      () =>
        external(dir, crypto.getRandomValues(new Uint8Array(32)))
          .initialize(),
      UserError,
      "is not the key",
    );
    // Refusing writes nothing: no fresh key, no marker, no re-encryption.
    assertEquals(await snapshotControlPlane(dir), migrated);
    // A swamp release without external-key support reads the record as a raw
    // key; the marker must fail that import rather than be replaced.
    await assertRejects(async () =>
      await importAesKey(await Deno.readFile(keyRecordPath(dir)))
    );
  });
});
