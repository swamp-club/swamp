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

import { assert, assertEquals, assertRejects } from "@std/assert";
import type { VaultProvider } from "../domain/vaults/vault_provider.ts";
import {
  APP_LAUNCH_KEY_CACHE_MS,
  APP_LAUNCH_KEY_SECRET,
  APP_LAUNCH_KEY_STALE_MS,
  EphemeralAppLaunchKey,
  VaultAppLaunchKey,
} from "./app_launch_key.ts";

function memoryVault(): VaultProvider & {
  secrets: Map<string, string>;
  failReads: boolean;
  gets: number;
} {
  const secrets = new Map<string, string>();
  const vault = {
    secrets,
    failReads: false,
    gets: 0,
    list: () => Promise.resolve([...secrets.keys()]),
    get: (key: string) => {
      vault.gets++;
      if (vault.failReads) return Promise.reject(new Error("vault timeout"));
      const value = secrets.get(key);
      return value === undefined
        ? Promise.reject(new Error("missing"))
        : Promise.resolve(value);
    },
    put: (key: string, value: string) => {
      secrets.set(key, value);
      return Promise.resolve();
    },
  };
  return vault as unknown as VaultProvider & {
    secrets: Map<string, string>;
    failReads: boolean;
    gets: number;
  };
}

function hex(bytes: Uint8Array | undefined): string | undefined {
  return bytes === undefined
    ? undefined
    : Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
}

Deno.test("VaultAppLaunchKey: makes the key once and every instance reads the same one", async () => {
  const vault = memoryVault();
  const a = new VaultAppLaunchKey(vault);
  const b = new VaultAppLaunchKey(vault);
  const made = hex(await a.signing());
  assertEquals(hex(await b.signing()), made);
  assertEquals(hex(await b.verifying()), made);
  assertEquals(vault.secrets.get(APP_LAUNCH_KEY_SECRET), made);
  assertEquals(vault.secrets.size, 1);
});

Deno.test("VaultAppLaunchKey: no key in the vault verifies nothing and makes none", async () => {
  const vault = memoryVault();
  assertEquals(await new VaultAppLaunchKey(vault).verifying(), undefined);
  assertEquals(vault.secrets.size, 0);
});

Deno.test("VaultAppLaunchKey: a failed read never replaces the key", async () => {
  const vault = memoryVault();
  await new VaultAppLaunchKey(vault).signing();
  const stored = vault.secrets.get(APP_LAUNCH_KEY_SECRET);
  vault.failReads = true;
  await assertRejects(() => new VaultAppLaunchKey(vault).signing());
  assertEquals(vault.secrets.get(APP_LAUNCH_KEY_SECRET), stored);
});

Deno.test("VaultAppLaunchKey: a value that is not a key is refused, not overwritten", async () => {
  const vault = memoryVault();
  vault.secrets.set(APP_LAUNCH_KEY_SECRET, "not-a-key");
  await assertRejects(() => new VaultAppLaunchKey(vault).signing());
  assertEquals(vault.secrets.get(APP_LAUNCH_KEY_SECRET), "not-a-key");
});

Deno.test("VaultAppLaunchKey: a page of files costs one vault read per window", async () => {
  let now = 0;
  const vault = memoryVault();
  const key = new VaultAppLaunchKey(vault, () => now);
  const made = hex(await key.signing());
  vault.gets = 0;
  now = APP_LAUNCH_KEY_CACHE_MS;
  const checks = await Promise.all(
    Array.from({ length: 50 }, () => key.verifying()),
  );
  assertEquals(new Set(checks.map(hex)), new Set([made]));
  assertEquals(vault.gets, 1);
});

Deno.test("VaultAppLaunchKey: a cached key outlives failing reads only for a bounded time", async () => {
  let now = 0;
  const vault = memoryVault();
  const key = new VaultAppLaunchKey(vault, () => now);
  const made = hex(await key.signing());
  vault.failReads = true;
  now = APP_LAUNCH_KEY_CACHE_MS + APP_LAUNCH_KEY_STALE_MS - 1;
  assertEquals(hex(await key.verifying()), made);
  now = 2 * (APP_LAUNCH_KEY_CACHE_MS + APP_LAUNCH_KEY_STALE_MS);
  assertEquals(await key.verifying(), undefined);
});

Deno.test("EphemeralAppLaunchKey: one key per process, never shared", async () => {
  const one = new EphemeralAppLaunchKey();
  assertEquals(hex(await one.verifying()), hex(await one.signing()));
  assert(
    hex(await one.signing()) !==
      hex(await new EphemeralAppLaunchKey().signing()),
  );
});
