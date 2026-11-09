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

import { assertEquals, assertStringIncludes } from "@std/assert";
import type { AuditEmitter } from "../domain/serve_audit/audit_emitter.ts";
import type { AuditEvent } from "../domain/serve_audit/audit_event.ts";
import {
  emitWebhookRoutesApplied,
  WEBHOOK_ROUTES_APPLIED_ACTION,
  type WebhookRoutesAppliedAudit,
  webhookRoutesAppliedDetail,
} from "./webhook_route_audit.ts";

function recorder(): { events: AuditEvent[]; emitter: AuditEmitter } {
  const events: AuditEvent[] = [];
  return {
    events,
    emitter: {
      emit: (event: AuditEvent) => events.push(event),
    } as unknown as AuditEmitter,
  };
}

function audit(
  overrides: Partial<WebhookRoutesAppliedAudit> = {},
): WebhookRoutesAppliedAudit {
  return {
    context: { trigger: "poll" },
    diff: {
      added: [{
        route: "/hooks/a",
        workflow: "deploy",
        scheme: "github",
        source: "file",
        file: "a.yaml",
      }],
      changed: [],
      removed: [{
        route: "/hooks/old",
        workflow: "deploy",
        scheme: "github",
        source: "config",
      }],
    },
    refused: [],
    kept: [],
    outcome: "success",
    ...overrides,
  };
}

Deno.test("emitWebhookRoutesApplied: a poll is attributed to system", () => {
  const { events, emitter } = recorder();
  emitWebhookRoutesApplied(
    { auditEmitter: emitter, instanceId: "i-1" },
    audit(),
  );

  assertEquals(events.length, 1);
  const event = events[0];
  assertEquals(event.action, WEBHOOK_ROUTES_APPLIED_ACTION);
  assertEquals(event.category, "admin");
  assertEquals(event.outcome, "success");
  assertEquals(event.principalKind, "system");
  assertEquals(event.initiatedBy, "system");
  assertEquals(event.resourceName, "i-1");
  assertEquals(
    event.detail,
    "trigger=poll added=/hooks/a(file:a.yaml) removed=/hooks/old(config)",
  );
});

Deno.test("emitWebhookRoutesApplied: a reload names who asked", () => {
  const { events, emitter } = recorder();
  emitWebhookRoutesApplied(
    { auditEmitter: emitter },
    audit({
      context: {
        trigger: "reload",
        principal: { kind: "user", id: "ada" },
        client: "cli",
        sourceIp: "10.0.0.7",
      },
    }),
  );

  assertEquals(events[0].principalKind, "user");
  assertEquals(events[0].principalId, "ada");
  assertEquals(events[0].initiatedBy, "user:ada");
  assertEquals(events[0].client, "cli");
  assertEquals(events[0].sourceIp, "10.0.0.7");
});

Deno.test("emitWebhookRoutesApplied: refusals make a failure and list files, never messages", () => {
  const { events, emitter } = recorder();
  emitWebhookRoutesApplied(
    { auditEmitter: emitter },
    audit({
      diff: { added: [], changed: [], removed: [] },
      refused: [{ file: "b.yaml" }],
      kept: [{ file: "a.yaml", route: "/hooks/a", reason: "refused" }],
      directoryError: "Failed to read webhook routes directory /secret/path",
      outcome: "failure",
    }),
  );

  assertEquals(events[0].outcome, "failure");
  assertEquals(
    events[0].detail,
    "trigger=poll kept=/hooks/a(file:a.yaml,refused) refused=file:b.yaml directory=unusable",
  );
});

Deno.test("webhookRoutesAppliedDetail: bounds a long route list", () => {
  const added = Array.from({ length: 60 }, (_, i) => ({
    route: `/hooks/r${i}`,
    workflow: "w",
    scheme: "github",
    source: "file" as const,
    file: `r${i}.yaml`,
  }));
  const detail = webhookRoutesAppliedDetail(
    audit({ diff: { added, changed: [], removed: [] } }),
  );
  assertStringIncludes(detail, "/hooks/r49(file:r49.yaml),+10 more");
  assertEquals(detail.includes("/hooks/r50("), false);
});

Deno.test("emitWebhookRoutesApplied: an emitter failure is swallowed", () => {
  const emitter = {
    emit: () => {
      throw new Error("sink full");
    },
  } as unknown as AuditEmitter;
  emitWebhookRoutesApplied({ auditEmitter: emitter }, audit());
});

Deno.test("emitWebhookRoutesApplied: without an emitter nothing happens", () => {
  emitWebhookRoutesApplied({}, audit());
});
