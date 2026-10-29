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
import type { VaultProvider } from "../domain/vaults/vault_provider.ts";
import {
  isPeerToken,
  PEER_KEY_SECRET,
  PEER_TOKEN_PREFIX,
  TeamPeerKey,
} from "./peer_auth.ts";

function memoryVault(): VaultProvider & { secrets: Map<string, string> } {
  const secrets = new Map<string, string>();
  return {
    secrets,
    get: (key) => {
      const value = secrets.get(key);
      return value === undefined
        ? Promise.reject(new Error("missing"))
        : Promise.resolve(value);
    },
    put: (key, value) => {
      secrets.set(key, value);
      return Promise.resolve();
    },
  } as VaultProvider & { secrets: Map<string, string> };
}

Deno.test("TeamPeerKey: makes the key once and every node reads the same one", async () => {
  const vault = memoryVault();
  const a = new TeamPeerKey(vault);
  const b = new TeamPeerKey(vault);
  const token = await a.token();
  assert(token.startsWith(PEER_TOKEN_PREFIX));
  assertEquals(await b.token(), token);
  assertEquals(vault.secrets.size, 1);
  assert(vault.secrets.has(PEER_KEY_SECRET));
});

Deno.test("TeamPeerKey.verify: only the team's key, and only as a peer token", async () => {
  const vault = memoryVault();
  const key = new TeamPeerKey(vault);
  const token = await key.token();
  assert(await key.verify(token));
  assert(!await key.verify(`${PEER_TOKEN_PREFIX}${"0".repeat(64)}`));
  assert(!await key.verify(token.slice(PEER_TOKEN_PREFIX.length)));
  assert(!await key.verify("alice.secret"));
});

Deno.test("TeamPeerKey.verify: refuses everything while the team has no key", async () => {
  const key = new TeamPeerKey(memoryVault());
  assert(!await key.verify(`${PEER_TOKEN_PREFIX}${"a".repeat(64)}`));
});

Deno.test("TeamPeerKey: a key of another namespace's vault is refused", async () => {
  const mine = new TeamPeerKey(memoryVault());
  const theirs = new TeamPeerKey(memoryVault());
  await mine.token();
  assert(!await mine.verify(await theirs.token()));
});

Deno.test("isPeerToken: only the peer prefix", () => {
  assert(isPeerToken(`${PEER_TOKEN_PREFIX}abc`));
  assert(!isPeerToken("swamp-peerish.abc"));
  assert(!isPeerToken("alice.secret"));
});

Deno.test("TeamPeerKey.prove: a leader record the team signed is trusted; one with another address, or unsigned, is not", async () => {
  const vault = memoryVault();
  const leaderKey = new TeamPeerKey(vault);
  const followerKey = new TeamPeerKey(vault);
  const record = {
    instanceId: "leader-1",
    fence: 3,
    address: "https://node-a.internal:9090",
    since: "2026-10-29T12:00:00.000Z",
  };
  const signed = { ...record, proof: await leaderKey.prove(record) };
  assert(await followerKey.trusts(signed));
  assert(
    !await followerKey.trusts({ ...signed, address: "https://evil.example" }),
  );
  assert(!await followerKey.trusts({ ...signed, fence: 4 }));
  assert(!await followerKey.trusts(record));
  const otherTeam = new TeamPeerKey(memoryVault());
  assert(!await otherTeam.trusts(signed));
});
