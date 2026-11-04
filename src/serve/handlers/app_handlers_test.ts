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
import { capabilityKey } from "../../domain/apps/app_descriptor.ts";
import type { AppApproval } from "../../domain/apps/app_approval.ts";
import type { InstalledApp } from "../../domain/apps/app_catalog.ts";
import { GrantBasedAccessDecisionService } from "../../domain/access/grant_based_access_decision_service.ts";
import { PolicySnapshot } from "../../domain/access/policy_snapshot.ts";
import type { Grant } from "../../domain/models/access/grant_model.ts";
import { createConditionEvaluator } from "../../domain/access/policy_snapshot_loader.ts";
import type { Principal } from "../../domain/access/principal.ts";
import { EphemeralAppLaunchKey } from "../app_launch_key.ts";
import type { ConnectionContext } from "./shared.ts";
import {
  handleAppApprove,
  handleAppLaunch,
  handleAppList,
  handleAppRevoke,
} from "./app_handlers.ts";

const descriptor = (name: string) => ({
  name,
  title: name,
  entry: "dist/index.html",
  bridge: 1 as const,
  platform: 1,
  capabilities: ["runs:read" as const],
  run: [],
  methods: [],
});

const installed = (name: string): InstalledApp => ({
  descriptor: descriptor(name),
  root: "/app",
  origin: "local",
  built: true,
});

const VIEWER: Principal = { kind: "user", id: "viewer" };

function viewerGrant(
  pattern: string,
  effect: "allow" | "deny" = "allow",
): Grant {
  return {
    id: crypto.randomUUID(),
    subject: { kind: "user", name: "viewer" },
    effect,
    actions: ["read"],
    resource: { kind: "access", pattern },
    state: "active",
    source: "method",
    createdBy: { kind: "user", id: "admin" },
    createdAt: "2026-01-01T00:00:00Z",
  };
}

const EVERY_APP = viewerGrant("swamp/apps/*");

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

function context(grants: Grant[] | null) {
  const approvals = new Map<string, AppApproval>(
    ["@acme/on", "@acme/also"].map((name) => [name, {
      name,
      capabilityKey: capabilityKey(descriptor(name), "local"),
      approvedBy: "user:a",
      approvedAt: "2026-11-04T00:00:00.000Z",
    }]),
  );
  const ctx = {
    repoContext: {},
    authConfig: { mode: grants ? "token" : "none" },
    ...(grants
      ? {
        policySnapshotLoader: {
          decisionService: new GrantBasedAccessDecisionService(
            new PolicySnapshot(grants, [], createConditionEvaluator()),
          ),
        },
      }
      : {}),
    appDeps: {
      catalog: {
        list: () =>
          Promise.resolve({
            apps: [
              installed("@acme/on"),
              installed("@acme/also"),
              installed("@acme/waiting"),
            ],
            problems: [{ path: "/secret/path", message: "bad" }],
          }),
      },
      approvals: {
        get: (name: string) => Promise.resolve(approvals.get(name) ?? null),
        save: (approval: AppApproval) => {
          approvals.set(approval.name, approval);
          return Promise.resolve();
        },
        delete: (name: string) => Promise.resolve(approvals.delete(name)),
      },
      launchKey: new EphemeralAppLaunchKey(),
      now: () => new Date("2026-11-04T00:00:00.000Z"),
    },
  } as unknown as ConnectionContext;
  return { ctx, approvals };
}

Deno.test("handleAppList: a manager sees what is waiting", async () => {
  const ws = socket();
  await handleAppList(ws, context(null).ctx, "r", null);
  const { payload } = JSON.parse(ws.sent[0]);
  assertEquals(payload.canManage, true);
  assertEquals(payload.data.apps.length, 3);
});

async function viewerSees(grants: Grant[]): Promise<string[]> {
  const ws = socket();
  await handleAppList(ws, context(grants).ctx, "r", VIEWER);
  const { payload } = JSON.parse(ws.sent[0]);
  return payload.data.apps.map((app: { name: string }) => app.name);
}

Deno.test("handleAppList: a grant on every app shows each enabled app, no paths", async () => {
  const ws = socket();
  await handleAppList(ws, context([EVERY_APP]).ctx, "r", VIEWER);
  const { payload } = JSON.parse(ws.sent[0]);
  assertEquals(payload.canManage, false);
  assertEquals(payload.data.apps.map((app: { name: string }) => app.name), [
    "@acme/on",
    "@acme/also",
  ]);
  assertEquals(payload.data.problems, []);
  assertEquals(payload.data.apps[0].approvedBy, undefined);
});

Deno.test("handleAppList: a grant on one app shows only that app", async () => {
  assertEquals(await viewerSees([viewerGrant("swamp/apps/@acme/also")]), [
    "@acme/also",
  ]);
});

Deno.test("handleAppList: a deny on one app beats a grant on every app", async () => {
  assertEquals(
    await viewerSees([EVERY_APP, viewerGrant("swamp/apps/@acme/on", "deny")]),
    ["@acme/also"],
  );
});

Deno.test("handleAppList: a viewer without a grant sees no apps", async () => {
  assertEquals(await viewerSees([]), []);
});

Deno.test("handleAppLaunch: refuses a viewer granted only another app", async () => {
  const ws = socket();
  await handleAppLaunch(
    ws,
    context([viewerGrant("swamp/apps/@acme/also")]).ctx,
    "r",
    { name: "@acme/on" },
    VIEWER,
  );
  assertEquals(JSON.parse(ws.sent[0]).type, "error");
});

Deno.test("handleAppLaunch: refuses a viewer without a grant", async () => {
  const ws = socket();
  await handleAppLaunch(ws, context([]).ctx, "r", { name: "@acme/on" }, VIEWER);
  assertEquals(JSON.parse(ws.sent[0]).type, "error");
});

Deno.test("handleAppLaunch: a viewer granted the app gets a launch", async () => {
  const ws = socket();
  await handleAppLaunch(
    ws,
    context([viewerGrant("swamp/apps/@acme/on")]).ctx,
    "r",
    { name: "@acme/on" },
    VIEWER,
  );
  assertEquals(JSON.parse(ws.sent[0]).type, "app.launch");
});

Deno.test("handleAppApprove: refuses a viewer without the grant", async () => {
  const ws = socket();
  const { ctx, approvals } = context([]);
  await handleAppApprove(ws, ctx, "r", { name: "@acme/waiting" }, VIEWER);
  assertEquals(JSON.parse(ws.sent[0]).type, "error");
  assertEquals(approvals.has("@acme/waiting"), false);
});

Deno.test("handleAppRevoke: refuses a viewer without the grant", async () => {
  const ws = socket();
  const { ctx, approvals } = context([]);
  await handleAppRevoke(ws, ctx, "r", { name: "@acme/on" }, VIEWER);
  assertEquals(JSON.parse(ws.sent[0]).type, "error");
  assertEquals(approvals.has("@acme/on"), true);
});

Deno.test("handleAppApprove: records who approved it", async () => {
  const ws = socket();
  const { ctx, approvals } = context(null);
  await handleAppApprove(ws, ctx, "r", { name: "@acme/waiting" }, null);
  assertEquals(JSON.parse(ws.sent[0]).type, "app.approve");
  assertEquals(approvals.get("@acme/waiting")?.approvedBy, "ghost");
});

Deno.test("handleAppApprove: an unknown app is refused as not found", async () => {
  const ws = socket();
  await handleAppApprove(
    ws,
    context(null).ctx,
    "r",
    { name: "@acme/nope" },
    null,
  );
  const { error } = JSON.parse(ws.sent[0]);
  assertEquals(error.code, "app_approve_failed");
  assertEquals(error.details?.reason, "not_found");
});

Deno.test("handleAppRevoke: an unknown app is refused as not found", async () => {
  const ws = socket();
  await handleAppRevoke(
    ws,
    context(null).ctx,
    "r",
    { name: "@acme/nope" },
    null,
  );
  assertEquals(JSON.parse(ws.sent[0]).error.details?.reason, "not_found");
});
