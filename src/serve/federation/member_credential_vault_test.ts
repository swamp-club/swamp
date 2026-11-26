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

import { assert, assertEquals } from "@std/assert";
import { SERVER_TOKEN_SECRET_KEY_PREFIX } from "../../domain/models/access/server_token_model.ts";
import { MemberCredential } from "../../domain/serve/member_credential.ts";
import { ControlPlaneVaultProvider } from "../../domain/vaults/control_plane_vault_provider.ts";
import { MemoryControlPlaneStore } from "./federation_hub_test_helpers.ts";
import {
  MEMBER_CREDENTIAL_SECRET,
  MemberCredentialVault,
} from "./member_credential_vault.ts";

async function vaultOver(store: MemoryControlPlaneStore) {
  const provider = new ControlPlaneVaultProvider(store, { migrate: false });
  await provider.initialize();
  return provider;
}

Deno.test("MemberCredentialVault: stores, reads back and deletes the credential in the control-plane vault", async () => {
  const provider = await vaultOver(new MemoryControlPlaneStore());
  const vault = new MemberCredentialVault(provider);
  assertEquals(await vault.read(), undefined);
  const credential = MemberCredential.issue(crypto.randomUUID());
  await vault.store(credential);
  assertEquals((await vault.read())?.toWire(), credential.toWire());
  await vault.delete();
  assertEquals(await vault.read(), undefined);
});

Deno.test("MemberCredentialVault: the store never holds the credential in plaintext", async () => {
  const store = new MemoryControlPlaneStore();
  const vault = new MemberCredentialVault(await vaultOver(store));
  const credential = MemberCredential.issue(crypto.randomUUID());
  await vault.store(credential);
  const secret = credential.toWire().split(".")[2];
  for (const bytes of store.entries.values()) {
    const text = new TextDecoder().decode(bytes);
    assert(!text.includes(secret));
    assert(!text.includes("swfm1."));
  }
});

Deno.test("MemberCredentialVault: something stored that is not a credential reads as none", async () => {
  const provider = await vaultOver(new MemoryControlPlaneStore());
  await provider.put(MEMBER_CREDENTIAL_SECRET, "not-a-credential");
  assertEquals(await new MemberCredentialVault(provider).read(), undefined);
});

// token GC, token health and the token consistency sweep select keys by this prefix
Deno.test("MEMBER_CREDENTIAL_SECRET: lies outside the server token key space", () => {
  assert(!MEMBER_CREDENTIAL_SECRET.startsWith(SERVER_TOKEN_SECRET_KEY_PREFIX));
});
