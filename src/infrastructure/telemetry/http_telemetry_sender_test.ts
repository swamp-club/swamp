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
import { HttpTelemetrySender } from "./http_telemetry_sender.ts";
import { TelemetryEntry } from "../../domain/telemetry/telemetry_entry.ts";

function createTestEntry(id: string, date: Date): TelemetryEntry {
  return TelemetryEntry.create({
    id,
    invocation: {
      command: "model",
      subcommand: "create",
      args: ["<REDACTED>"],
      optionKeys: ["--json"],
      globalOptions: [],
    },
    result: { status: "success", exitCode: 0 },
    startedAt: date,
    completedAt: new Date(date.getTime() + 1000),
    swampVersion: "1.0.0",
    denoVersion: "2.1.0",
    platform: "linux",
  });
}

Deno.test("HttpTelemetrySender.sendBatch sends single event format for one entry", async () => {
  let capturedBody: string | undefined;
  let capturedUrl: string | undefined;

  const server = Deno.serve({ port: 0 }, async (req: Request) => {
    capturedUrl = req.url;
    capturedBody = await req.text();
    return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
  });

  const port = server.addr.port;
  const sender = new HttpTelemetrySender(`http://localhost:${port}`);
  const entry = createTestEntry(
    "test-uuid-1",
    new Date("2024-03-10T10:00:00Z"),
  );

  const result = await sender.sendBatch([entry], "repo-uuid-123");

  assertEquals(result, true);
  assertEquals(capturedUrl, `http://localhost:${port}/ingest`);

  const parsed = JSON.parse(capturedBody!);
  assertEquals(parsed.event, "cli_invocation");
  assertEquals(parsed.distinct_id, "repo-uuid-123");
  assertEquals(parsed.properties.id, "test-uuid-1");

  await server.shutdown();
});

Deno.test("HttpTelemetrySender.sendBatch sends batch format for multiple entries", async () => {
  let capturedBody: string | undefined;

  const server = Deno.serve({ port: 0 }, async (req: Request) => {
    capturedBody = await req.text();
    return new Response(JSON.stringify({ accepted: 2 }), { status: 202 });
  });

  const port = server.addr.port;
  const sender = new HttpTelemetrySender(`http://localhost:${port}`);
  const entry1 = createTestEntry("uuid-1", new Date("2024-03-10T10:00:00Z"));
  const entry2 = createTestEntry("uuid-2", new Date("2024-03-10T11:00:00Z"));

  const result = await sender.sendBatch([entry1, entry2], "repo-uuid");

  assertEquals(result, true);

  const parsed = JSON.parse(capturedBody!);
  assertEquals(parsed.events.length, 2);
  assertEquals(parsed.events[0].event, "cli_invocation");
  assertEquals(parsed.events[0].distinct_id, "repo-uuid");
  assertEquals(parsed.events[1].properties.id, "uuid-2");

  await server.shutdown();
});

Deno.test("HttpTelemetrySender.sendBatch returns false on non-202 status", async () => {
  const server = Deno.serve({ port: 0 }, () => {
    return new Response(JSON.stringify({ error: "bad request" }), {
      status: 400,
    });
  });

  const port = server.addr.port;
  const sender = new HttpTelemetrySender(`http://localhost:${port}`);
  const entry = createTestEntry("uuid-1", new Date("2024-03-10T10:00:00Z"));

  const result = await sender.sendBatch([entry], "repo-uuid");
  assertEquals(result, false);

  await server.shutdown();
});

Deno.test("HttpTelemetrySender.sendBatch returns false on network error", async () => {
  // Use a port that nothing is listening on
  const sender = new HttpTelemetrySender("http://localhost:1");
  const entry = createTestEntry("uuid-1", new Date("2024-03-10T10:00:00Z"));

  const result = await sender.sendBatch([entry], "repo-uuid");
  assertEquals(result, false);
});

Deno.test("HttpTelemetrySender.sendBatch includes $repo_id when provided", async () => {
  let capturedBody: string | undefined;

  const server = Deno.serve({ port: 0 }, async (req: Request) => {
    capturedBody = await req.text();
    return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
  });

  const port = server.addr.port;
  const sender = new HttpTelemetrySender(`http://localhost:${port}`);
  const entry = createTestEntry(
    "test-uuid-1",
    new Date("2024-03-10T10:00:00Z"),
  );

  const result = await sender.sendBatch(
    [entry],
    "user-uuid-123",
    "repo-uuid-456",
  );

  assertEquals(result, true);

  const parsed = JSON.parse(capturedBody!);
  assertEquals(parsed.distinct_id, "user-uuid-123");
  assertEquals(parsed.properties.$repo_id, "repo-uuid-456");

  await server.shutdown();
});

Deno.test("HttpTelemetrySender.sendBatch omits $repo_id when not provided", async () => {
  let capturedBody: string | undefined;

  const server = Deno.serve({ port: 0 }, async (req: Request) => {
    capturedBody = await req.text();
    return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
  });

  const port = server.addr.port;
  const sender = new HttpTelemetrySender(`http://localhost:${port}`);
  const entry = createTestEntry(
    "test-uuid-1",
    new Date("2024-03-10T10:00:00Z"),
  );

  const result = await sender.sendBatch([entry], "user-uuid-123");

  assertEquals(result, true);

  const parsed = JSON.parse(capturedBody!);
  assertEquals(parsed.distinct_id, "user-uuid-123");
  assertEquals(parsed.properties.$repo_id, undefined);

  await server.shutdown();
});

Deno.test("HttpTelemetrySender.sendBatch includes x-api-key header when authToken provided", async () => {
  let capturedApiKey: string | null = null;

  const server = Deno.serve({ port: 0 }, async (req: Request) => {
    capturedApiKey = req.headers.get("x-api-key");
    await req.body?.cancel();
    return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
  });

  const port = server.addr.port;
  const sender = new HttpTelemetrySender(`http://localhost:${port}`);
  const entry = createTestEntry(
    "test-uuid-1",
    new Date("2024-03-10T10:00:00Z"),
  );

  const result = await sender.sendBatch(
    [entry],
    "user-uuid-123",
    undefined,
    "test-api-key-abc",
  );

  assertEquals(result, true);
  assertEquals(capturedApiKey, "test-api-key-abc");

  await server.shutdown();
});

Deno.test("HttpTelemetrySender.sendBatch omits x-api-key header when authToken not provided", async () => {
  let capturedApiKey: string | null = null;

  const server = Deno.serve({ port: 0 }, async (req: Request) => {
    capturedApiKey = req.headers.get("x-api-key");
    await req.body?.cancel();
    return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
  });

  const port = server.addr.port;
  const sender = new HttpTelemetrySender(`http://localhost:${port}`);
  const entry = createTestEntry(
    "test-uuid-1",
    new Date("2024-03-10T10:00:00Z"),
  );

  const result = await sender.sendBatch([entry], "user-uuid-123");

  assertEquals(result, true);
  assertEquals(capturedApiKey, null);

  await server.shutdown();
});

Deno.test("HttpTelemetrySender.sendBatch includes User-Agent header when provided", async () => {
  let capturedUserAgent: string | null = null;

  const server = Deno.serve({ port: 0 }, async (req: Request) => {
    capturedUserAgent = req.headers.get("user-agent");
    await req.body?.cancel();
    return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
  });

  const port = server.addr.port;
  const sender = new HttpTelemetrySender(
    `http://localhost:${port}`,
    "swamp-cli/1.2.3",
  );
  const entry = createTestEntry(
    "test-uuid-1",
    new Date("2024-03-10T10:00:00Z"),
  );

  const result = await sender.sendBatch([entry], "user-uuid-123");

  assertEquals(result, true);
  assertEquals(capturedUserAgent, "swamp-cli/1.2.3");

  await server.shutdown();
});

Deno.test("HttpTelemetrySender.sendBatch lands invocationContext at properties.invocationContext", async () => {
  // Wire-shape contract: TelemetryEntry.toData() is splatted into properties
  // verbatim, so the swamp-club consumer side queries
  // properties.invocationContext.{configuredAiTools, detectedAiTool,
  // agentSessionDetected, isInteractive, externalDatastoreConfigured}.
  // Lock the shape here.
  let capturedBody: string | undefined;

  const server = Deno.serve({ port: 0 }, async (req: Request) => {
    capturedBody = await req.text();
    return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
  });

  const port = server.addr.port;
  const sender = new HttpTelemetrySender(`http://localhost:${port}`);
  const entry = TelemetryEntry.create({
    id: "ctx-wire",
    invocation: {
      command: "model",
      args: [],
      optionKeys: [],
      globalOptions: [],
    },
    result: { status: "success", exitCode: 0 },
    startedAt: new Date("2024-03-10T10:00:00Z"),
    completedAt: new Date("2024-03-10T10:00:01Z"),
    swampVersion: "1.0.0",
    denoVersion: "2.1.0",
    platform: "linux",
    invocationContext: {
      configuredAiTools: ["claude", "cursor"],
      detectedAiTool: "claude",
      agentSessionDetected: true,
      isInteractive: false,
      externalDatastoreConfigured: true,
    },
  });

  const ok = await sender.sendBatch([entry], "user-uuid");
  assertEquals(ok, true);

  const parsed = JSON.parse(capturedBody!);
  assertEquals(parsed.properties.invocationContext.configuredAiTools, [
    "claude",
    "cursor",
  ]);
  assertEquals(parsed.properties.invocationContext.detectedAiTool, "claude");
  assertEquals(parsed.properties.invocationContext.agentSessionDetected, true);
  assertEquals(parsed.properties.invocationContext.isInteractive, false);
  assertEquals(
    parsed.properties.invocationContext.externalDatastoreConfigured,
    true,
  );

  await server.shutdown();
});

Deno.test("HttpTelemetrySender.sendBatch lands parentInvocationId and workflowContext at properties", async () => {
  // Same wire-shape contract as invocationContext: TelemetryEntry.toData()
  // is splatted into properties, so child invocation entries land
  // properties.parentInvocationId and properties.workflowContext.{...}.
  let capturedBody: string | undefined;

  const server = Deno.serve({ port: 0 }, async (req: Request) => {
    capturedBody = await req.text();
    return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
  });

  const port = server.addr.port;
  const sender = new HttpTelemetrySender(`http://localhost:${port}`);
  const entry = TelemetryEntry.create({
    id: "child-wire",
    invocation: {
      command: "model",
      subcommand: "method",
      args: ["run", "<REDACTED>", "validate"],
      optionKeys: [],
      globalOptions: [],
    },
    result: { status: "success", exitCode: 0 },
    startedAt: new Date("2024-03-10T10:00:00Z"),
    completedAt: new Date("2024-03-10T10:00:00.250Z"),
    swampVersion: "1.0.0",
    denoVersion: "2.1.0",
    platform: "linux",
    parentInvocationId: "parent-wire",
    workflowContext: {
      workflowName: "deploy",
      runId: "run-1",
      jobName: "build",
      stepName: "validate",
      modelType: "@swamp/shell",
      driver: "local",
    },
  });

  const ok = await sender.sendBatch([entry], "user-uuid");
  assertEquals(ok, true);

  const parsed = JSON.parse(capturedBody!);
  assertEquals(parsed.properties.parentInvocationId, "parent-wire");
  assertEquals(parsed.properties.workflowContext.workflowName, "deploy");
  assertEquals(parsed.properties.workflowContext.runId, "run-1");
  assertEquals(parsed.properties.workflowContext.jobName, "build");
  assertEquals(parsed.properties.workflowContext.stepName, "validate");
  assertEquals(parsed.properties.workflowContext.modelType, "@swamp/shell");
  assertEquals(parsed.properties.workflowContext.driver, "local");

  await server.shutdown();
});

Deno.test("HttpTelemetrySender.sendBatch omits parentInvocationId / workflowContext when absent", async () => {
  // Backward-compat: parent entries and direct CLI invocations don't
  // carry these fields. The wire payload must omit them entirely (not
  // serialize undefined) so older ingest schemas don't break.
  let capturedBody: string | undefined;

  const server = Deno.serve({ port: 0 }, async (req: Request) => {
    capturedBody = await req.text();
    return new Response(JSON.stringify({ accepted: 1 }), { status: 202 });
  });

  const port = server.addr.port;
  const sender = new HttpTelemetrySender(`http://localhost:${port}`);
  const entry = createTestEntry(
    "no-extras",
    new Date("2024-03-10T10:00:00Z"),
  );

  const ok = await sender.sendBatch([entry], "user-uuid");
  assertEquals(ok, true);

  const parsed = JSON.parse(capturedBody!);
  assertEquals("parentInvocationId" in parsed.properties, false);
  assertEquals("workflowContext" in parsed.properties, false);

  await server.shutdown();
});
