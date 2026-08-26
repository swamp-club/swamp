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
  ServerTokenCreateData,
  ServerTokenRevealData,
  ServerTokenRotateData,
} from "../../libswamp/mod.ts";
import {
  renderServerTokenCreate,
  renderServerTokenReveal,
  renderServerTokenRotate,
} from "./access_token_output.ts";

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

const createData: ServerTokenCreateData = {
  name: "swamp-ui",
  principalId: "user:sntxrr",
  expiresAt: "2027-08-07T00:00:00Z",
  vaultRef: { vaultName: "serve-local", secretKey: "server-token-swamp-ui" },
};

const rotateData: ServerTokenRotateData = {
  name: "swamp-ui",
  principalId: "user:sntxrr",
  expiresAt: "2027-08-07T00:00:00Z",
  vaultRef: { vaultName: "serve-local", secretKey: "server-token-swamp-ui" },
};

const revealData: ServerTokenRevealData = {
  name: "swamp-ui",
  token: "swamp-ui.abc123secret",
  expired: false,
  vaultRef: { vaultName: "serve-local", secretKey: "server-token-swamp-ui" },
};

Deno.test("renderServerTokenCreate: hint uses access token reveal", () => {
  const output = captureLogs(() => renderServerTokenCreate(createData, "log"));
  assertStringIncludes(output, "swamp access token reveal swamp-ui --yes");
});

Deno.test("renderServerTokenRotate: hint uses access token reveal", () => {
  const output = captureLogs(() => renderServerTokenRotate(rotateData, "log"));
  assertStringIncludes(output, "swamp access token reveal swamp-ui --yes");
});

Deno.test("renderServerTokenReveal: log mode shows token credential", () => {
  const output = captureLogs(() => renderServerTokenReveal(revealData, "log"));
  assertStringIncludes(output, "swamp-ui.abc123secret");
  assertStringIncludes(output, "Store this token securely");
});

Deno.test("renderServerTokenReveal: json mode outputs name and token", () => {
  const output = captureLogs(() => renderServerTokenReveal(revealData, "json"));
  const parsed = JSON.parse(output);
  assertEquals(parsed.name, "swamp-ui");
  assertEquals(parsed.token, "swamp-ui.abc123secret");
});

Deno.test("renderServerTokenReveal: json mode excludes vault ref", () => {
  const output = captureLogs(() => renderServerTokenReveal(revealData, "json"));
  const parsed = JSON.parse(output);
  assertEquals(parsed.vaultRef, undefined);
});

Deno.test("renderServerTokenReveal: log mode shows expiry warning when expired", () => {
  const expiredData: ServerTokenRevealData = {
    ...revealData,
    expired: true,
  };
  const output = captureLogs(() => renderServerTokenReveal(expiredData, "log"));
  assertStringIncludes(output, "this token has expired");
});
