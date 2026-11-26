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
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { FileSystemControlPlaneStore } from "../src/infrastructure/persistence/fs_control_plane_store.ts";
import { swampPath } from "../src/infrastructure/persistence/paths.ts";
import { FEDERATION_GATE_VARIABLE } from "../src/domain/serve/federation_gate.ts";
import { registerFederationModelTypes } from "../src/domain/serve/federation_model_types.ts";
import { sampleFingerprintProps } from "../src/domain/serve/federation_test_helpers.ts";
import { Fingerprint } from "../src/domain/serve/fingerprint.ts";
import { FederationHub } from "../src/serve/federation/federation_hub.ts";
import {
  repoMemberMethodRunner,
  repoMemberRecords,
} from "../src/serve/federation/member_record_store.ts";
import {
  createServeCtx,
  errorFrame,
  type Frame,
  grant,
  sendRequest,
  type ServeRepo,
  withServeRepo,
} from "./serve_request_harness.ts";
import "../src/domain/models/models.ts";

await initializeLogging({});

const GATE_ON = (name: string) =>
  name === FEDERATION_GATE_VARIABLE ? "1" : undefined;

const FEDERATION_TYPES = [
  "federation.member.list",
  "federation.member.get",
  "federation.member.remove",
  "federation.token.create",
  "federation.token.list",
  "federation.token.revoke",
] as const;

function hubOver(repo: ServeRepo): FederationHub {
  return new FederationHub({
    store: new FileSystemControlPlaneStore(swampPath(repo.repoDir)),
    hubName: "central",
    members: repoMemberRecords(repo.repoContext),
    runMemberMethod: repoMemberMethodRunner({
      repoDir: repo.repoDir,
      repoContext: repo.repoContext,
    }),
  });
}

function reply(frames: Frame[], type: string): Record<string, unknown> {
  const frame = frames.find((f) => f.type === type);
  assert(frame, `no ${type} reply in ${JSON.stringify(frames)}`);
  return frame.payload as Record<string, unknown>;
}

const ADMIN = grant({
  actions: ["read", "admin"],
  resource: { kind: "access", pattern: "swamp/federation" },
});
const READER = grant({
  actions: ["read"],
  resource: { kind: "access", pattern: "swamp/federation" },
});

function payloadFor(type: string): Record<string, unknown> {
  return type.endsWith(".list") ? {} : { name: "edge-1" };
}

Deno.test({
  name:
    "federation requests: each type works end to end on a hub, from minting a token to removing the member",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    assert(await registerFederationModelTypes(GATE_ON));
    await withServeRepo(async (repo) => {
      const hub = hubOver(repo);
      const ctx = createServeCtx(repo, [ADMIN], { federationHub: hub });
      const send = (type: string, payload: Record<string, unknown>) =>
        sendRequest(ctx, { type, id: crypto.randomUUID(), payload });

      const created = reply(
        await send("federation.token.create", { name: "edge-1" }),
        "federation.token.create",
      );
      assert(String(created.joinToken).startsWith("edge-1."));
      assertEquals(
        (created.token as Record<string, unknown>).state,
        "unused",
      );
      assertEquals("secretHash" in (created.token as object), false);

      const tokens = reply(
        await send("federation.token.list", {}),
        "federation.token.list",
      ).tokens as Array<Record<string, unknown>>;
      assertEquals(tokens.map((t) => t.memberName), ["edge-1"]);

      const spare = reply(
        await send("federation.token.create", { name: "edge-2" }),
        "federation.token.create",
      );
      assert(spare.joinToken);
      const revoked = reply(
        await send("federation.token.revoke", { name: "edge-2" }),
        "federation.token.revoke",
      );
      assertEquals(
        (revoked.token as Record<string, unknown>).state,
        "revoked",
      );

      const joined = await hub.join(
        created.joinToken,
        Fingerprint.create(sampleFingerprintProps()),
      );
      assertEquals(joined.kind, "joined");

      const members = reply(
        await send("federation.member.list", {}),
        "federation.member.list",
      ).members as Array<Record<string, unknown>>;
      assertEquals(members.map((m) => m.name), ["edge-1"]);

      const got = reply(
        await send("federation.member.get", { name: "edge-1" }),
        "federation.member.get",
      ).member as Record<string, unknown>;
      assertEquals(got.status, "online");

      const missing = errorFrame(
        await send("federation.member.get", { name: "nobody" }),
      );
      assertEquals(
        (missing?.error as Record<string, unknown>).code,
        "not_found",
      );

      const removed = reply(
        await send("federation.member.remove", { name: "edge-1" }),
        "federation.member.remove",
      ).member as Record<string, unknown>;
      assertEquals(removed.status, "removed");
      await hub.settled();
    });
  },
});

Deno.test({
  name:
    "federation requests: a reader lists and gets members but every token request and remove needs admin on swamp/federation",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServeRepo(async (repo) => {
      const hub = hubOver(repo);
      const reader = createServeCtx(repo, [READER], { federationHub: hub });
      const nobody = createServeCtx(repo, [grant({})], { federationHub: hub });
      for (const type of FEDERATION_TYPES) {
        const needsAdmin = !type.startsWith("federation.member.l") &&
          type !== "federation.member.get";
        const asReader = errorFrame(
          await sendRequest(reader, {
            type,
            id: crypto.randomUUID(),
            payload: payloadFor(type),
          }),
        );
        const code = (asReader?.error as Record<string, unknown> | undefined)
          ?.code;
        if (needsAdmin) {
          assertEquals(code, "unauthorized", type);
        } else {
          assert(code !== "unauthorized", `${type} refused a reader`);
        }
        const asNobody = errorFrame(
          await sendRequest(nobody, {
            type,
            id: crypto.randomUUID(),
            payload: payloadFor(type),
          }),
        );
        assertEquals(
          (asNobody?.error as Record<string, unknown> | undefined)?.code,
          "unauthorized",
          type,
        );
      }
      assertEquals(await hub.listTokens(), []);
    });
  },
});
