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
import { ExportResultCode } from "@opentelemetry/core";
import type { ExportResult } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { withMockedFetch } from "@swamp-club/swamp-testing";
import { FetchOtlpExporter } from "./fetch_otlp_exporter.ts";

function makeSpan(name: string): ReadableSpan {
  return {
    name,
    kind: 0,
    spanContext: () => ({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: 1,
    }),
    parentSpanId: undefined,
    startTime: [1719000000, 0],
    endTime: [1719000001, 0],
    status: { code: 0 },
    attributes: {},
    links: [],
    events: [],
    duration: [1, 0],
    ended: true,
    resource: {
      attributes: {},
      merge: () => null,
    },
    instrumentationLibrary: { name: "test", version: "0.0.0" },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  } as unknown as ReadableSpan;
}

function exportAndAwait(
  exporter: FetchOtlpExporter,
  spans: ReadableSpan[],
): Promise<ExportResult> {
  return new Promise((resolve) => {
    exporter.export(spans, resolve);
  });
}

Deno.test("FetchOtlpExporter: sends spans to the configured URL with correct headers", async () => {
  const requests: { url: string; headers: Headers; body: Uint8Array }[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    requests.push({
      url,
      headers: new Headers(init?.headers as HeadersInit),
      body: new Uint8Array(init?.body as ArrayBuffer),
    });
    return Promise.resolve(new Response(null, { status: 200 }));
  };

  try {
    const exporter = new FetchOtlpExporter({
      url: "https://api.honeycomb.io/v1/traces",
      headers: { "x-honeycomb-team": "test-key" },
    });

    const result = await exportAndAwait(exporter, [makeSpan("test-span")]);

    assertEquals(result.code, ExportResultCode.SUCCESS);
    assertEquals(requests.length, 1);
    assertEquals(requests[0].url, "https://api.honeycomb.io/v1/traces");
    assertEquals(requests[0].headers.get("content-type"), "application/json");
    assertEquals(requests[0].headers.get("x-honeycomb-team"), "test-key");
    assertEquals(requests[0].body.length > 0, true);

    await exporter.shutdown();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("FetchOtlpExporter: returns FAILED on HTTP error responses", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (): Promise<Response> => {
    return Promise.resolve(
      new Response("Internal Server Error", { status: 500 }),
    );
  };

  try {
    const exporter = new FetchOtlpExporter({
      url: "https://example.com/v1/traces",
    });

    const result = await exportAndAwait(exporter, [makeSpan("fail-span")]);

    // A completed HTTP exchange is not collector acceptance.
    assertEquals(result.code, ExportResultCode.FAILED);

    await exporter.shutdown();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("FetchOtlpExporter: returns FAILED on network error", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (): Promise<Response> => {
    return Promise.reject(new Error("Network unreachable"));
  };

  try {
    const exporter = new FetchOtlpExporter({
      url: "https://example.com/v1/traces",
    });

    const result = await exportAndAwait(exporter, [makeSpan("error-span")]);

    assertEquals(result.code, ExportResultCode.FAILED);

    await exporter.shutdown();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("FetchOtlpExporter: returns FAILED after shutdown", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;

  globalThis.fetch = (): Promise<Response> => {
    fetchCalled = true;
    return Promise.resolve(new Response(null, { status: 200 }));
  };

  try {
    const exporter = new FetchOtlpExporter({
      url: "https://example.com/v1/traces",
    });

    await exporter.shutdown();

    const result = await exportAndAwait(exporter, [makeSpan("post-shutdown")]);

    assertEquals(result.code, ExportResultCode.FAILED);
    assertEquals(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("FetchOtlpExporter: respects timeout via AbortController", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (
    _input: string | URL | Request,
    init?: RequestInit,
  ) => {
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  };

  try {
    const exporter = new FetchOtlpExporter({
      url: "https://example.com/v1/traces",
      timeoutMs: 50,
    });

    const result = await exportAndAwait(exporter, [makeSpan("timeout-span")]);

    assertEquals(result.code, ExportResultCode.FAILED);

    await exporter.shutdown();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("FetchOtlpExporter: shutdown waits for an in-flight send", async () => {
  const originalFetch = globalThis.fetch;
  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  globalThis.fetch = async (): Promise<Response> => {
    await fetchGate;
    return new Response(null, { status: 200 });
  };

  try {
    const exporter = new FetchOtlpExporter({
      url: "https://example.com/v1/traces",
    });
    const order: string[] = [];
    // The last span a process ends: exported, then shut down before the
    // send completes, as main.ts does right before Deno.exit.
    exporter.export([makeSpan("swamp.cli")], (result) => {
      order.push(`exported:${result.code}`);
    });
    const shutdown = exporter.shutdown().then(() => order.push("shutdown"));
    await Promise.resolve();
    assertEquals(order, []);

    releaseFetch();
    await shutdown;
    assertEquals(order, [`exported:${ExportResultCode.SUCCESS}`, "shutdown"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/** a collector that accepts each request and never answers */
function silentCollector(
  seen: { calls: number; open: number; maxOpen: number },
) {
  return (request: Request): Promise<Response> => {
    seen.calls++;
    seen.open++;
    seen.maxOpen = Math.max(seen.maxOpen, seen.open);
    return new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => {
        seen.open--;
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  };
}

Deno.test("FetchOtlpExporter: a collector that never answers gets one request at a time however many spans end", async () => {
  const seen = { calls: 0, open: 0, maxOpen: 0 };
  await withMockedFetch(silentCollector(seen), async () => {
    const exporter = new FetchOtlpExporter({
      url: "https://example.com/v1/traces",
      timeoutMs: 200,
    });
    const results: ExportResult[] = [];
    for (let i = 0; i < 200; i++) {
      exporter.export(
        [makeSpan(`step-${i}`)],
        (result) => results.push(result),
      );
    }

    await exporter.shutdown();

    assertEquals(seen.maxOpen, 1);
    assertEquals(results.length, 200);
    assertEquals(
      results.every((result) => result.code === ExportResultCode.FAILED),
      true,
    );
  });
});

Deno.test("FetchOtlpExporter: spans dropped against a silent collector print nothing", async () => {
  const seen = { calls: 0, open: 0, maxOpen: 0 };
  const printed: unknown[] = [];
  const original = {
    error: console.error,
    warn: console.warn,
    log: console.log,
    debug: console.debug,
  };
  console.error =
    console.warn =
    console.log =
    console.debug =
      (
        ...args: unknown[]
      ) => printed.push(args);
  try {
    await withMockedFetch(silentCollector(seen), async () => {
      const exporter = new FetchOtlpExporter({
        url: "https://example.com/v1/traces",
        timeoutMs: 200,
      });
      const provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });
      const tracer = provider.getTracer("test");
      for (let i = 0; i < 3_000; i++) tracer.startSpan(`step-${i}`).end();
      await provider.shutdown();
    });
  } finally {
    Object.assign(console, original);
  }

  assertEquals(printed, []);
  assertEquals(seen.maxOpen, 1);
});
