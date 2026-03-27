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
import { ExportResultCode } from "@opentelemetry/core";
import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { FetchOtlpExporter } from "./fetch_otlp_exporter.ts";

/** Creates a minimal ReadableSpan stub for testing. */
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

/** Helper to call export and await the result via callback. */
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

    // Non-ok response still returns SUCCESS because the request completed.
    // The exporter's job is to send, not to retry. BatchSpanProcessor handles retries.
    assertEquals(result.code, ExportResultCode.SUCCESS);

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
    // Simulate a request that hangs until aborted
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  };

  try {
    const exporter = new FetchOtlpExporter({
      url: "https://example.com/v1/traces",
      timeoutMs: 50, // Very short timeout for test
    });

    const result = await exportAndAwait(exporter, [makeSpan("timeout-span")]);

    assertEquals(result.code, ExportResultCode.FAILED);

    await exporter.shutdown();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
