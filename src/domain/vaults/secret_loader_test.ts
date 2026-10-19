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

import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { UserError } from "../errors.ts";
import { RefreshHook } from "./refresh_hook.ts";
import { RunVaultAccess, runWithVaultAccess } from "./run_vault_access.ts";
import { SecretBagRegistry } from "./secret_bag_registry.ts";
import { LOAD_PURPOSE, SecretLoader } from "./secret_loader.ts";
import { checkSecretReference } from "./secret_reference_check.ts";
import { VaultSecretBag } from "./vault_secret_bag.ts";
import { VaultService } from "./vault_service.ts";

/**
 * A vault service over mock vault `v` holding `secrets`, recording each
 * read that returned a value.
 */
function mockVault(secrets: Record<string, string>) {
  const reads: { key: string; caller?: string }[] = [];
  const service = new class extends VaultService {
    override async get(vaultName: string, key: string, caller?: string) {
      const value = await super.get(vaultName, key, caller);
      reads.push({ key, caller });
      return value;
    }
  }();
  service.registerVault({ name: "v", type: "mock", config: secrets });
  return { service, reads };
}

const loaderOver = (service: VaultService, redacted: string[] = []) =>
  new SecretLoader(
    () => Promise.resolve(service),
    { addSecret: (value) => redacted.push(value) },
  );

Deno.test("SecretLoader.load: reads each reference the data carries once, and only those", async () => {
  const { service, reads } = mockVault({ a: "value-a", b: "value-b" });
  const registry = new SecretBagRegistry();
  const bag = new VaultSecretBag(registry);
  const a1 = bag.addSecret({ vaultName: "v", key: "a" }, "globalArguments.a");
  const a2 = bag.addSecret({ vaultName: "v", key: "a" }, "methods.run.x");
  const b = bag.addSecret({ vaultName: "v", key: "b" }, "methods.other.y");
  const data = bag.addDataSecret("from-data", { vaultName: "v", key: "d" });
  const foreign = `__SWAMP_VSEC_${"f".repeat(32)}_0__`;
  const redacted: string[] = [];

  const view = await loaderOver(service, redacted).load(bag, {
    globalArguments: { a: a1 },
    methods: { run: { x: `${a2} ${data} ${foreign}` } },
  });

  assertEquals(reads, [{ key: "a", caller: LOAD_PURPOSE }]);
  assertEquals(redacted, ["value-a"]);
  assertEquals(
    view.resolveRaw(`${a1} ${a2} ${data} ${foreign}`),
    `value-a value-a from-data ${foreign}`,
  );
  // A reference the data does not carry stays unloaded, and the bag itself
  // is never filled.
  assertThrows(() => view.resolveRaw(b), Error, "was not loaded");
  assertThrows(() => bag.resolveRaw(a1), Error, "was not loaded");
});

Deno.test("SecretLoader.load: with no vault reference to load, the bag is returned and no vault is read", async () => {
  let resolved = 0;
  const loader = new SecretLoader(() => {
    resolved++;
    return Promise.resolve(new VaultService());
  });
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const data = bag.addDataSecret("from-data", { vaultName: "v", key: "d" });
  assertStrictEquals(await loader.load(bag, { run: data }), bag);
  assertEquals(resolved, 0);
});

Deno.test("SecretLoader.load: each call is its own attempt and reads again", async () => {
  const { service, reads } = mockVault({ a: "value-a" });
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const sentinel = bag.addSecret({ vaultName: "v", key: "a" }, "loc");
  const loader = loaderOver(service);
  await loader.load(bag, sentinel);
  await loader.load(bag, sentinel);
  assertEquals(reads.length, 2);
});

Deno.test("SecretLoader.load: a failed read names the vault, the key and the location, never a value", async () => {
  const { service } = mockVault({ other: "other-s3cret" });
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const sentinel = bag.addSecret(
    { vaultName: "v", key: "missing" },
    "methods.run.arguments.cmd",
  );
  const error = await assertRejects(
    () => loaderOver(service).load(bag, sentinel),
    Error,
    "Failed to load secret 'missing' from vault 'v' at methods.run.arguments.cmd: ",
  );
  assertEquals(error.message.includes("other-s3cret"), false);
});

Deno.test("SecretLoader.load: a load runs under the run's vault access, and a refusal keeps its code", async () => {
  const { service, reads } = mockVault({ a: "value-a" });
  const bag = new VaultSecretBag(new SecretBagRegistry());
  const sentinel = bag.addSecret({ vaultName: "v", key: "a" }, "loc");
  const narrowed = RunVaultAccess.create({
    allowedVaults: ["elsewhere"],
    allowListSource: "deploy",
  });
  await runWithVaultAccess(narrowed, async () => {
    const error = await assertRejects(
      () => loaderOver(service).load(bag, sentinel),
      UserError,
      "Failed to load secret 'a' from vault 'v' at loc: Reading vault 'v' is refused",
    );
    assertEquals(error.code, "vault_access_denied");
  });
  assertEquals(reads.length, 0);
});

Deno.test("SecretLoader.load: a stale refresh hook refreshes on load, and the existence check leaves it alone", async () => {
  let refreshed = 0;
  const service = new VaultService({
    runCommand: () => {
      refreshed++;
      return Promise.resolve({ success: true, stdout: "fresh\n", stderr: "" });
    },
  });
  const baseDir = await Deno.makeTempDir({ prefix: "swamp-3562-" });
  service.registerVault({
    name: "v",
    type: "local_encryption",
    config: { auto_generate: true, base_dir: baseDir },
  });
  try {
    const key = "TOKEN";
    await service.put("v", key, "stale");
    await service.putRefreshHook("v", key, RefreshHook.create("refresh", 1));

    const registry = new SecretBagRegistry();
    const bag = new VaultSecretBag(registry);
    const reference = { vaultName: "v", key };
    await checkSecretReference(service, reference, {
      registry,
      call: `vault.get('v', '${key}')`,
      location: "loc",
    });
    assertEquals(refreshed, 0);

    const sentinel = bag.addSecret(reference, "loc");
    const view = await loaderOver(service).load(bag, sentinel);
    assertEquals(view.resolveRaw(sentinel), "fresh");
    assertEquals(refreshed, 1);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(baseDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(baseDir, { recursive: true });
    }
  }
});
