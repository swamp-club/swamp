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

import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
} from "@std/assert";
import {
  generateIntegrationCredential,
  INTEGRATION_CREDENTIAL_HASH_PATTERN,
  integrationCredentialHash,
} from "./integration_credential.ts";

Deno.test("generateIntegrationCredential: has its format, and the hash is of what is shown", async () => {
  const { credential, hash } = await generateIntegrationCredential("my-app");
  assertMatch(credential, /^swi1\.my-app\.[0-9a-f]{64}$/);
  assertMatch(hash, INTEGRATION_CREDENTIAL_HASH_PATTERN);
  assertEquals(await integrationCredentialHash(credential), hash);
  assert(!hash.includes(credential.split(".")[2]));
});

Deno.test("generateIntegrationCredential: differs every time", async () => {
  const a = await generateIntegrationCredential("app");
  const b = await generateIntegrationCredential("app");
  assertNotEquals(a.credential, b.credential);
  assertNotEquals(a.hash, b.hash);
});
