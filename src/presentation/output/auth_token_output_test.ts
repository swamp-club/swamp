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
import type {
  AuthTokenCreateData,
  AuthTokenListData,
  AuthTokenRevokeData,
} from "../../libswamp/mod.ts";
import {
  renderAuthTokenCreate,
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
    },
  ],
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
  const emptyData: AuthTokenListData = { collective: "myorg", tokens: [] };
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
    ["NAME", "ID", "PREFIX", "SCOPES", "CREATED", "LAST USED"],
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
    "FINGERPRINT",
    "SCOPES",
    "CREATED",
    "LAST USED",
  ]);
  assertEquals(first.split(/\s{2,}/)[2], "7cba95208c56e033");
  assertEquals(second.split(/\s{2,}/)[2], "-");
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
