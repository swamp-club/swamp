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
  AuthTokenListData,
  AuthTokenRevokeData,
} from "../../libswamp/mod.ts";
import {
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
  name: "ci-deploy",
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
  assertStringIncludes(output, "ci-deploy");
  assertStringIncludes(output, "revoked");
  assertStringIncludes(output, "myorg");
});

Deno.test("renderAuthTokenRevoke: json mode outputs structured data", () => {
  const output = captureLogs(() => renderAuthTokenRevoke(revokeData, "json"));
  const parsed = JSON.parse(output);
  assertEquals(parsed.id, "tok-1");
  assertEquals(parsed.name, "ci-deploy");
  assertEquals(parsed.collective, "myorg");
  assertEquals("key" in parsed, false);
});
