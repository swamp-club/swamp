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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { GrantBasedAccessDecisionService } from "../../domain/access/grant_based_access_decision_service.ts";
import { PolicySnapshot } from "../../domain/access/policy_snapshot.ts";
import {
  createConditionEvaluator,
  type PolicySnapshotLoader,
} from "../../domain/access/policy_snapshot_loader.ts";
import type { Grant } from "../../domain/models/access/grant_model.ts";
import { analyzeContentExpressions } from "../../domain/expressions/expression_references.ts";
import {
  authorizeExpressionReferences,
  MAX_EXPRESSION_TARGETS,
  MAX_SHOWN,
  shown,
} from "./expression_reference_authorization.ts";
import { type ConnectionContext, setConnectionCollectives } from "./shared.ts";

function grant(overrides: Partial<Grant>): Grant {
  return {
    id: crypto.randomUUID(),
    subject: { kind: "user", name: "adam" },
    effect: "allow",
    actions: ["read", "write"],
    resource: { kind: "data", pattern: "*" },
    state: "active",
    source: "method",
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const ALLOW_ALL = [
  grant({ resource: { kind: "data", pattern: "*" } }),
  grant({ resource: { kind: "model", pattern: "*" } }),
];
const DENY_PROD = grant({
  effect: "deny",
  actions: ["read"],
  resource: { kind: "data", pattern: "prod-*" },
});

/** A context whose repositories record calls and hold no definitions. */
function makeCtx(
  grants: Grant[],
  options: { listingFails?: boolean } = {},
): { ctx: ConnectionContext; queries: string[] } {
  const queries: string[] = [];
  const ctx = {
    repoDir: "/tmp/test",
    repoContext: {
      definitionRepo: {
        findAllGlobal: () =>
          options.listingFails
            ? Promise.reject(new Error("unreadable"))
            : Promise.resolve([]),
      },
      workflowRepo: {},
      unifiedDataRepo: { namespace: "" },
      dataQueryService: {
        query: (predicate: string) => {
          queries.push(predicate);
          return Promise.resolve([]);
        },
      },
    },
    policySnapshotLoader: {
      decisionService: new GrantBasedAccessDecisionService(
        new PolicySnapshot(grants, [], createConditionEvaluator()),
      ),
    } as unknown as PolicySnapshotLoader,
    authConfig: {
      mode: "token",
      admins: [],
      allowedCollectives: [],
      allowedUsers: [],
      oauthProvider: "",
      groupsField: "groups",
      restrictedModelTypes: [],
      restrictedCommands: [],
      approveRequiresExplicitGrant: false,
    },
  } as unknown as ConnectionContext;
  return { ctx, queries };
}

function socket(): WebSocket {
  const s = { readyState: 1, send: () => {}, OPEN: 1 } as unknown as WebSocket;
  setConnectionCollectives(s, [], []);
  return s;
}

function check(
  ctx: ConnectionContext,
  content: Record<string, unknown>,
  env: "allowed" | { refusedFor: string } = "allowed",
) {
  return authorizeExpressionReferences(
    socket(),
    "req-1",
    { kind: "user", id: "adam" },
    ctx,
    analyzeContentExpressions(content),
    env,
  );
}

Deno.test("shown: collapses whitespace and shortens long expressions", () => {
  assertEquals(shown("${{ a\n   + b }}"), "${{ a + b }}");
  const long = "${{ " + "x".repeat(MAX_SHOWN * 2) + " }}";
  assertEquals(shown(long).length, MAX_SHOWN + 1);
  assert(shown(long).endsWith("…"));
});

Deno.test("authorizeExpressionReferences: past the cap no target is looked up", async () => {
  const content = Object.fromEntries(
    Array.from({ length: MAX_EXPRESSION_TARGETS + 1 }, (_, i) => [
      `a${i}`,
      `\${{ data.latest("dev-${i}", "s") }}`,
    ]),
  );
  const allowed = makeCtx(ALLOW_ALL);
  assertEquals(await check(allowed.ctx, content), undefined);
  assertEquals(allowed.queries, []);
  const denied = makeCtx([...ALLOW_ALL, DENY_PROD]);
  assert(await check(denied.ctx, content));
  assertEquals(denied.queries, []);
});

Deno.test("authorizeExpressionReferences: a namespaced target is judged as reading any data", async () => {
  const content = { a: '${{ data.latest("ops:dev-db", "s") }}' };
  assertEquals(await check(makeCtx(ALLOW_ALL).ctx, content), undefined);
  assert(await check(makeCtx([...ALLOW_ALL, DENY_PROD]).ctx, content));
});

Deno.test("authorizeExpressionReferences: definitions that cannot be listed refuse", async () => {
  const refusal = await check(
    makeCtx(ALLOW_ALL, { listingFails: true }).ctx,
    { a: '${{ data.latest("dev-db", "s") }}' },
  );
  assertStringIncludes(refusal!.message, "not readable here");
});

Deno.test("authorizeExpressionReferences: env without write is refused, and says why", async () => {
  const { ctx } = makeCtx(ALLOW_ALL);
  const refused = { refusedFor: "echo-x" };
  assertStringIncludes(
    (await check(ctx, { a: "${{ env.HOME }}" }, refused))!.message,
    "reference it in the model definition",
  );
  assertStringIncludes(
    (await check(ctx, { a: "${{ env.( }}" }, refused))!.message,
    "could not be analyzed",
  );
  assertEquals(await check(ctx, { a: "${{ env.HOME }}" }), undefined);
});
