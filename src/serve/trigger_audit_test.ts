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
import { WEBHOOK_PRINCIPAL } from "../domain/access/service_principal.ts";
import type { AuditEmitter } from "../domain/serve_audit/audit_emitter.ts";
import type { AuditEvent } from "../domain/serve_audit/audit_event.ts";
import {
  auditScheduledEvent,
  auditWebhookEvent,
  createScheduledRunAuthorizer,
  createWebhookRunAuthorizer,
  emitTriggerAuditEvent,
  emitTriggerDenial,
} from "./trigger_audit.ts";
import type { WorkflowId } from "../domain/workflows/workflow_id.ts";
import type { TriggerAuthorizer } from "./trigger_authorizer.ts";
import { WebhookRejectionCoalescer } from "./webhook_audit_coalescer.ts";

function recorder(): { events: AuditEvent[]; emitter: AuditEmitter } {
  const events: AuditEvent[] = [];
  return {
    events,
    emitter: {
      emit: (event: AuditEvent) => events.push(event),
    } as unknown as AuditEmitter,
  };
}

Deno.test("emitTriggerAuditEvent: records an execution event for the service principal", () => {
  const { events, emitter } = recorder();
  emitTriggerAuditEvent({ auditEmitter: emitter, instanceId: "i-1" }, {
    principal: WEBHOOK_PRINCIPAL,
    action: "workflow.webhook.fire",
    outcome: "success",
    workflowName: "deploy",
    sourceIp: "203.0.113.9",
    detail: { route: "/hooks/gh", run: "r-1", skipped: undefined },
  });
  assertEquals(events.length, 1);
  const [event] = events;
  assertEquals(event.category, "execution");
  assertEquals(event.action, "workflow.webhook.fire");
  assertEquals(event.principalKind, "service");
  assertEquals(event.principalId, "webhook");
  assertEquals(event.initiatedBy, "service:webhook");
  assertEquals(event.resourceKind, "workflow");
  assertEquals(event.resourceName, "deploy");
  assertEquals(event.sourceIp, "203.0.113.9");
  assertEquals(event.detail, "route=/hooks/gh run=r-1");
});

Deno.test("emitTriggerAuditEvent: a throwing emitter is swallowed", () => {
  const emitter = {
    emit: () => {
      throw new Error("wal full");
    },
  } as unknown as AuditEmitter;
  emitTriggerAuditEvent({ auditEmitter: emitter }, {
    principal: WEBHOOK_PRINCIPAL,
    action: "workflow.webhook.fire",
    outcome: "success",
    workflowName: "deploy",
    sourceIp: "127.0.0.1",
    detail: {},
  });
});

Deno.test("emitTriggerAuditEvent: no emitter is a no-op", () => {
  emitTriggerAuditEvent({}, {
    principal: WEBHOOK_PRINCIPAL,
    action: "workflow.webhook.fire",
    outcome: "success",
    workflowName: "deploy",
    sourceIp: "127.0.0.1",
    detail: {},
  });
});

Deno.test("emitTriggerDenial: records an access denial with the decision", () => {
  const { events, emitter } = recorder();
  emitTriggerDenial(
    { auditEmitter: emitter },
    WEBHOOK_PRINCIPAL,
    {
      allowed: false,
      workflowIdOrName: "deploy",
      resource: {
        kind: "workflow",
        name: "deploy",
        fields: { name: "deploy" },
      },
      decision: {
        effect: "deny",
        grantId: "g-1",
        subject: { kind: "service", name: "webhook" },
      },
      reason: "denied",
    },
    "203.0.113.9",
    { route: "/hooks/gh" },
  );
  const [event] = events;
  assertEquals(event.category, "access");
  assertEquals(event.outcome, "denied");
  assertEquals(event.action, "run");
  assertEquals(event.initiatedBy, "service:webhook");
  assertEquals(event.detail, "route=/hooks/gh reason=denied");
  assertEquals(event.decision?.grantId, "g-1");
  assertEquals(event.decision?.effect, "deny");
});

const WF_ID = "wf-1" as WorkflowId;

Deno.test("auditScheduledEvent: a started run is a workflow.schedule.fire", () => {
  const { events, emitter } = recorder();
  auditScheduledEvent({ auditEmitter: emitter }, {
    kind: "schedule_started",
    workflowId: WF_ID,
    workflowName: "nightly",
    runId: "run-9",
    fireTime: "2026-09-29T00:00:00.000Z",
    replayed: false,
  });
  assertEquals(events.length, 1);
  assertEquals(events[0].action, "workflow.schedule.fire");
  assertEquals(events[0].outcome, "success");
  assertEquals(events[0].initiatedBy, "service:scheduler");
  assertEquals(events[0].sourceIp, "127.0.0.1");
  assertEquals(events[0].resourceName, "nightly");
  assertEquals(
    events[0].detail,
    "run=run-9 fireTime=2026-09-29T00:00:00.000Z",
  );
});

Deno.test("auditScheduledEvent: a replayed run is flagged", () => {
  const { events, emitter } = recorder();
  auditScheduledEvent({ auditEmitter: emitter }, {
    kind: "schedule_started",
    workflowId: WF_ID,
    workflowName: "nightly",
    runId: "run-9",
    replayed: true,
  });
  assertEquals(events[0].detail, "run=run-9 replayed=true");
});

Deno.test("auditScheduledEvent: skips record overlap as failure and dedup as success", () => {
  const { events, emitter } = recorder();
  for (const dedupSkip of [false, true]) {
    auditScheduledEvent({ auditEmitter: emitter }, {
      kind: "schedule_skipped",
      workflowId: WF_ID,
      workflowName: "nightly",
      reason: "x",
      dedupSkip,
      fireTime: "2026-09-29T00:00:00.000Z",
    });
  }
  assertEquals(events.map((e) => [e.action, e.outcome, e.detail]), [
    [
      "workflow.schedule.skipped",
      "failure",
      "fireTime=2026-09-29T00:00:00.000Z reason=overlap",
    ],
    [
      "workflow.schedule.skipped",
      "success",
      "fireTime=2026-09-29T00:00:00.000Z reason=dedup",
    ],
  ]);
});

Deno.test("auditScheduledEvent: other scheduler events are not audited", () => {
  const { events, emitter } = recorder();
  auditScheduledEvent({ auditEmitter: emitter }, {
    kind: "schedule_fired",
    workflowId: WF_ID,
    workflowName: "nightly",
    fireTime: "2026-09-29T00:00:00.000Z",
  });
  assertEquals(events.length, 0);
});

Deno.test("createScheduledRunAuthorizer: decides as the scheduler and audits refusals", async () => {
  const { events, emitter } = recorder();
  const seen: string[] = [];
  const authorize: TriggerAuthorizer = (principal, workflow) => {
    seen.push(`${principal.kind}:${principal.id}`);
    return Promise.resolve({
      allowed: workflow !== "blocked",
      workflowIdOrName: workflow,
      resource: {
        kind: "workflow",
        name: workflow,
        fields: { name: workflow },
      },
      decision: null,
      reason: workflow === "blocked" ? "denied" : undefined,
    });
  };
  const authorizeRun = createScheduledRunAuthorizer(authorize, {
    auditEmitter: emitter,
  });
  assertEquals(
    (await authorizeRun({ workflowName: "nightly", replayed: false })).allowed,
    true,
  );
  assertEquals(events.length, 0);
  assertEquals(
    (await authorizeRun({
      workflowName: "blocked",
      fireTime: new Date("2026-09-29T00:00:00.000Z"),
      replayed: false,
    })).allowed,
    false,
  );
  assertEquals(seen, ["service:scheduler", "service:scheduler"]);
  assertEquals(events.length, 1);
  assertEquals(events[0].category, "access");
  assertEquals(
    events[0].detail,
    "fireTime=2026-09-29T00:00:00.000Z reason=denied",
  );
});

Deno.test("auditWebhookEvent: a started run is a workflow.webhook.fire from the sender", () => {
  const { events, emitter } = recorder();
  auditWebhookEvent({ auditEmitter: emitter }, {
    kind: "webhook_started",
    route: "/hooks/gh",
    workflowName: "deploy",
    runId: "run-3",
    sourceIp: "203.0.113.9",
    replayed: false,
  }, new WebhookRejectionCoalescer());
  assertEquals(events.length, 1);
  assertEquals(events[0].action, "workflow.webhook.fire");
  assertEquals(events[0].initiatedBy, "service:webhook");
  assertEquals(events[0].sourceIp, "203.0.113.9");
  assertEquals(events[0].detail, "route=/hooks/gh run=run-3");
});

Deno.test("auditWebhookEvent: rejections are coalesced per route and reason", () => {
  const { events, emitter } = recorder();
  let now = 0;
  const coalescer = new WebhookRejectionCoalescer({
    windowMs: 1000,
    now: () => now,
  });
  const reject = () =>
    auditWebhookEvent({ auditEmitter: emitter }, {
      kind: "webhook_rejected",
      route: "/hooks/gh",
      workflowName: "deploy",
      reason: "Invalid signature",
      sourceIp: "198.51.100.7",
    }, coalescer);
  reject();
  reject();
  reject();
  now = 1000;
  reject();
  assertEquals(events.map((e) => [e.action, e.outcome, e.detail]), [
    [
      "workflow.webhook.rejected",
      "failure",
      "route=/hooks/gh reason=Invalid signature",
    ],
    [
      "workflow.webhook.rejected",
      "failure",
      "route=/hooks/gh reason=Invalid signature suppressed=2",
    ],
  ]);
  assertEquals(events[0].resourceName, "deploy");
});

Deno.test("auditWebhookEvent: queued and completed deliveries are not audited", () => {
  const { events, emitter } = recorder();
  const coalescer = new WebhookRejectionCoalescer();
  auditWebhookEvent({ auditEmitter: emitter }, {
    kind: "webhook_queued",
    route: "/hooks/gh",
    workflowName: "deploy",
  }, coalescer);
  auditWebhookEvent({ auditEmitter: emitter }, {
    kind: "webhook_completed",
    route: "/hooks/gh",
    workflowName: "deploy",
    runId: "r",
  }, coalescer);
  assertEquals(events.length, 0);
});

Deno.test("createWebhookRunAuthorizer: decides as the webhook principal and audits refusals with the sender", async () => {
  const { events, emitter } = recorder();
  const seen: string[] = [];
  const authorize: TriggerAuthorizer = (principal, workflow) => {
    seen.push(`${principal.kind}:${principal.id}`);
    return Promise.resolve({
      allowed: false,
      workflowIdOrName: workflow,
      resource: {
        kind: "workflow",
        name: workflow,
        fields: { name: workflow },
      },
      decision: null,
      reason: "denied",
    });
  };
  const result = await createWebhookRunAuthorizer(authorize, {
    auditEmitter: emitter,
  })({
    workflowIdOrName: "deploy",
    route: "/hooks/gh",
    sourceIp: "203.0.113.9",
    replayed: false,
  });
  assertEquals(result.allowed, false);
  assertEquals(seen, ["service:webhook"]);
  assertEquals(events[0].category, "access");
  assertEquals(events[0].sourceIp, "203.0.113.9");
  assertEquals(events[0].detail, "route=/hooks/gh reason=denied");
});
