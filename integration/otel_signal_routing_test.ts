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
import { join, toFileUrl } from "@std/path";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

const ROOT = join(import.meta.dirname!, "..");
const DENO_CONFIG = join(ROOT, "deno.json");
const LOGGER_MODULE = toFileUrl(
  join(ROOT, "src", "infrastructure", "logging", "logger.ts"),
).href;
const TRACING_MODULE = toFileUrl(
  join(ROOT, "src", "infrastructure", "tracing", "mod.ts"),
).href;

function childEnvironment(
  otel: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {
    SWAMP_NO_TELEMETRY: "1",
    NO_COLOR: "1",
    ...otel,
  };
  for (
    const key of [
      "PATH",
      "HOME",
      "DENO_DIR",
      "TMPDIR",
      "USERPROFILE",
      "SystemRoot",
    ]
  ) {
    const value = Deno.env.get(key);
    if (value) env[key] = value;
  }
  return env;
}

async function emitTelemetry(env: Record<string, string>): Promise<void> {
  const script = `
import { getSwampLogger, initializeLogging } from ${
    JSON.stringify(LOGGER_MODULE)
  };
import { initTracing, shutdownLogs, shutdownTracing, withSpan } from ${
    JSON.stringify(TRACING_MODULE)
  };

await initTracing();
await initializeLogging({ jsonMode: true });
const logger = getSwampLogger(["integration", "otel-routing"]);
await withSpan("swamp.integration.otel-routing", {}, () => {
  logger.info\`otel routing integration marker\`;
  return Promise.resolve();
});
await shutdownLogs();
await shutdownTracing();
`;

  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--config",
      DENO_CONFIG,
      "--allow-env",
      "--allow-read",
      "--allow-net=127.0.0.1",
      "-",
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    clearEnv: true,
    env: childEnvironment(env),
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(script));
  await writer.close();

  const output = await child.output();
  if (!output.success) {
    throw new Error(
      `telemetry child failed: ${new TextDecoder().decode(output.stderr)}`,
    );
  }
}

async function withCollector(
  run: (baseUrl: string, captured: CapturedRequest[]) => Promise<void>,
): Promise<void> {
  const captured: CapturedRequest[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (request) => {
      captured.push({
        url: request.url,
        method: request.method,
        headers: new Headers(request.headers),
        body: await request.text(),
      });
      return new Response(null, { status: 200 });
    },
  );
  const port = (server.addr as Deno.NetAddr).port;
  try {
    await run(`http://127.0.0.1:${port}`, captured);
  } finally {
    await server.shutdown();
  }
}

function requestFor(
  captured: CapturedRequest[],
  url: string,
): CapturedRequest {
  const request = captured.find((candidate) => candidate.url === url);
  assert(request, `no OTLP request captured for ${url}`);
  return request;
}

Deno.test("OTLP signal routing: signal-specific endpoints and headers override generic configuration", async () => {
  await withCollector(async (baseUrl, captured) => {
    const tracesUrl = `${baseUrl}/custom/trace-ingest`;
    const logsUrl = `${baseUrl}/custom/log-ingest`;
    await emitTelemetry({
      OTEL_EXPORTER_OTLP_ENDPOINT: `${baseUrl}/generic-decoy`,
      OTEL_EXPORTER_OTLP_HEADERS: "x-generic=generic,x-shared=generic",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: tracesUrl,
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "x-trace-only=trace,x-shared=trace",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: logsUrl,
      OTEL_EXPORTER_OTLP_LOGS_HEADERS: "x-log-only=log,x-shared=log",
    });

    assertEquals(
      new Set(captured.map((request) => request.url)),
      new Set([tracesUrl, logsUrl]),
    );

    const traces = requestFor(captured, tracesUrl);
    assertEquals(traces.method, "POST");
    assertEquals(traces.headers.get("x-trace-only"), "trace");
    assertEquals(traces.headers.get("x-shared"), "trace");
    assertEquals(traces.headers.get("x-generic"), null);
    assertEquals(traces.headers.get("x-log-only"), null);
    assertEquals(traces.headers.get("content-type"), "application/json");
    assertStringIncludes(traces.body, "resourceSpans");
    assertStringIncludes(traces.body, "swamp.integration.otel-routing");

    const logs = requestFor(captured, logsUrl);
    assertEquals(logs.method, "POST");
    assertEquals(logs.headers.get("x-log-only"), "log");
    assertEquals(logs.headers.get("x-shared"), "log");
    assertEquals(logs.headers.get("x-generic"), null);
    assertEquals(logs.headers.get("x-trace-only"), null);
    assertEquals(logs.headers.get("content-type"), "application/json");
    assertStringIncludes(logs.body, "resourceLogs");
    assertStringIncludes(logs.body, "otel routing integration marker");
  });
});

Deno.test("OTLP signal routing: generic endpoint and headers retain existing behavior", async () => {
  await withCollector(async (baseUrl, captured) => {
    await emitTelemetry({
      OTEL_EXPORTER_OTLP_ENDPOINT: `${baseUrl}/collector///`,
      OTEL_EXPORTER_OTLP_HEADERS:
        "Authorization=Bearer generic-token,x-shared=generic",
    });

    const tracesUrl = `${baseUrl}/collector/v1/traces`;
    const logsUrl = `${baseUrl}/collector/v1/logs`;
    assertEquals(
      new Set(captured.map((request) => request.url)),
      new Set([tracesUrl, logsUrl]),
    );

    const traces = requestFor(captured, tracesUrl);
    const logs = requestFor(captured, logsUrl);
    for (const request of [traces, logs]) {
      assertEquals(request.method, "POST");
      assertEquals(
        request.headers.get("authorization"),
        "Bearer generic-token",
      );
      assertEquals(request.headers.get("x-shared"), "generic");
      assertEquals(request.headers.get("content-type"), "application/json");
    }
    assertStringIncludes(traces.body, "resourceSpans");
    assertStringIncludes(logs.body, "resourceLogs");
  });
});
