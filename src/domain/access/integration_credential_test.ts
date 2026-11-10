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
  integrationIdOfCredential,
  verifyIntegrationCredential,
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

function sourceOf(
  records: Record<
    string,
    { credentialHash: string; requireEmailMatch: boolean }
  >,
) {
  return { credentialOf: (id: string) => records[id] };
}

Deno.test("verifyIntegrationCredential: accepts the registered credential and names its integration", async () => {
  const { credential, hash } = await generateIntegrationCredential("slack-bot");
  const result = await verifyIntegrationCredential(
    credential,
    sourceOf({
      "slack-bot": { credentialHash: hash, requireEmailMatch: true },
    }),
  );
  assertEquals(result, {
    ok: true,
    integrationId: "slack-bot",
    requireEmailMatch: true,
  });
});

Deno.test("verifyIntegrationCredential: refuses another credential, an unknown integration and malformed input alike", async () => {
  const registered = await generateIntegrationCredential("slack-bot");
  const other = await generateIntegrationCredential("slack-bot");
  const source = sourceOf({
    "slack-bot": { credentialHash: registered.hash, requireEmailMatch: false },
  });
  const unknown = await generateIntegrationCredential("nobody");
  for (
    const presented of [
      other.credential,
      unknown.credential,
      registered.credential.replace("swi1.", "swi2."),
      `${registered.credential}.extra`,
      registered.credential.slice(0, -1),
      registered.credential.toUpperCase(),
      "",
    ]
  ) {
    assertEquals(
      await verifyIntegrationCredential(presented, source),
      { ok: false },
      presented,
    );
  }
});

Deno.test("integrationIdOfCredential: names the claimed id of a well-formed credential only", async () => {
  const { credential } = await generateIntegrationCredential("slackwater");
  assertEquals(integrationIdOfCredential(credential), "slackwater");
  const hex = "a".repeat(64);
  assertEquals(integrationIdOfCredential(`swi1.other.${hex}`), "other");
  for (
    const malformed of [
      "",
      "swi1",
      `swi1.slackwater`,
      `swi1.slackwater.${hex}.extra`,
      `swi1.Slackwater.${hex}`,
      `swi1.slackwater.${"A".repeat(64)}`,
      `swi1.slackwater.short`,
      `swda1.slackwater.${hex}`,
    ]
  ) {
    assertEquals(integrationIdOfCredential(malformed), undefined, malformed);
  }
});
