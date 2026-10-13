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
import {
  probeStartServer,
  START_PING_TOKEN_HEADER,
  START_PROBE_TIMEOUT_MS,
  startProbeTimeoutMs,
  WINDOWS_START_PROBE_TIMEOUT_MS,
} from "./start_instance_probe.ts";
import type { StartServerRecord } from "../persistence/start_server_record.ts";

const TOKEN = "probe-token-" + crypto.randomUUID();

function record(port: number, pid = Deno.pid): StartServerRecord {
  return { pid, port, token: TOKEN, startedAt: "2026-10-11T00:00:00.000Z" };
}

async function withServer(
  handler: (req: Request) => Response | Promise<Response>,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    handler,
  );
  try {
    await fn(server.addr.port);
  } finally {
    await server.shutdown();
  }
}

Deno.test("probeStartServer: a server that answers the ping with 204 is live", async () => {
  const seen: Array<string | null> = [];
  await withServer((req) => {
    seen.push(req.headers.get(START_PING_TOKEN_HEADER));
    return new URL(req.url).pathname === "/start/ping"
      ? new Response(null, { status: 204 })
      : new Response("Not found", { status: 404 });
  }, async (port) => {
    assertEquals(await probeStartServer(record(port)), "live");
  });
  assertEquals(seen, [TOKEN]);
});

Deno.test("probeStartServer: any other status means something else owns the port", async () => {
  for (const status of [401, 404, 500]) {
    await withServer(() => new Response("no", { status }), async (port) => {
      assertEquals(await probeStartServer(record(port)), "dead", `${status}`);
    });
  }
});

Deno.test("probeStartServer: a closed port is dead", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  assertEquals(await probeStartServer(record(port)), "dead");
});

Deno.test("probeStartServer: a ping that times out is unknown", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await withServer(async () => {
    await held;
    return new Response(null, { status: 204 });
  }, async (port) => {
    try {
      assertEquals(
        await probeStartServer(record(port), { timeoutMs: 50 }),
        "unknown",
      );
    } finally {
      release();
    }
  });
});

Deno.test({
  name:
    "probeStartServer: a record whose process is gone is dead without a ping",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    let pinged = 0;
    await withServer(() => {
      pinged++;
      return new Response(null, { status: 204 });
    }, async (port) => {
      // Far above any pid the OS hands out.
      assertEquals(await probeStartServer(record(port, 0x3fffffff)), "dead");
    });
    assertEquals(pinged, 0);
  },
});

Deno.test("probeStartServer: on Windows the ping alone decides", async () => {
  await withServer(
    () => new Response(null, { status: 204 }),
    async (port) => {
      assertEquals(
        await probeStartServer(record(port, 0x3fffffff), { os: "windows" }),
        "live",
      );
    },
  );
});

Deno.test("startProbeTimeoutMs: Windows waits out its retries on a refused connect", () => {
  assertEquals(startProbeTimeoutMs("windows"), WINDOWS_START_PROBE_TIMEOUT_MS);
  assertEquals(startProbeTimeoutMs("linux"), START_PROBE_TIMEOUT_MS);
  assertEquals(startProbeTimeoutMs("darwin"), START_PROBE_TIMEOUT_MS);
  // Windows takes about two seconds to report a refused loopback connect.
  assertEquals(WINDOWS_START_PROBE_TIMEOUT_MS > 2_000, true);
});
