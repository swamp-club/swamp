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

import { assertEquals, assertExists } from "@std/assert";
import { propagation, trace } from "@opentelemetry/api";
import { initTracing, shutdownTracing } from "./otel_init.ts";

Deno.test("initTracing: no-op when no endpoint is set", async () => {
  const original = Deno.env.get("OTEL_EXPORTER_OTLP_ENDPOINT");
  const originalSpecific = Deno.env.get(
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  );
  const originalExporter = Deno.env.get("OTEL_TRACES_EXPORTER");
  try {
    Deno.env.delete("OTEL_EXPORTER_OTLP_ENDPOINT");
    Deno.env.delete("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT");
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
    if (originalSpecific) {
      Deno.env.set("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", originalSpecific);
    }
    if (originalExporter) {
      Deno.env.set("OTEL_TRACES_EXPORTER", originalExporter);
    }
  }
});

Deno.test("initTracing: initializes from the signal-specific traces endpoint", async () => {
  const keys = [
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_TRACES_EXPORTER",
  ];
  const saved = new Map(keys.map((key) => [key, Deno.env.get(key)]));
  try {
    for (const key of keys) Deno.env.delete(key);
    Deno.env.set(
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
      "http://localhost:4318/v1/traces",
    );

    await initTracing();

    const span = trace.getTracer("test").startSpan("specific-endpoint");
    assertEquals(
      span.spanContext().traceId !== "00000000000000000000000000000000",
      true,
    );
    span.end();
  } finally {
    await shutdownTracing();
    for (const [key, value] of saved) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
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

Deno.test("initTracing: includes OTEL_RESOURCE_ATTRIBUTES in resource", async () => {
  const originalResAttrs = Deno.env.get("OTEL_RESOURCE_ATTRIBUTES");
  try {
    Deno.env.set(
      "OTEL_RESOURCE_ATTRIBUTES",
      "site=bed,deployment.environment=prod",
    );

    const { Resource, envDetectorSync } = await import(
      "@opentelemetry/resources"
    );
    const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = await import(
      "@opentelemetry/semantic-conventions"
    );

    const resource = Resource.default()
      .merge(envDetectorSync.detect())
      .merge(
        new Resource({
          [ATTR_SERVICE_NAME]: "swamp-test",
          [ATTR_SERVICE_VERSION]: "1.0.0",
        }),
      );

    const attrs = resource.attributes;
    assertEquals(attrs["site"], "bed");
    assertEquals(attrs["deployment.environment"], "prod");
    assertEquals(attrs["service.name"], "swamp-test");
    assertEquals(attrs["service.version"], "1.0.0");
    assertEquals(attrs["telemetry.sdk.language"], "nodejs");
  } finally {
    if (originalResAttrs) {
      Deno.env.set("OTEL_RESOURCE_ATTRIBUTES", originalResAttrs);
    } else {
      Deno.env.delete("OTEL_RESOURCE_ATTRIBUTES");
    }
  }
});

Deno.test("initTracing: explicit service.name wins over OTEL_RESOURCE_ATTRIBUTES", async () => {
  const originalResAttrs = Deno.env.get("OTEL_RESOURCE_ATTRIBUTES");
  try {
    Deno.env.set("OTEL_RESOURCE_ATTRIBUTES", "service.name=from-env");

    const { Resource, envDetectorSync } = await import(
      "@opentelemetry/resources"
    );
    const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = await import(
      "@opentelemetry/semantic-conventions"
    );

    const resource = Resource.default()
      .merge(envDetectorSync.detect())
      .merge(
        new Resource({
          [ATTR_SERVICE_NAME]: "swamp",
          [ATTR_SERVICE_VERSION]: "dev",
        }),
      );

    assertEquals(resource.attributes["service.name"], "swamp");
  } finally {
    if (originalResAttrs) {
      Deno.env.set("OTEL_RESOURCE_ATTRIBUTES", originalResAttrs);
    } else {
      Deno.env.delete("OTEL_RESOURCE_ATTRIBUTES");
    }
  }
});

Deno.test("shutdownTracing: no-op when tracing was not initialized", async () => {
  // Should not throw
  await shutdownTracing();
});
