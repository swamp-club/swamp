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
import { type Span, trace } from "@opentelemetry/api";
import { waitFor, withMockedFetch } from "@swamp-club/swamp-testing";
import { createAuditEvent } from "../../domain/serve_audit/audit_event.ts";
import { withSpan } from "../../infrastructure/tracing/mod.ts";
import { withCapturedSpans } from "../../infrastructure/tracing/span_test_helpers.ts";
import { WebhookSink } from "./webhook_sink.ts";

function makeEvent(action: string) {
  return createAuditEvent({
    instanceId: "inst-1",
    category: "auth",
    stage: "response",
    outcome: "success",
    action,
    resourceKind: "access",
    resourceName: "*",
    principalKind: "user",
    principalId: "test-user",
    initiatedBy: "user:test-user",
    sourceIp: "127.0.0.1",
    requestId: crypto.randomUUID(),
  });
}

Deno.test("WebhookSink: name includes hostname from url", () => {
  const sink = new WebhookSink({
    url: "http://siem.example.com/api/ingest",
    batchIntervalMs: 60_000,
  });
  assertEquals(sink.name, "webhook:siem.example.com");
  assertEquals(sink.durable, false);
  sink.close();
});

Deno.test("WebhookSink: defaults to json format", () => {
  const sink = new WebhookSink({
    url: "http://localhost:9999/ingest",
    batchIntervalMs: 60_000,
  });
  assertEquals(sink.durable, false);
  sink.close();
});

Deno.test("WebhookSink: a tick runs with no active span when started under one", async () => {
  await withCapturedSpans(async () => {
    const seen: (Span | undefined)[] = [];
    await withMockedFetch(() => {
      seen.push(trace.getActiveSpan());
      return new Response(null, { status: 204 });
    }, async () => {
      await withSpan("swamp.cli", {}, async () => {
        // The constructor arms the batch timer under the caller's span.
        const sink = new WebhookSink({
          url: "http://siem.example.com/api/ingest",
          batchIntervalMs: 10,
          batchSize: 100,
        });
        try {
          // A periodic flush only sends when events are queued, so queue one
          // before each tick we wait for.
          await sink.write([makeEvent("first")]);
          await waitFor(() => seen.length >= 1, "the first timed flush");
          await sink.write([makeEvent("second")]);
          await waitFor(() => seen.length >= 2, "the second timed flush");
        } finally {
          await sink.close();
        }
      });
    });
    assert(seen.length >= 2);
    for (const span of seen) assertEquals(span, undefined);
  });
});
