// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
