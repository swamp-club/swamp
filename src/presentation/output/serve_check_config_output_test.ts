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
import { assertFalse } from "@std/assert/false";
import { stripAnsiCode } from "@std/fmt/colors";
import {
  renderServeCheckConfig,
  type ServeCheckConfigData,
} from "./serve_check_config_output.ts";

function captureLogs(run: () => void): string {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    run();
  } finally {
    console.log = originalLog;
  }
  return logs.join("\n");
}

const PROVIDER = "https://provider.test";

const partial: ServeCheckConfigData = {
  passed: false,
  authMode: "oauth",
  oauthProvider: PROVIDER,
  entries: [
    {
      kind: "admin",
      entry: "alice",
      username: "alice",
      status: "resolved",
      sub: "sub-alice",
    },
    { kind: "admin", entry: "alic_e", username: "alic_e", status: "not-found" },
    {
      kind: "allowed-user",
      entry: "alice",
      username: "alice",
      status: "resolved",
      sub: "sub-alice",
    },
  ],
  allowedCollectives: [],
  wouldStart: true,
};

Deno.test("renderServeCheckConfig: json mode outputs the data as-is", () => {
  const output = captureLogs(() => renderServeCheckConfig(partial, "json"));
  assertEquals(JSON.parse(output), partial);
});

Deno.test("renderServeCheckConfig: log mode marks unknown names and fails", () => {
  const output = stripAnsiCode(
    captureLogs(() => renderServeCheckConfig(partial, "log")),
  );
  assertStringIncludes(output, "Auth mode: oauth");
  assertStringIncludes(output, `OAuth provider: ${PROVIDER}`);
  assertStringIncludes(output, "✓ alice → sub-alice");
  assertStringIncludes(output, `✗ alic_e → not found on ${PROVIDER}`);
  assertStringIncludes(output, "Allowed users:");
  assertStringIncludes(
    output,
    "Result: FAILED (1 unknown name(s); swamp serve would start without them)",
  );
});

Deno.test("renderServeCheckConfig: log mode shows why serve would refuse to start", () => {
  const output = stripAnsiCode(
    captureLogs(() =>
      renderServeCheckConfig({
        ...partial,
        wouldStart: false,
        refusal: "Failed to resolve admin 'alic_e': none exist",
      }, "log")
    ),
  );
  assertStringIncludes(output, "swamp serve would refuse to start:");
  assertStringIncludes(output, "Failed to resolve admin 'alic_e'");
  assertStringIncludes(
    output,
    "Result: FAILED (swamp serve would refuse to start)",
  );
});

Deno.test("renderServeCheckConfig: log mode passes when every name resolves", () => {
  const output = stripAnsiCode(
    captureLogs(() =>
      renderServeCheckConfig({
        ...partial,
        passed: true,
        entries: [partial.entries[0]],
        allowedCollectives: ["eng"],
      }, "log")
    ),
  );
  assertStringIncludes(output, "Allowed collectives: eng");
  assertFalse(output.includes("Allowed users:"));
  assertStringIncludes(output, "Result: PASSED");
});

Deno.test("renderServeCheckConfig: log mode outside oauth has nothing to resolve", () => {
  const output = stripAnsiCode(
    captureLogs(() =>
      renderServeCheckConfig({
        passed: true,
        authMode: "token",
        entries: [],
        allowedCollectives: [],
        wouldStart: true,
      }, "log")
    ),
  );
  assertStringIncludes(output, "Auth mode: token");
  assertStringIncludes(output, "No usernames to resolve in this mode.");
  assertStringIncludes(output, "Result: PASSED");
  assertFalse(output.includes("Token secrets key:"));
});

const tokenMode: ServeCheckConfigData = {
  passed: true,
  authMode: "token",
  entries: [],
  allowedCollectives: [],
  wouldStart: true,
};

Deno.test("renderServeCheckConfig: log mode reports a usable token secrets key", () => {
  const output = stripAnsiCode(
    captureLogs(() =>
      renderServeCheckConfig({
        ...tokenMode,
        tokenSecretsKey: { vault: "prod-secrets", key: "k", status: "ok" },
      }, "log")
    ),
  );
  assertStringIncludes(output, "Token secrets key: vault prod-secrets, key k");
  assertStringIncludes(output, "✓ resolves to a usable 32-byte key");
  assertStringIncludes(output, "Result: PASSED");
});

Deno.test("renderServeCheckConfig: log mode fails when the token secrets key is unusable", () => {
  const output = stripAnsiCode(
    captureLogs(() =>
      renderServeCheckConfig({
        ...tokenMode,
        passed: false,
        wouldStart: false,
        tokenSecretsKey: {
          vault: "prod-secrets",
          key: "k",
          status: "failed",
          error: "Could not read the token secrets key",
        },
      }, "log")
    ),
  );
  assertStringIncludes(output, "✗ Could not read the token secrets key");
  assertStringIncludes(
    output,
    "Result: FAILED (swamp serve would refuse to start)",
  );
});

Deno.test("renderServeCheckConfig: json mode includes the token secrets key check", () => {
  const data: ServeCheckConfigData = {
    ...tokenMode,
    tokenSecretsKey: { vault: "prod-secrets", key: "k", status: "ok" },
  };
  const output = captureLogs(() => renderServeCheckConfig(data, "json"));
  assertEquals(JSON.parse(output), data);
});
