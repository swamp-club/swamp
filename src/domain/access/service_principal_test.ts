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

import { assertEquals, assertThrows } from "@std/assert";
import { parsePrincipal, principalToString } from "./principal.ts";
import {
  assertAuthenticatablePrincipal,
  isServicePrincipal,
  parseCredentialPrincipal,
  SCHEDULER_PRINCIPAL,
  WEBHOOK_PRINCIPAL,
} from "./service_principal.ts";

Deno.test("SCHEDULER_PRINCIPAL: renders as service:scheduler", () => {
  assertEquals(principalToString(SCHEDULER_PRINCIPAL), "service:scheduler");
});

Deno.test("WEBHOOK_PRINCIPAL: renders as service:webhook", () => {
  assertEquals(principalToString(WEBHOOK_PRINCIPAL), "service:webhook");
});

Deno.test("isServicePrincipal: true only for the service kind", () => {
  assertEquals(isServicePrincipal(parsePrincipal("service:scheduler")), true);
  assertEquals(isServicePrincipal(parsePrincipal("user:scheduler")), false);
  assertEquals(isServicePrincipal(parsePrincipal("worker:scheduler")), false);
});

Deno.test("assertAuthenticatablePrincipal: rejects service principals", () => {
  assertThrows(
    () => assertAuthenticatablePrincipal(WEBHOOK_PRINCIPAL),
    Error,
    "built-in service principal",
  );
});

Deno.test("assertAuthenticatablePrincipal: accepts user and worker", () => {
  assertAuthenticatablePrincipal(parsePrincipal("user:adam"));
  assertAuthenticatablePrincipal(parsePrincipal("worker:build-1"));
});

Deno.test("parseCredentialPrincipal: refuses service principals by name", () => {
  assertThrows(
    () => parseCredentialPrincipal("service:scheduler"),
    Error,
    "built-in service principal",
  );
  assertThrows(
    () => parseCredentialPrincipal("service:typo"),
    Error,
    "built-in service principal",
  );
});

Deno.test("parseCredentialPrincipal: parse errors name only user and worker", () => {
  assertThrows(
    () => parseCredentialPrincipal("adam"),
    Error,
    'expected "user:<id>" or "worker:<id>"',
  );
  assertEquals(parseCredentialPrincipal("worker:build-1"), {
    kind: "worker",
    id: "build-1",
  });
});
