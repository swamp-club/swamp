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
import { SeverityNumber } from "@opentelemetry/api-logs";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import { FetchOtlpLogExporter } from "./fetch_otlp_log_exporter.ts";

/** Creates a minimal ReadableLogRecord stub for testing. */
function makeLogRecord(body: string): ReadableLogRecord {
  return {
    hrTime: [1719000000, 0],
    hrTimeObserved: [1719000000, 0],
    severityNumber: SeverityNumber.INFO,
    severityText: "INFO",
    body,
    attributes: {},
    droppedAttributesCount: 0,
    resource: { attributes: {}, merge: () => null },
    instrumentationScope: {
      name: "swamp",
      version: "dev",
      schemaUrl: undefined,
    },
    spanContext: {
      traceId: "0af7651916cd43dd8448eb211c80319c",
      spanId: "b7ad6b7169203331",
      traceFlags: 1,
    },
  } as unknown as ReadableLogRecord;
}

/** Helper to call export and await the result via callback. */
function exportAndAwait(
  exporter: FetchOtlpLogExporter,
  logs: ReadableLogRecord[],
): Promise<ExportResult> {
  return new Promise((resolve) => {
    exporter.export(logs, resolve);
  });
}

Deno.test("FetchOtlpLogExporter: POSTs records to /v1/logs with the configured headers", async () => {
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
    const exporter = new FetchOtlpLogExporter({
      url: "https://api.honeycomb.io/v1/logs",
      headers: { "x-honeycomb-team": "test-key" },
    });

    const result = await exportAndAwait(exporter, [makeLogRecord("hello")]);

    assertEquals(result.code, ExportResultCode.SUCCESS);
    assertEquals(requests.length, 1);
    assertEquals(requests[0].url, "https://api.honeycomb.io/v1/logs");
    assertEquals(requests[0].headers.get("content-type"), "application/json");
    assertEquals(requests[0].headers.get("x-honeycomb-team"), "test-key");
    assertEquals(requests[0].body.length > 0, true);

    await exporter.shutdown();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("FetchOtlpLogExporter: HTTP error responses still report the send as complete", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (): Promise<Response> =>
    Promise.resolve(new Response("Internal Server Error", { status: 500 }));

  try {
    const exporter = new FetchOtlpLogExporter({ url: "https://x/v1/logs" });
    const result = await exportAndAwait(exporter, [makeLogRecord("fail")]);
    // The request completed; the exporter's job is to send, not retry.
    assertEquals(result.code, ExportResultCode.SUCCESS);
    await exporter.shutdown();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("FetchOtlpLogExporter: network errors are swallowed and report FAILED", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (): Promise<Response> =>
    Promise.reject(new Error("Network unreachable"));

  try {
    const exporter = new FetchOtlpLogExporter({ url: "https://x/v1/logs" });
    const result = await exportAndAwait(exporter, [makeLogRecord("err")]);
    assertEquals(result.code, ExportResultCode.FAILED);
    await exporter.shutdown();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("FetchOtlpLogExporter: returns FAILED and does not fetch after shutdown", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (): Promise<Response> => {
    fetchCalled = true;
    return Promise.resolve(new Response(null, { status: 200 }));
  };

  try {
    const exporter = new FetchOtlpLogExporter({ url: "https://x/v1/logs" });
    await exporter.shutdown();
    const result = await exportAndAwait(exporter, [makeLogRecord("after")]);
    assertEquals(result.code, ExportResultCode.FAILED);
    assertEquals(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("FetchOtlpLogExporter: respects timeout via AbortController", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });

  try {
    const exporter = new FetchOtlpLogExporter({
      url: "https://x/v1/logs",
      timeoutMs: 50,
    });
    const result = await exportAndAwait(exporter, [makeLogRecord("slow")]);
    assertEquals(result.code, ExportResultCode.FAILED);
    await exporter.shutdown();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("FetchOtlpLogExporter: shutdown() drains an in-flight send before resolving", async () => {
  const originalFetch = globalThis.fetch;
  let sendCompleted = false;
  let releaseNetwork = (): void => {};
  const network = new Promise<void>((resolve) => {
    releaseNetwork = resolve;
  });

  globalThis.fetch = async (): Promise<Response> => {
    await network; // block until released
    sendCompleted = true;
    return new Response(null, { status: 200 });
  };

  try {
    const exporter = new FetchOtlpLogExporter({ url: "https://x/v1/logs" });
    // Kick off an export; the send is now in-flight and blocked.
    exporter.export([makeLogRecord("draining")], () => {});

    let shutdownResolved = false;
    const shutdownPromise = exporter.shutdown().then(() => {
      shutdownResolved = true;
    });

    // Give microtasks a chance — shutdown must still be pending while the
    // network is blocked, proving it awaits the in-flight send.
    await new Promise((r) => setTimeout(r, 20));
    assertEquals(shutdownResolved, false);
    assertEquals(sendCompleted, false);

    releaseNetwork();
    await shutdownPromise;

    assertEquals(shutdownResolved, true);
    assertEquals(sendCompleted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
