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

import { assert, assertEquals } from "@std/assert";
import {
  serverRequestPayloadFields,
  serverRequestSchemas,
  validateServerRequest,
} from "./connection.ts";

const FEDERATION_TYPES = [
  "federation.member.list",
  "federation.member.get",
  "federation.member.remove",
  "federation.token.create",
  "federation.token.list",
  "federation.token.revoke",
];

function sample(type: string): Record<string, unknown> {
  return {
    type,
    id: "request-1",
    payload: type.endsWith(".list") ? {} : { name: "edge-1" },
  };
}

Deno.test("serverRequestPayloadFields: a hub adds the federation request types and nothing else", () => {
  const withoutHub = [...serverRequestPayloadFields().keys()];
  assertEquals(
    [...serverRequestPayloadFields({ federationHub: true }).keys()].sort(),
    [...withoutHub, ...FEDERATION_TYPES].sort(),
  );
  assertEquals(
    serverRequestSchemas({ federationHub: true }).length,
    withoutHub.length + FEDERATION_TYPES.length,
  );
  assertEquals(
    [...serverRequestPayloadFields({ federationHub: false }).keys()],
    withoutHub,
  );
});

Deno.test("validateServerRequest: without a hub, each federation type is refused with the same message as a made-up type", () => {
  const madeUp = validateServerRequest(sample("federation.made.up"));
  assertEquals(typeof madeUp, "string");
  for (const type of FEDERATION_TYPES) {
    assertEquals(validateServerRequest(sample(type)), madeUp, type);
    assertEquals(
      validateServerRequest(sample(type), { federationHub: false }),
      madeUp,
      type,
    );
  }
});

Deno.test("validateServerRequest: a hub accepts each federation type and still refuses a made-up one", () => {
  for (const type of FEDERATION_TYPES) {
    const validated = validateServerRequest(sample(type), {
      federationHub: true,
    });
    assert(typeof validated !== "string", `${type}: ${validated}`);
    assertEquals(validated.type, type);
  }
  assertEquals(
    typeof validateServerRequest(sample("federation.made.up"), {
      federationHub: true,
    }),
    "string",
  );
});

Deno.test("validateServerRequest: a hub bounds the federation payloads", () => {
  const scope = { federationHub: true };
  for (
    const payload of [
      {},
      { name: "" },
      { name: "x".repeat(65) },
      { name: "edge-1", durationMs: 1.5 },
      { name: "edge-1", durationMs: -1 },
    ]
  ) {
    assertEquals(
      typeof validateServerRequest(
        { type: "federation.token.create", id: "r", payload },
        scope,
      ),
      "string",
      JSON.stringify(payload),
    );
  }
});

Deno.test("serverRequestPayloadFields: a member adds federation.link.get and nothing else", () => {
  const withoutMember = [...serverRequestPayloadFields().keys()];
  assertEquals(
    [...serverRequestPayloadFields({ federationMember: true }).keys()].sort(),
    [...withoutMember, "federation.link.get"].sort(),
  );
});

Deno.test("validateServerRequest: federation.link.get is accepted only on a member, and a member refuses the hub's types", () => {
  const madeUp = validateServerRequest(sample("federation.made.up"));
  const linkGet = { type: "federation.link.get", id: "request-1", payload: {} };
  assertEquals(validateServerRequest(linkGet), madeUp);
  assertEquals(
    validateServerRequest(linkGet, { federationHub: true }),
    validateServerRequest(sample("federation.made.up"), {
      federationHub: true,
    }),
  );
  const validated = validateServerRequest(linkGet, { federationMember: true });
  assert(typeof validated !== "string", String(validated));
  for (const type of FEDERATION_TYPES) {
    assertEquals(
      typeof validateServerRequest(sample(type), { federationMember: true }),
      "string",
      type,
    );
  }
});
