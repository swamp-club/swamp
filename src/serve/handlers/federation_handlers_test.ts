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
import { GrantBasedAccessDecisionService } from "../../domain/access/grant_based_access_decision_service.ts";
import { PolicySnapshot } from "../../domain/access/policy_snapshot.ts";
import { createConditionEvaluator } from "../../domain/access/policy_snapshot_loader.ts";
import type { Principal } from "../../domain/access/principal.ts";
import type { Grant } from "../../domain/models/access/grant_model.ts";
import {
  createTestHub,
  MemoryControlPlaneStore,
} from "../federation/federation_hub_test_helpers.ts";
import { HubLink } from "../../domain/serve/hub_link.ts";
import { InstanceId } from "../../domain/serve/instance_id.ts";
import { MemberCredential } from "../../domain/serve/member_credential.ts";
import { sampleFingerprint } from "../../domain/serve/federation_test_helpers.ts";
import { HubLinkStore } from "../federation/hub_link_store.ts";
import type { ConnectionContext } from "./shared.ts";
import {
  FEDERATION_RESOURCE,
  handleFederationLinkGet,
  handleFederationMemberGet,
  handleFederationMemberList,
  handleFederationTokenCreate,
  handleFederationTokenList,
} from "./federation_handlers.ts";

const OPERATOR: Principal = { kind: "user", id: "operator" };

function socket(): WebSocket & { sent: string[] } {
  const sent: string[] = [];
  return {
    readyState: WebSocket.OPEN,
    send(data: string) {
      sent.push(data);
    },
    sent,
  } as unknown as WebSocket & { sent: string[] };
}

function grantOn(pattern: string, actions: Grant["actions"]): Grant {
  return {
    id: crypto.randomUUID(),
    subject: { kind: "user", name: "operator" },
    effect: "allow",
    actions,
    resource: { kind: "access", pattern },
    state: "active",
    source: "method",
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function context(
  grants: Grant[],
  federationHub?: ConnectionContext["federationHub"],
): ConnectionContext {
  return {
    repoContext: {},
    authConfig: { mode: "token" },
    policySnapshotLoader: {
      decisionService: new GrantBasedAccessDecisionService(
        new PolicySnapshot(grants, [], createConditionEvaluator()),
      ),
    },
    ...(federationHub ? { federationHub } : {}),
  } as unknown as ConnectionContext;
}

async function memberLink(): Promise<
  NonNullable<ConnectionContext["federationMember"]>
> {
  const links = new HubLinkStore(new MemoryControlPlaneStore());
  await links.writeLink(
    HubLink.unjoined().beginJoin("https://hub.example.com", crypto.randomUUID())
      .received({
        memberId: crypto.randomUUID(),
        memberName: "edge",
        hubName: "central",
        joinedAt: "2026-11-26T12:00:00.000Z",
      }).joined(),
  );
  return { links, configuredHubUrl: "https://hub.example.com" };
}

function frame(ws: { sent: string[] }): Record<string, unknown> {
  return JSON.parse(ws.sent[0]);
}

Deno.test("FEDERATION_RESOURCE: one access resource names the roster", () => {
  assertEquals(FEDERATION_RESOURCE, {
    kind: "access",
    name: "swamp/federation",
    fields: {},
  });
});

Deno.test("handleFederationTokenCreate: a grant naming swamp/federation with admin mints; read alone is refused before the hub is touched", async () => {
  const { hub } = createTestHub();
  const admin = socket();
  await handleFederationTokenCreate(
    admin,
    context([grantOn("swamp/federation", ["admin"])], hub),
    "r1",
    { name: "edge-1" },
    OPERATOR,
  );
  assertEquals(frame(admin).type, "federation.token.create");

  const reader = socket();
  await handleFederationTokenCreate(
    reader,
    context([grantOn("swamp/federation", ["read"])], hub),
    "r2",
    { name: "edge-2" },
    OPERATOR,
  );
  assertEquals(frame(reader).type, "error");
  assertEquals((await hub.listTokens()).map((t) => t.memberName), ["edge-1"]);
});

Deno.test("handleFederationMemberList: a reader lists; a grant on another access resource does not reach it", async () => {
  const { hub } = createTestHub();
  const reader = socket();
  await handleFederationMemberList(
    reader,
    context([grantOn("swamp/federation", ["read"])], hub),
    "r1",
    OPERATOR,
  );
  assertEquals(frame(reader), {
    type: "federation.member.list",
    id: "r1",
    payload: { members: [] },
  });

  const other = socket();
  await handleFederationMemberList(
    other,
    context([grantOn("swamp/app-approval", ["read", "admin"])], hub),
    "r2",
    OPERATOR,
  );
  assertEquals(frame(other).type, "error");
});

Deno.test("handleFederationTokenList: without a hub on the ctx it answers unsupported_operation", async () => {
  const ws = socket();
  await handleFederationTokenList(
    ws,
    context([grantOn("swamp/federation", ["admin"])]),
    "r1",
    OPERATOR,
  );
  assertEquals(
    (frame(ws).error as Record<string, unknown>).code,
    "unsupported_operation",
  );
});

Deno.test("handleFederationLinkGet: read on swamp/federation returns the link and never a credential", async () => {
  const ws = socket();
  const ctx = {
    ...context([grantOn(FEDERATION_RESOURCE.name, ["read"])]),
    federationMember: await memberLink(),
  } as ConnectionContext;
  await handleFederationLinkGet(ws, ctx, "r1", OPERATOR);
  const reply = frame(ws);
  assertEquals(reply.type, "federation.link.get");
  const link = (reply.payload as { link: Record<string, unknown> }).link;
  assertEquals(link.state, "joined");
  assertEquals(link.hubName, "central");
  assertEquals(ws.sent[0].includes("swfm1."), false);
});

Deno.test("handleFederationLinkGet: refused without read on swamp/federation", async () => {
  const ws = socket();
  const ctx = {
    ...context([grantOn("swamp/other", ["read"])]),
    federationMember: await memberLink(),
  } as ConnectionContext;
  await handleFederationLinkGet(ws, ctx, "r1", OPERATOR);
  assertEquals(frame(ws).type, "error");
});

Deno.test("handleFederationLinkGet: a serve that is not a member says so", async () => {
  const ws = socket();
  await handleFederationLinkGet(
    ws,
    context([grantOn(FEDERATION_RESOURCE.name, ["read"])]),
    "r1",
    OPERATOR,
  );
  const reply = frame(ws) as { type: string; error: { code: string } };
  assertEquals(reply.type, "error");
  assertEquals(reply.error.code, "unsupported_operation");
});

Deno.test("handleFederationMemberGet: a reader gets the record with its live view; without read on swamp/federation it is refused", async () => {
  const t = createTestHub();
  const { plaintext } = await t.hub.createToken("edge-1");
  const joined = await t.hub.join(
    plaintext,
    crypto.randomUUID(),
    sampleFingerprint(),
  );
  if (joined.kind !== "joined") throw new Error(joined.kind);
  const instance = InstanceId.create(crypto.randomUUID());
  const runtime = {
    team: { role: "single" as const, nodes: 1 },
    startedAt: "2026-11-26T11:00:00.000Z",
    ready: true,
  };
  await t.hub.checkIn(
    MemberCredential.parse(joined.credential),
    instance,
    sampleFingerprint(runtime),
  );

  const reader = socket();
  await handleFederationMemberGet(
    reader,
    context([grantOn("swamp/federation", ["read"])], t.hub),
    "r1",
    { name: "edge-1" },
    OPERATOR,
  );
  const reply = frame(reader) as {
    type: string;
    payload: { member: { name: string; live: unknown } };
  };
  assertEquals(reply.type, "federation.member.get");
  assertEquals(reply.payload.member.name, "edge-1");
  const seenAt = new Date(t.clock.now).toISOString();
  assertEquals(reply.payload.member.live, {
    lastSeenAt: seenAt,
    instances: [{ instanceId: instance.value, lastSeenAt: seenAt, runtime }],
  });

  for (const grants of [[], [grantOn("swamp/app-approval", ["read"])]]) {
    const stranger = socket();
    await handleFederationMemberGet(
      stranger,
      context(grants, t.hub),
      "r2",
      { name: "edge-1" },
      OPERATOR,
    );
    assertEquals(frame(stranger).type, "error");
    assertEquals(
      JSON.stringify(frame(stranger)).includes(instance.value),
      false,
    );
  }
});
