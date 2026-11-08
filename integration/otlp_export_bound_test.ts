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
import { SeverityNumber } from "@opentelemetry/api-logs";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { FetchOtlpExporter } from "../src/infrastructure/tracing/fetch_otlp_exporter.ts";
import { FetchOtlpLogExporter } from "../src/infrastructure/tracing/fetch_otlp_log_exporter.ts";

interface SilentCollector extends AsyncDisposable {
  readonly url: string;
  readonly connections: () => number;
}

/** accepts every connection and never reads or answers */
function silentCollector(): SilentCollector {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const accepted: Deno.Conn[] = [];
  const accepting = (async () => {
    try {
      for await (const conn of listener) accepted.push(conn);
    } catch {
      // The listener closed.
    }
  })();
  return {
    url: `http://127.0.0.1:${listener.addr.port}`,
    connections: () => accepted.length,
    async [Symbol.asyncDispose]() {
      listener.close();
      await accepting;
      for (const conn of accepted) {
        try {
          conn.close();
        } catch {
          // Already closed by the client.
        }
      }
    },
  };
}

function endSpans(
  processor: SpanProcessor,
  count: number,
): BasicTracerProvider {
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  const tracer = provider.getTracer("otlp-export-bound");
  for (let i = 0; i < count; i++) tracer.startSpan(`step-${i}`).end();
  return provider;
}

const PROCESSORS: [string, (exporter: SpanExporter) => SpanProcessor][] = [
  ["SimpleSpanProcessor", (exporter) => new SimpleSpanProcessor(exporter)],
  [
    "BatchSpanProcessor",
    (exporter) =>
      new BatchSpanProcessor(exporter, {
        maxExportBatchSize: 64,
        scheduledDelayMillis: 1,
        exportTimeoutMillis: 100,
      }),
  ],
];

for (const [name, wrap] of PROCESSORS) {
  Deno.test(`OTLP span export (${name}): a collector that never answers holds one connection however many spans end, and shutdown gives up`, async () => {
    await using collector = silentCollector();
    const exporter = new FetchOtlpExporter({
      url: `${collector.url}/v1/traces`,
      timeoutMs: 60_000,
    });

    const provider = endSpans(wrap(exporter), 2_000);
    // BatchSpanProcessor rejects its own flush once its export timeout passes
    // and then never reaches the exporter; main.ts bounds that with a deadline.
    await provider.shutdown().catch(() => {});
    await exporter.shutdown();

    assert(
      collector.connections() <= 1,
      `${collector.connections()} connections for 2,000 spans`,
    );
  });
}

Deno.test("OTLP log export: a collector that never answers holds one connection however many records are logged, and shutdown gives up", async () => {
  await using collector = silentCollector();
  const provider = new LoggerProvider();
  provider.addLogRecordProcessor(
    new SimpleLogRecordProcessor(
      new FetchOtlpLogExporter({
        url: `${collector.url}/v1/logs`,
        timeoutMs: 60_000,
      }),
    ),
  );
  const logger = provider.getLogger("otlp-export-bound");
  for (let i = 0; i < 500; i++) {
    logger.emit({ severityNumber: SeverityNumber.INFO, body: `line ${i}` });
  }

  await provider.shutdown();

  assert(
    collector.connections() <= 1,
    `${collector.connections()} connections for 500 log records`,
  );
});

Deno.test("OTLP span export: a slow collector receives every span, batched, one request at a time", async () => {
  const seen = { requests: 0, spans: 0, open: 0, maxOpen: 0 };
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    async (request) => {
      seen.requests++;
      seen.open++;
      seen.maxOpen = Math.max(seen.maxOpen, seen.open);
      const body = await request.json() as {
        resourceSpans: { scopeSpans: { spans: unknown[] }[] }[];
      };
      for (const resource of body.resourceSpans) {
        for (const scope of resource.scopeSpans) {
          seen.spans += scope.spans.length;
        }
      }
      // Simulated collector latency, so spans keep ending while a send waits.
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.open--;
      return new Response("{}", { status: 200 });
    },
  );
  try {
    const exporter = new FetchOtlpExporter({
      url: `http://127.0.0.1:${server.addr.port}/v1/traces`,
    });

    const provider = endSpans(new SimpleSpanProcessor(exporter), 300);
    await provider.shutdown();

    assertEquals(seen.spans, 300);
    assertEquals(seen.maxOpen, 1);
    assert(seen.requests < 300, `${seen.requests} requests for 300 spans`);
  } finally {
    await server.shutdown();
  }
});

Deno.test("OTLP span export: a collector that refuses connections leaves the spans failed and shutdown prompt", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = listener.addr.port;
  listener.close();
  const exporter = new FetchOtlpExporter({
    url: `http://127.0.0.1:${port}/v1/traces`,
  });
  const results: number[] = [];
  const provider = new BasicTracerProvider({
    spanProcessors: [
      new SimpleSpanProcessor({
        export: (spans, done) =>
          exporter.export(spans, (result) => {
            results.push(result.code);
            done(result);
          }),
        shutdown: () => exporter.shutdown(),
      }),
    ],
  });
  const tracer = provider.getTracer("otlp-export-bound");
  for (let i = 0; i < 50; i++) tracer.startSpan(`step-${i}`).end();

  await provider.shutdown();

  assertEquals(results.length, 50);
  assert(results.every((code) => code !== 0));
});
