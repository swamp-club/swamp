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

/**
 * LocalEncryptionVaultProvider.has(): the VaultExistenceProvider contract
 * answered from a stat on the secret's file plus the cached key material,
 * never from the file's contents.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  localEncryptionSecretsDir,
  LocalEncryptionVaultProvider,
} from "./local_encryption_vault_provider.ts";

const VAULT = "existence-vault";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-vault-existence-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native handles yet.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

function autoProvider(dir: string): LocalEncryptionVaultProvider {
  return new LocalEncryptionVaultProvider(VAULT, {
    auto_generate: true,
    base_dir: dir,
  });
}

Deno.test("LocalEncryptionVaultProvider.has: false for a missing key, and creates nothing", async () => {
  await withTempDir(async (dir) => {
    const vault = autoProvider(dir);
    assertEquals(await vault.has("missing"), false);
    // No vault directory yet: a has() on a missing key makes no file.
    await assertRejects(
      () => Deno.stat(localEncryptionSecretsDir(dir, VAULT)),
      Deno.errors.NotFound,
    );
  });
});

Deno.test("LocalEncryptionVaultProvider.has: true after put, false after delete", async () => {
  await withTempDir(async (dir) => {
    const vault = autoProvider(dir);
    await vault.put("k", "v");
    assertEquals(await vault.has("k"), true);
    assertEquals(await vault.has("other"), false);
    await vault.delete("k");
    assertEquals(await vault.has("k"), false);
  });
});

Deno.test("LocalEncryptionVaultProvider.has: true for an empty-string secret", async () => {
  await withTempDir(async (dir) => {
    const vault = autoProvider(dir);
    await vault.put("empty", "");
    assertEquals(await vault.has("empty"), true);
  });
});

Deno.test("LocalEncryptionVaultProvider.has: rejects an invalid key as get does", async () => {
  await withTempDir(async (dir) => {
    const vault = autoProvider(dir);
    const fromHas = await assertRejects(() => vault.has("../escape"), Error);
    const fromGet = await assertRejects(() => vault.get("../escape"), Error);
    assertStringIncludes(fromHas.message, "Invalid secret key '../escape'");
    assertEquals(fromHas.message, fromGet.message);
  });
});

Deno.test("LocalEncryptionVaultProvider.has: never reads the file, so a garbage secret file answers true while get rejects", async () => {
  await withTempDir(async (dir) => {
    const vault = autoProvider(dir);
    await vault.put("seed", "v"); // creates the vault directory and its key
    await Deno.writeTextFile(
      join(localEncryptionSecretsDir(dir, VAULT), "garbage.enc"),
      "this is not an encrypted record",
    );

    assertEquals(await vault.has("garbage"), true);
    const fromGet = await assertRejects(() => vault.get("garbage"), Error);
    assertStringIncludes(
      fromGet.message,
      "Failed to retrieve secret 'garbage'",
    );
  });
});

Deno.test("LocalEncryptionVaultProvider.has: rejects when the key source is unavailable, with the error get raises", async () => {
  await withTempDir(async (dir) => {
    await autoProvider(dir).put("k", "v");

    // Same vault, same files, but credentials that cannot be loaded.
    const broken = new LocalEncryptionVaultProvider(VAULT, {
      ssh_key_path: join(dir, "no-such-key"),
      auto_generate: false,
      base_dir: dir,
    });
    const fromHas = await assertRejects(() => broken.has("k"), Error);
    const fromGet = await assertRejects(() => broken.get("k"), Error);
    assertStringIncludes(fromHas.message, "Failed to retrieve secret 'k'");
    assertStringIncludes(fromHas.message, "Failed to read SSH key");
    assertEquals(fromHas.message, fromGet.message);

    // A missing key is still answered before credentials are needed.
    assertEquals(await broken.has("missing"), false);
  });
});

Deno.test({
  name:
    "LocalEncryptionVaultProvider.has: rejects a secret file the process cannot read, as get does",
  // chmod has no effect on Windows, and root reads any file.
  ignore: Deno.build.os === "windows" || Deno.uid() === 0,
  async fn() {
    await withTempDir(async (dir) => {
      const vault = autoProvider(dir);
      await vault.put("locked", "v");
      const path = join(localEncryptionSecretsDir(dir, VAULT), "locked.enc");
      await Deno.chmod(path, 0o000);
      try {
        const fromHas = await assertRejects(() => vault.has("locked"), Error);
        const fromGet = await assertRejects(() => vault.get("locked"), Error);
        assertStringIncludes(
          fromHas.message,
          "Failed to retrieve secret 'locked'",
        );
        assertStringIncludes(
          fromGet.message,
          "Failed to retrieve secret 'locked'",
        );
        assertStringIncludes(fromHas.message, "ermission denied");
      } finally {
        await Deno.chmod(path, 0o600);
      }
    });
  },
});

Deno.test("LocalEncryptionVaultProvider.has: with auto_generate and no key file, loads key material as get would, which writes a new .key", async () => {
  await withTempDir(async (dir) => {
    await autoProvider(dir).put("k", "v");
    const keyFile = join(localEncryptionSecretsDir(dir, VAULT), ".key");
    await Deno.remove(keyFile);

    // A fresh instance holds no cached key material, so has() loads it.
    const fresh = autoProvider(dir);
    assertEquals(await fresh.has("k"), true);
    await Deno.stat(keyFile); // regenerated, exactly as get would do
    // The old file no longer decrypts under the new key: the integrity
    // fault has() cannot see without reading, which get reports at load.
    await assertRejects(() => fresh.get("k"), Error);
  });
});

Deno.test("LocalEncryptionVaultProvider.has: a directory in place of the secret file rejects as get does", async () => {
  await withTempDir(async (dir) => {
    const vault = autoProvider(dir);
    await vault.put("seed", "v");
    await Deno.mkdir(join(localEncryptionSecretsDir(dir, VAULT), "dir.enc"));

    const fromHas = await assertRejects(() => vault.has("dir"), Error);
    const fromGet = await assertRejects(() => vault.get("dir"), Error);
    assertStringIncludes(fromHas.message, "Failed to retrieve secret 'dir'");
    assertStringIncludes(fromGet.message, "Failed to retrieve secret 'dir'");
  });
});
