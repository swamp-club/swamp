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
import {
  accessReviewReport,
  changeHistoryReport,
  COMPLIANCE_REPORTS,
  deniedAccessReport,
  getComplianceReport,
  secretAccessReport,
  systemEventsReport,
} from "./audit_compliance_reports.ts";
import type { AuditStore } from "./audit_store.ts";
import { AuditQueryService } from "./audit_query_service.ts";
import type { ChainedAuditEvent } from "./audit_event.ts";
import { AuditChainState } from "./audit_chain.ts";

function makeChainedEvent(
  overrides: Partial<ChainedAuditEvent>,
): ChainedAuditEvent {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    instanceId: "test-instance",
    category: "access",
    stage: "response",
    outcome: "success",
    action: "grant.create",
    resourceKind: "model",
    resourceName: "my-model",
    principalKind: "user",
    principalId: "alice",
    initiatedBy: "alice",
    sourceIp: "127.0.0.1",
    requestId: crypto.randomUUID(),
    version: 1,
    sequence: 1,
    digest: "0000",
    ...overrides,
  };
}

function makeStore(events: ChainedAuditEvent[]): AuditStore {
  const today = new Date().toISOString().slice(0, 10);
  const data = events.map((e) => JSON.stringify(e)).join("\n");
  const encoded = new TextEncoder().encode(data);
  return {
    async put(_key: string, _data: Uint8Array): Promise<void> {},
    async get(key: string): Promise<Uint8Array | null> {
      if (key === `events/${today}/batch-0.jsonl`) return encoded;
      return null;
    },
    async list(prefix: string): Promise<string[]> {
      if (prefix === `events/${today}/`) {
        return [`events/${today}/batch-0.jsonl`];
      }
      return [];
    },
    async delete(_key: string): Promise<void> {},
  };
}

function makeParams() {
  const now = new Date();
  const from = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const to = now.toISOString();
  return { from, to };
}

Deno.test("accessReviewReport: groups events by principal", async () => {
  const events = [
    makeChainedEvent({
      category: "access",
      principalId: "alice",
      action: "grant.create",
    }),
    makeChainedEvent({
      category: "access",
      principalId: "bob",
      action: "grant.read",
    }),
    makeChainedEvent({
      category: "access",
      principalId: "alice",
      action: "grant.delete",
    }),
  ];
  const store = makeStore(events);
  const service = new AuditQueryService(store);
  const result = await accessReviewReport.execute(service, makeParams());

  assertEquals(result.name, "access-review");
  const json = result.json as {
    principals: { principalId: string; eventCount: number }[];
  };
  assertEquals(json.principals.length, 2);
  const alice = json.principals.find((p) => p.principalId === "alice");
  assertEquals(alice?.eventCount, 2);
});

Deno.test("secretAccessReport: filters vault.read-secret events", async () => {
  const events = [
    makeChainedEvent({
      category: "secrets",
      action: "vault.read-secret",
      principalId: "alice",
      resourceName: "api-key",
    }),
    makeChainedEvent({
      category: "secrets",
      action: "vault.write-secret",
      principalId: "bob",
      resourceName: "db-pass",
    }),
  ];
  const store = makeStore(events);
  const service = new AuditQueryService(store);
  const result = await secretAccessReport.execute(service, makeParams());

  assertEquals(result.name, "secret-access");
  assertStringIncludes(result.markdown, "alice");
});

Deno.test("changeHistoryReport: captures mutating actions", async () => {
  const events = [
    makeChainedEvent({
      category: "data",
      action: "model.create",
      principalId: "alice",
    }),
    makeChainedEvent({
      category: "data",
      action: "model.get",
      principalId: "bob",
    }),
    makeChainedEvent({
      category: "data",
      action: "workflow.delete",
      principalId: "alice",
    }),
  ];
  const store = makeStore(events);
  const service = new AuditQueryService(store);
  const result = await changeHistoryReport.execute(service, makeParams());

  assertEquals(result.name, "change-history");
  const json = result.json as { changes: unknown[]; totalChanges: number };
  assertEquals(json.totalChanges, 2);
});

Deno.test("deniedAccessReport: groups denied events by principal", async () => {
  const events = [
    makeChainedEvent({
      outcome: "denied",
      principalId: "eve",
      action: "vault.read-secret",
      resourceName: "admin-key",
    }),
    makeChainedEvent({
      outcome: "denied",
      principalId: "eve",
      action: "model.delete",
      resourceName: "critical-model",
    }),
    makeChainedEvent({
      outcome: "success",
      principalId: "alice",
      action: "model.get",
    }),
  ];
  const store = makeStore(events);
  const service = new AuditQueryService(store);
  const result = await deniedAccessReport.execute(service, makeParams());

  assertEquals(result.name, "denied-access");
  const json = result.json as { totalDenials: number };
  assertEquals(json.totalDenials, 2);
});

Deno.test("systemEventsReport: filters system category", async () => {
  const events = [
    makeChainedEvent({
      category: "system",
      action: "instance.started",
      detail: "Instance boot",
    }),
    makeChainedEvent({
      category: "system",
      action: "alert.fired",
      detail: "Brute force detected",
    }),
    makeChainedEvent({
      category: "access",
      action: "grant.create",
    }),
  ];
  const store = makeStore(events);
  const service = new AuditQueryService(store);
  const result = await systemEventsReport.execute(service, makeParams());

  assertEquals(result.name, "system-events");
  const json = result.json as { totalEvents: number };
  assertEquals(json.totalEvents, 2);
});

Deno.test("COMPLIANCE_REPORTS: contains all five reports", () => {
  assertEquals(COMPLIANCE_REPORTS.length, 5);
  const names = COMPLIANCE_REPORTS.map((r) => r.name);
  assertEquals(names.includes("access-review"), true);
  assertEquals(names.includes("secret-access"), true);
  assertEquals(names.includes("change-history"), true);
  assertEquals(names.includes("denied-access"), true);
  assertEquals(names.includes("system-events"), true);
});

Deno.test("getComplianceReport: finds report by name", () => {
  const report = getComplianceReport("access-review");
  assertEquals(report?.name, "access-review");
});

Deno.test("getComplianceReport: returns undefined for unknown name", () => {
  assertEquals(getComplianceReport("nonexistent"), undefined);
});
