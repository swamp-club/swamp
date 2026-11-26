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
import { createTestHub } from "../federation/federation_hub_test_helpers.ts";
import type { ConnectionContext } from "./shared.ts";
import {
  FEDERATION_RESOURCE,
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
