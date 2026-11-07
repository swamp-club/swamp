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

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { Definition } from "../../definitions/definition.ts";
import { integrationCredentialHash } from "../../access/integration_credential.ts";
import type { MethodContext } from "../model.ts";
import {
  type Integration,
  INTEGRATION_ID_MAX_LENGTH,
  integrationDefinitionId,
  integrationDefinitionName,
  integrationModel,
} from "./integration_model.ts";

const HASH = `sha256:${"a".repeat(64)}`;

const CEILING = {
  version: 1,
  ceiling: [{ actions: ["run"], resource: "workflow:deploy" }],
};

function harness(id = "app") {
  let stored: unknown = null;
  const writes: unknown[] = [];
  const context = {
    definition: { name: integrationDefinitionName(id) },
    readResource: () => Promise.resolve(stored),
    writeResource: (_spec: string, _name: string, value: unknown) => {
      stored = value;
      writes.push(value);
      return Promise.resolve({ name: "integration-main" });
    },
  } as unknown as MethodContext;
  const call = (method: string, args: unknown) =>
    integrationModel.methods[method].execute(args as never, context);
  return { call, writes, record: () => stored as Integration };
}

const registerArgs = {
  id: "app",
  name: "App",
  ceiling: CEILING,
  credentialHash: HASH,
};

Deno.test("register: stores a canonical ceiling and only the credential's hash", async () => {
  const { call, record } = harness();
  await call("register", {
    ...registerArgs,
    ceiling: {
      version: 1,
      ceiling: [{ actions: ["run", "run"], resource: "workflow:deploy" }],
    },
  });
  assertEquals(record().state, "active");
  assertEquals(record().credentialHash, HASH);
  assertEquals(record().ceiling, CEILING);
  assertEquals(record().ceilingDigest.startsWith("sha256:"), true);
});

Deno.test("register: an id already used is refused, active or revoked, so it stays reserved", async () => {
  const { call } = harness();
  await call("register", registerArgs);
  await assertRejects(
    () => call("register", registerArgs),
    Error,
    "already exists",
  );
  await call("revoke", {});
  await assertRejects(
    () => call("register", registerArgs),
    Error,
    "can't be used again",
  );
});

Deno.test("register: refuses a ceiling naming write, tag, admin or another kind", async () => {
  for (
    const entry of [
      { actions: ["write"], resource: "workflow:*" },
      { actions: ["tag"], resource: "workflow:*" },
      { actions: ["admin"], resource: "workflow:*" },
      { actions: ["run"], resource: "model:*" },
      { actions: ["run"], resource: "behavior:*" },
    ]
  ) {
    const { call, writes } = harness();
    await assertRejects(() =>
      call("register", {
        ...registerArgs,
        ceiling: { version: 1, ceiling: [entry] },
      })
    );
    assertEquals(writes, []);
  }
});

Deno.test("register: must run on the behavior named for its id", async () => {
  const { call } = harness("other");
  await assertRejects(
    () => call("register", registerArgs),
    Error,
    "behavior named",
  );
});

Deno.test("setCeiling: replaces it and records the previous digest", async () => {
  const { call, record } = harness();
  await call("register", registerArgs);
  const before = record().ceilingDigest;
  await call("setCeiling", { ceiling: { version: 1, ceiling: [] } });
  assertEquals(record().ceiling, { version: 1, ceiling: [] });
  assertEquals(record().previousCeilingDigest, before);
});

Deno.test("setCeiling: refuses write and a revoked integration", async () => {
  const { call } = harness();
  await call("register", registerArgs);
  await assertRejects(() =>
    call("setCeiling", {
      ceiling: {
        version: 1,
        ceiling: [{ actions: ["write"], resource: "workflow:*" }],
      },
    })
  );
  await call("revoke", {});
  await assertRejects(
    () => call("setCeiling", { ceiling: CEILING }),
    Error,
    "revoked",
  );
});

Deno.test("revoke: is final and idempotent", async () => {
  const { call, record, writes } = harness();
  await call("register", registerArgs);
  await call("revoke", {});
  assertEquals(record().state, "revoked");
  const count = writes.length;
  await call("revoke", {});
  assertEquals(writes.length, count);
});

Deno.test("integrationCredentialHash: is sha256 of the credential", async () => {
  assertEquals(
    await integrationCredentialHash("abc"),
    "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

Deno.test("INTEGRATION_ID_MAX_LENGTH: the longest id's behavior name is valid, and one more isn't", () => {
  const longest = "a".repeat(INTEGRATION_ID_MAX_LENGTH);
  Definition.create({ name: integrationDefinitionName(longest) });
  assertThrows(() =>
    Definition.create({ name: integrationDefinitionName(`${longest}a`) })
  );
});

Deno.test("integration register: refuses an id too long for its behavior name", () => {
  const args = {
    name: "A",
    ceiling: { version: 1, ceiling: [] },
    credentialHash: HASH,
  };
  const method = integrationModel.methods.register;
  assertEquals(
    method.arguments.safeParse({
      ...args,
      id: "a".repeat(INTEGRATION_ID_MAX_LENGTH),
    }).success,
    true,
  );
  assertEquals(
    method.arguments.safeParse({
      ...args,
      id: "a".repeat(INTEGRATION_ID_MAX_LENGTH + 1),
    }).success,
    false,
  );
});

Deno.test("integrationDefinitionId: one valid id per name, the same every time", async () => {
  const first = await integrationDefinitionId("integration-app");
  assertEquals(await integrationDefinitionId("integration-app"), first);
  assertEquals(
    Definition.create({ id: first, name: "integration-app" }).id,
    first,
  );
  assertEquals(
    first === await integrationDefinitionId("integration-other"),
    false,
  );
});
