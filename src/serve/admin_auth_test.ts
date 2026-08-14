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

import { assertEquals } from "@std/assert";
import { type AdminAuthDeps, authenticateAdmin } from "./admin_auth.ts";

function makeDeps(overrides: Partial<AdminAuthDeps> = {}): AdminAuthDeps {
  return {
    authMode: "token",
    repoDir: "/tmp/test",
    // deno-lint-ignore no-explicit-any
    repoContext: {} as any,
    policySnapshotLoader: null,
    trustProxy: false,
    ...overrides,
  };
}

Deno.test("authenticateAdmin: no-auth mode returns anonymous principal", async () => {
  const deps = makeDeps({ authMode: "none" });
  const req = new Request("http://localhost/api/v1/health");
  const result = await authenticateAdmin(req, "127.0.0.1", deps);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.authResult.principalId, "@anonymous");
  }
});

Deno.test("authenticateAdmin: returns 401 with missing bearer prefix", async () => {
  const deps = makeDeps();
  const req = new Request("http://localhost/api/v1/health", {
    headers: { authorization: "Token test.token" },
  });
  const result = await authenticateAdmin(req, "127.0.0.1", deps);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.response.status, 401);
  }
});

Deno.test("authenticateAdmin: returns 401 without bearer token", async () => {
  const deps = makeDeps();
  const req = new Request("http://localhost/api/v1/health");
  const result = await authenticateAdmin(req, "127.0.0.1", deps);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.response.status, 401);
  }
});

Deno.test("authenticateAdmin: returns 401 with invalid token", async () => {
  const deps = makeDeps();
  const req = new Request("http://localhost/api/v1/health", {
    headers: { authorization: "Bearer not-a-valid-token" },
  });
  const result = await authenticateAdmin(req, "127.0.0.1", deps);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.response.status, 401);
  }
});

Deno.test("authenticateAdmin: trustProxy passes x-forwarded-for through auth flow", async () => {
  const deps = makeDeps({ trustProxy: true });
  const req = new Request("http://localhost/api/v1/health", {
    headers: {
      authorization: "Bearer not-a-valid-token",
      "x-forwarded-for": "10.0.0.1, 192.168.1.1",
    },
  });
  const result = await authenticateAdmin(req, "127.0.0.1", deps);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.response.status, 401);
  }
});
