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

import { assertEquals, assertExists } from "@std/assert";
import { propagation, trace } from "@opentelemetry/api";
import { initTracing, shutdownTracing } from "./otel_init.ts";

Deno.test("initTracing: no-op when OTEL_EXPORTER_OTLP_ENDPOINT is not set", async () => {
  // Ensure env var is not set
  const original = Deno.env.get("OTEL_EXPORTER_OTLP_ENDPOINT");
  const originalExporter = Deno.env.get("OTEL_TRACES_EXPORTER");
  try {
    Deno.env.delete("OTEL_EXPORTER_OTLP_ENDPOINT");
    Deno.env.delete("OTEL_TRACES_EXPORTER");

    const parentCtx = await initTracing();
    assertEquals(parentCtx, undefined);

    // Tracer should return a no-op tracer (no provider registered)
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("test-span");
    // No-op spans have an invalid (all-zeros) span context
    const ctx = span.spanContext();
    assertEquals(ctx.traceId, "00000000000000000000000000000000");
    span.end();

    await shutdownTracing();
  } finally {
    if (original) Deno.env.set("OTEL_EXPORTER_OTLP_ENDPOINT", original);
    if (originalExporter) {
      Deno.env.set("OTEL_TRACES_EXPORTER", originalExporter);
    }
  }
});

Deno.test("initTracing: initializes when OTEL_TRACES_EXPORTER=console", async () => {
  const originalEndpoint = Deno.env.get("OTEL_EXPORTER_OTLP_ENDPOINT");
  const originalExporter = Deno.env.get("OTEL_TRACES_EXPORTER");
  try {
    Deno.env.delete("OTEL_EXPORTER_OTLP_ENDPOINT");
    Deno.env.set("OTEL_TRACES_EXPORTER", "console");

    await initTracing();

    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("test-span");
    const ctx = span.spanContext();
    // When initialized, trace ID should not be all zeros
    assertEquals(ctx.traceId !== "00000000000000000000000000000000", true);
    span.end();

    await shutdownTracing();
  } finally {
    if (originalEndpoint) {
      Deno.env.set("OTEL_EXPORTER_OTLP_ENDPOINT", originalEndpoint);
    }
    if (originalExporter) {
      Deno.env.set("OTEL_TRACES_EXPORTER", originalExporter);
    } else {
      Deno.env.delete("OTEL_TRACES_EXPORTER");
    }
  }
});

Deno.test("initTracing: W3C propagator is registered (inject/extract roundtrip)", async () => {
  const originalEndpoint = Deno.env.get("OTEL_EXPORTER_OTLP_ENDPOINT");
  const originalExporter = Deno.env.get("OTEL_TRACES_EXPORTER");
  try {
    Deno.env.delete("OTEL_EXPORTER_OTLP_ENDPOINT");
    Deno.env.set("OTEL_TRACES_EXPORTER", "console");

    await initTracing();

    const carrier: Record<string, string> = {};
    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("roundtrip");
    const { context } = await import("@opentelemetry/api");
    const activeCtx = trace.setSpan(context.active(), span);
    propagation.inject(activeCtx, carrier);
    span.end();

    assertEquals(typeof carrier.traceparent, "string");
    assertEquals(carrier.traceparent.startsWith("00-"), true);

    await shutdownTracing();
  } finally {
    if (originalEndpoint) {
      Deno.env.set("OTEL_EXPORTER_OTLP_ENDPOINT", originalEndpoint);
    }
    if (originalExporter) {
      Deno.env.set("OTEL_TRACES_EXPORTER", originalExporter);
    } else {
      Deno.env.delete("OTEL_TRACES_EXPORTER");
    }
  }
});

Deno.test("initTracing: extracts inbound TRACEPARENT from environment", async () => {
  const originalEndpoint = Deno.env.get("OTEL_EXPORTER_OTLP_ENDPOINT");
  const originalExporter = Deno.env.get("OTEL_TRACES_EXPORTER");
  const originalTraceparent = Deno.env.get("TRACEPARENT");
  try {
    Deno.env.delete("OTEL_EXPORTER_OTLP_ENDPOINT");
    Deno.env.set("OTEL_TRACES_EXPORTER", "console");
    Deno.env.set(
      "TRACEPARENT",
      "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    );

    const parentCtx = await initTracing();
    assertExists(parentCtx);

    await shutdownTracing();
  } finally {
    if (originalEndpoint) {
      Deno.env.set("OTEL_EXPORTER_OTLP_ENDPOINT", originalEndpoint);
    }
    if (originalExporter) {
      Deno.env.set("OTEL_TRACES_EXPORTER", originalExporter);
    } else {
      Deno.env.delete("OTEL_TRACES_EXPORTER");
    }
    if (originalTraceparent) {
      Deno.env.set("TRACEPARENT", originalTraceparent);
    } else {
      Deno.env.delete("TRACEPARENT");
    }
  }
});

Deno.test("initTracing: returns undefined when no TRACEPARENT is set", async () => {
  const originalEndpoint = Deno.env.get("OTEL_EXPORTER_OTLP_ENDPOINT");
  const originalExporter = Deno.env.get("OTEL_TRACES_EXPORTER");
  const originalTraceparent = Deno.env.get("TRACEPARENT");
  try {
    Deno.env.delete("OTEL_EXPORTER_OTLP_ENDPOINT");
    Deno.env.set("OTEL_TRACES_EXPORTER", "console");
    Deno.env.delete("TRACEPARENT");

    const parentCtx = await initTracing();
    assertEquals(parentCtx, undefined);

    await shutdownTracing();
  } finally {
    if (originalEndpoint) {
      Deno.env.set("OTEL_EXPORTER_OTLP_ENDPOINT", originalEndpoint);
    }
    if (originalExporter) {
      Deno.env.set("OTEL_TRACES_EXPORTER", originalExporter);
    } else {
      Deno.env.delete("OTEL_TRACES_EXPORTER");
    }
    if (originalTraceparent) {
      Deno.env.set("TRACEPARENT", originalTraceparent);
    } else {
      Deno.env.delete("TRACEPARENT");
    }
  }
});

Deno.test("shutdownTracing: no-op when tracing was not initialized", async () => {
  // Should not throw
  await shutdownTracing();
});
