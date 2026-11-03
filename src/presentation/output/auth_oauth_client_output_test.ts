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
import type { AuthOAuthClientRegisterData } from "../../libswamp/auth/oauth_client_register.ts";
import { renderAuthOAuthClientRegister } from "./auth_oauth_client_output.ts";

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

const data: AuthOAuthClientRegisterData = {
  clientId: "client-id",
  clientName: "prod-api-server",
  clientSecret: "client-secret",
  provider: "https://swamp-club.com",
};

Deno.test("renderAuthOAuthClientRegister: json mode outputs the id, name, secret and provider", () => {
  const output = captureLogs(() => renderAuthOAuthClientRegister(data, "json"));
  assertEquals(JSON.parse(output), data);
});

Deno.test("renderAuthOAuthClientRegister: log mode shows the id and secret once with how to use them", () => {
  const output = captureLogs(() => renderAuthOAuthClientRegister(data, "log"));
  assertStringIncludes(output, "Client id: client-id");
  assertStringIncludes(output, "client-secret");
  assertStringIncludes(output, "--oauth-client-secret-file");
  assertStringIncludes(output, "shown once");
  assertEquals(output.includes("--oauth-provider"), false);
});

Deno.test("renderAuthOAuthClientRegister: log mode says to pass a non-default provider to serve", () => {
  const output = captureLogs(() =>
    renderAuthOAuthClientRegister(
      { ...data, provider: "https://club.corp.example" },
      "log",
    )
  );
  assertStringIncludes(output, "--oauth-provider https://club.corp.example");
});
