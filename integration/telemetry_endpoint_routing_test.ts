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

/**
 * The telemetry spool is shared by every run, so a flush must only send the
 * entries recorded for the endpoint it flushes to. Without that, events a
 * repo routes to its own collector reach the public default the next time a
 * command runs outside the repo (swamp-club#2831).
 */

import { assertEquals } from "@std/assert";
import { JsonTelemetryRepository } from "../src/infrastructure/persistence/json_telemetry_repository.ts";
import { HttpTelemetrySender } from "../src/infrastructure/telemetry/http_telemetry_sender.ts";
import { TelemetryService } from "../src/domain/telemetry/telemetry_service.ts";
import { TelemetryEntry } from "../src/domain/telemetry/telemetry_entry.ts";

interface Collector {
  url: string;
  receivedIds: string[];
  close: () => Promise<void>;
}

function startCollector(): Collector {
  const receivedIds: string[] = [];
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    async (req) => {
      const body = await req.json();
      const events = body.events ?? [body];
      for (const event of events) receivedIds.push(event.insert_id);
      return new Response(JSON.stringify({ accepted: events.length }), {
        status: 202,
      });
    },
  );
  return {
    url: `http://localhost:${server.addr.port}`,
    receivedIds,
    close: () => server.shutdown(),
  };
}

function serviceFor(spoolDir: string, endpoint: string): TelemetryService {
  return new TelemetryService(
    new JsonTelemetryRepository(spoolDir, spoolDir),
    "1.0.0",
    undefined,
    undefined,
    undefined,
    undefined,
    endpoint,
  );
}

async function flush(service: TelemetryService, endpoint: string) {
  return await service.flushTelemetry({
    sender: new HttpTelemetrySender(endpoint),
    distinctId: "user-id",
    signal: AbortSignal.timeout(5000),
  });
}

const INVOCATION = {
  command: "model",
  args: [],
  optionKeys: [],
  globalOptions: [],
};

Deno.test("telemetry flush only sends entries recorded for the flushing endpoint", async () => {
  const spoolDir = await Deno.makeTempDir();
  const repoCollector = startCollector();
  const publicCollector = startCollector();
  try {
    // A run inside a repo that routes to its own collector.
    const repoRun = serviceFor(spoolDir, repoCollector.url);
    await repoRun.recordSuccess(INVOCATION, new Date());

    // An entry spooled before endpoint stamping existed.
    const legacy = TelemetryEntry.create({
      id: crypto.randomUUID(),
      invocation: INVOCATION,
      result: { status: "success", exitCode: 0 },
      startedAt: new Date(),
      completedAt: new Date(),
      swampVersion: "0.9.0",
      denoVersion: "2.0.0",
      platform: "linux",
    });
    await new JsonTelemetryRepository(spoolDir, spoolDir).save(legacy);

    // A later run outside the repo flushes to the public endpoint.
    const outsideRun = serviceFor(spoolDir, publicCollector.url);
    const outcome = await flush(outsideRun, publicCollector.url);
    assertEquals(outcome.result.ok, true);
    assertEquals(publicCollector.receivedIds, [legacy.id]);
    assertEquals(repoCollector.receivedIds, []);

    // The repo's entry is still spooled and goes to its own collector.
    const repoFlush = await flush(
      serviceFor(spoolDir, repoCollector.url),
      repoCollector.url,
    );
    assertEquals(repoFlush.result.ok, true);
    assertEquals(repoCollector.receivedIds, [repoRun.invocationId]);
    assertEquals(publicCollector.receivedIds, [legacy.id]);

    const remaining: string[] = [];
    for await (const f of Deno.readDir(spoolDir)) remaining.push(f.name);
    assertEquals(remaining.filter((n) => n.startsWith("telemetry-")), []);
  } finally {
    await repoCollector.close();
    await publicCollector.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(spoolDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(spoolDir, { recursive: true });
    }
  }
});
