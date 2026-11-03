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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { stripAnsiCode } from "@std/fmt/colors";
import type { AuthTokenCreateData } from "../../libswamp/auth/token_create.ts";
import type { AuthTokenListData } from "../../libswamp/auth/token_list.ts";
import type { AuthTokenRevokeData } from "../../libswamp/auth/token_revoke.ts";
import {
  renderAuthTokenCreate,
  renderAuthTokenDelete,
  renderAuthTokenList,
  renderAuthTokenRevoke,
} from "./auth_token_output.ts";

function captureLogs(fn: () => void): string {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    fn();
  } finally {
    console.log = originalLog;
  }
  return stripAnsiCode(logs.join("\n"));
}

const listData: AuthTokenListData = {
  collective: "myorg",
  tokens: [
    {
      id: "tok-1",
      name: "ci-deploy",
      keyPrefix: "swamp_org_ab",
      enabled: true,
      expiresAt: null,
      createdAt: "2026-07-23T00:00:00Z",
      lastUsedAt: "2026-08-15T12:00:00Z",
      scopes: ["extensions:push"],
      mintedByTokenId: null,
      status: "active",
    },
    {
      id: "tok-2",
      name: "staging-runner",
      keyPrefix: "swamp_org_cd",
      enabled: true,
      expiresAt: "2027-01-01T00:00:00Z",
      createdAt: "2026-08-01T00:00:00Z",
      lastUsedAt: null,
      scopes: ["serve:*"],
      mintedByTokenId: "tok-1",
      status: "revoked",
    },
  ],
  moreInactive: false,
};

const revokeData: AuthTokenRevokeData = {
  id: "tok-1",
  collective: "myorg",
};

Deno.test("renderAuthTokenList: log mode shows table with token metadata", () => {
  const output = captureLogs(() => renderAuthTokenList(listData, "log"));
  assertStringIncludes(output, "ci-deploy");
  assertStringIncludes(output, "staging-runner");
  assertStringIncludes(output, "swamp_org_ab");
  assertStringIncludes(output, "extensions:push");
});

Deno.test("renderAuthTokenList: log mode never includes secret key", () => {
  const output = captureLogs(() => renderAuthTokenList(listData, "log"));
  assertEquals(output.includes("swamp_org_abcdef"), false);
});

Deno.test("renderAuthTokenList: json mode outputs tokens array", () => {
  const output = captureLogs(() => renderAuthTokenList(listData, "json"));
  const parsed = JSON.parse(output);
  assertEquals(Array.isArray(parsed), true);
  assertEquals(parsed.length, 2);
  assertEquals(parsed[0].name, "ci-deploy");
  assertEquals("key" in parsed[0], false);
});

Deno.test("renderAuthTokenList: empty list shows hint", () => {
  const emptyData: AuthTokenListData = {
    collective: "myorg",
    tokens: [],
    moreInactive: false,
  };
  const output = captureLogs(() => renderAuthTokenList(emptyData, "log"));
  assertStringIncludes(output, "No API tokens found");
  assertStringIncludes(output, "swamp auth token create");
});

Deno.test("renderAuthTokenRevoke: log mode shows confirmation", () => {
  const output = captureLogs(() => renderAuthTokenRevoke(revokeData, "log"));
  assertStringIncludes(output, "tok-1");
  assertStringIncludes(output, "revoked");
  assertStringIncludes(output, "myorg");
});

Deno.test("renderAuthTokenRevoke: json mode outputs structured data", () => {
  const output = captureLogs(() => renderAuthTokenRevoke(revokeData, "json"));
  assertEquals(JSON.parse(output), { id: "tok-1", collective: "myorg" });
});

Deno.test("renderAuthTokenList: no FINGERPRINT column when the server sends none", () => {
  const output = captureLogs(() => renderAuthTokenList(listData, "log"));
  assertEquals(
    output.split("\n")[0].trim().split(/\s{2,}/),
    ["NAME", "ID", "STATUS", "PREFIX", "SCOPES", "CREATED", "LAST USED"],
  );

  const parsed = JSON.parse(
    captureLogs(() => renderAuthTokenList(listData, "json")),
  );
  assertEquals("fingerprint" in parsed[0], false);
});

Deno.test("renderAuthTokenList: FINGERPRINT replaces PREFIX when the server sends one", () => {
  const withFingerprint: AuthTokenListData = {
    ...listData,
    tokens: [
      { ...listData.tokens[0], fingerprint: "7cba95208c56e033" },
      listData.tokens[1],
    ],
  };
  const output = captureLogs(() => renderAuthTokenList(withFingerprint, "log"));
  const [header, first, second] = output.split("\n").map((l) => l.trim());
  assertEquals(header.split(/\s{2,}/), [
    "NAME",
    "ID",
    "STATUS",
    "FINGERPRINT",
    "SCOPES",
    "CREATED",
    "LAST USED",
  ]);
  assertEquals(first.split(/\s{2,}/)[3], "7cba95208c56e033");
  assertEquals(second.split(/\s{2,}/)[3], "-");
  assertEquals(output.includes("swamp_org_"), false);

  const parsed = JSON.parse(
    captureLogs(() => renderAuthTokenList(withFingerprint, "json")),
  );
  assertEquals(parsed[0].fingerprint, "7cba95208c56e033");
  assertEquals(parsed[0].keyPrefix, "swamp_org_ab");
});

const createData: AuthTokenCreateData = {
  key: "swamp_org_abcdef1234567890",
  fingerprint: "00bd270b8576bc29",
  id: "tok-1",
  name: "ci-deploy",
  collective: "myorg",
  scopes: ["extensions:push"],
  expiresAt: null,
  mintedByTokenId: null,
};

Deno.test("renderAuthTokenCreate: log mode shows the fingerprint beside the secret", () => {
  const output = captureLogs(() => renderAuthTokenCreate(createData, "log"));
  assertStringIncludes(output, "Fingerprint: 00bd270b8576bc29");
  assertStringIncludes(output, "swamp_org_abcdef1234567890");
});

Deno.test("renderAuthTokenCreate: json mode includes the fingerprint", () => {
  const parsed = JSON.parse(
    captureLogs(() => renderAuthTokenCreate(createData, "json")),
  );
  assertEquals(parsed.fingerprint, "00bd270b8576bc29");
});

Deno.test("renderAuthTokenCreate: shows the signin token when swamp-club issued one", () => {
  const withToken = { ...createData, signinToken: "cHJvb2Y.c2ln" };
  const log = captureLogs(() => renderAuthTokenCreate(withToken, "log"));
  assertStringIncludes(log, "Signin token:");
  assertStringIncludes(log, "SWAMP_SIGNIN_TOKEN");
  assertStringIncludes(log, "cHJvb2Y.c2ln");
  assertStringIncludes(log, "These are shown once");

  const parsed = JSON.parse(
    captureLogs(() => renderAuthTokenCreate(withToken, "json")),
  );
  assertEquals(parsed.signinToken, "cHJvb2Y.c2ln");
});

Deno.test("renderAuthTokenCreate: omits the signin token section without one", () => {
  const log = captureLogs(() => renderAuthTokenCreate(createData, "log"));
  assertEquals(log.includes("Signin token:"), false);
  assertStringIncludes(log, "This token is shown once");
});

Deno.test("renderAuthTokenCreate: shows the expiry, and the minting token only when there is one", () => {
  const plain = captureLogs(() => renderAuthTokenCreate(createData, "log"));
  assertStringIncludes(plain, "Expires: never");
  assertEquals(plain.includes("Minted by:"), false);

  const minted = {
    ...createData,
    expiresAt: "2026-12-03T00:00:00.000Z",
    mintedByTokenId: "tok-parent",
  };
  const log = captureLogs(() => renderAuthTokenCreate(minted, "log"));
  assertStringIncludes(log, "Expires: 2026-12-03T00:00:00.000Z");
  assertStringIncludes(log, "Minted by: tok-parent");

  const parsed = JSON.parse(
    captureLogs(() => renderAuthTokenCreate(createData, "json")),
  );
  assertEquals([parsed.expiresAt, parsed.mintedByTokenId], [null, null]);
});

Deno.test("renderAuthTokenList: STATUS column, JSON status, and the hidden-inactive note", () => {
  const output = captureLogs(() => renderAuthTokenList(listData, "log"));
  const rows = output.split("\n").map((l) => l.trim().split(/\s{2,}/));
  assertEquals([rows[1][2], rows[2][2]], ["active", "revoked"]);
  assertEquals(output.includes("Older inactive tokens"), false);

  const more = captureLogs(() =>
    renderAuthTokenList({ ...listData, moreInactive: true }, "log")
  );
  assertStringIncludes(more, "Older inactive tokens are not shown.");

  const parsed = JSON.parse(
    captureLogs(() =>
      renderAuthTokenList({ ...listData, moreInactive: true }, "json")
    ),
  );
  assertEquals(Array.isArray(parsed), true);
  assertEquals(parsed[1].status, "revoked");
  assertEquals(parsed[1].mintedByTokenId, "tok-1");
});

Deno.test("renderAuthTokenDelete: log and json output", () => {
  const data = { id: "tok-1", collective: "myorg" };
  const log = captureLogs(() => renderAuthTokenDelete(data, "log"));
  assertStringIncludes(log, "Token tok-1 deleted from collective myorg.");
  assertEquals(
    JSON.parse(captureLogs(() => renderAuthTokenDelete(data, "json"))),
    data,
  );
});

Deno.test("renderAuthTokenList: an empty list still says older inactive tokens are hidden", () => {
  const output = captureLogs(() =>
    renderAuthTokenList(
      { collective: "myorg", tokens: [], moreInactive: true },
      "log",
    )
  );
  assertStringIncludes(output, "No API tokens found");
  assertStringIncludes(output, "Older inactive tokens are not shown.");
});
