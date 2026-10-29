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
  isPeerToken,
  PEER_KEY_CACHE_MS,
  PEER_KEY_SECRET,
  PEER_KEY_STALE_MS,
  PEER_TOKEN_PREFIX,
  requestClientAddress,
  TEAM_PEER_HEADER,
  TeamPeerKey,
  withoutTeamPeerHeader,
} from "./peer_auth.ts";

function memoryVault(): VaultProvider & {
  secrets: Map<string, string>;
  failReads: boolean;
} {
  const secrets = new Map<string, string>();
  const vault = {
    secrets,
    failReads: false,
    list: () => Promise.resolve([...secrets.keys()]),
    get: (key: string) => {
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
  };
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

Deno.test("TeamPeerKey: a failed read never replaces the team's key", async () => {
  const vault = memoryVault();
  const key = new TeamPeerKey(vault);
  const token = await key.token();
  const stored = vault.secrets.get(PEER_KEY_SECRET);
  vault.failReads = true;
  await assertRejects(() => new TeamPeerKey(vault).token());
  assertEquals(vault.secrets.get(PEER_KEY_SECRET), stored);
  // A node that read the key recently still verifies with it.
  assert(await key.verify(token));
});

Deno.test("TeamPeerKey: a value that is not a key is refused, not overwritten", async () => {
  const vault = memoryVault();
  vault.secrets.set(PEER_KEY_SECRET, "not-a-key");
  await assertRejects(() => new TeamPeerKey(vault).token());
  assertEquals(vault.secrets.get(PEER_KEY_SECRET), "not-a-key");
  vault.secrets.set(PEER_KEY_SECRET, `${"b".repeat(64)}\n`);
  assertEquals(
    await new TeamPeerKey(vault).token(),
    `${PEER_TOKEN_PREFIX}${"b".repeat(64)}`,
  );
});

Deno.test("TeamPeerKey.verifyCached: checks a forwarding header against the key last read, without a vault read (swamp-club#4148)", async () => {
  const vault = memoryVault();
  const key = new TeamPeerKey(vault);
  assert(!key.verifyCached(`${PEER_TOKEN_PREFIX}${"c".repeat(64)}`));
  assertEquals(key.cachedToken(), undefined);
  const token = await key.token();
  vault.failReads = true;
  assert(key.verifyCached(token));
  assertEquals(key.cachedToken(), token);
  assert(!key.verifyCached(`${PEER_TOKEN_PREFIX}${"c".repeat(64)}`));
  assert(!key.verifyCached(token.slice(PEER_TOKEN_PREFIX.length)));
});

Deno.test("TeamPeerKey: a cached key outlives failing vault reads only for a bounded time (swamp-club#4148)", async () => {
  let now = 0;
  const vault = memoryVault();
  const key = new TeamPeerKey(vault, () => now);
  const token = await key.token();
  vault.failReads = true;
  now = PEER_KEY_CACHE_MS + PEER_KEY_STALE_MS - 1;
  assert(await key.verify(token));
  assert(key.verifyCached(token));
  now = PEER_KEY_CACHE_MS + PEER_KEY_STALE_MS + 1;
  assert(!await key.verify(token));
  assert(!key.verifyCached(token));
  assertEquals(key.cachedToken(), undefined);
});

Deno.test("requestClientAddress: the socket peer, the first entry behind a trusted proxy, the follower's entry for a verified team forward", () => {
  const headers = (extra: Record<string, string> = {}) =>
    new Headers({ "x-forwarded-for": "198.51.100.9, 10.0.0.5", ...extra });
  const verify = (header: string) => header === "swamp-peer.good";
  assertEquals(
    requestClientAddress(headers(), "10.0.0.2", false, verify),
    "10.0.0.2",
  );
  assertEquals(
    requestClientAddress(headers(), "10.0.0.2", true, verify),
    "198.51.100.9",
  );
  assertEquals(
    requestClientAddress(
      headers({ [TEAM_PEER_HEADER]: "swamp-peer.good" }),
      "10.0.0.2",
      false,
      verify,
    ),
    "10.0.0.5",
  );
  // A forged header is ignored: the request is keyed on its socket peer.
  assertEquals(
    requestClientAddress(
      headers({ [TEAM_PEER_HEADER]: "swamp-peer.forged" }),
      "10.0.0.2",
      false,
      verify,
    ),
    "10.0.0.2",
  );
});

Deno.test("withoutTeamPeerHeader: drops the team's peer token and keeps the rest of the request (swamp-club#4148)", async () => {
  const req = new Request("http://leader.example/hooks/gh", {
    method: "POST",
    headers: {
      [TEAM_PEER_HEADER]: "swamp-peer.secret",
      "x-hub-signature-256": "sha256=abc",
    },
    body: "delivery",
  });
  const stripped = withoutTeamPeerHeader(req);
  assertEquals(stripped.headers.get(TEAM_PEER_HEADER), null);
  assertEquals(stripped.headers.get("x-hub-signature-256"), "sha256=abc");
  assertEquals(stripped.method, "POST");
  assertEquals(await stripped.text(), "delivery");
  const plain = new Request("http://leader.example/x");
  assertEquals(withoutTeamPeerHeader(plain), plain);
});
