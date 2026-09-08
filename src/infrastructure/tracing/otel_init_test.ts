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
  const parentCtx = await initTracing({ exporterKind: "otlp" });
  assertEquals(parentCtx, undefined);

  const tracer = trace.getTracer("test");
  const span = tracer.startSpan("test-span");
  const ctx = span.spanContext();
  assertEquals(ctx.traceId, "00000000000000000000000000000000");
  span.end();

  await shutdownTracing();
});

Deno.test("initTracing: initializes from an endpoint passed via config", async () => {
  try {
    await initTracing({
      endpoint: "http://localhost:4318",
    });

    const span = trace.getTracer("test").startSpan("specific-endpoint");
    assertEquals(
      span.spanContext().traceId !== "00000000000000000000000000000000",
      true,
    );
    span.end();
  } finally {
    await shutdownTracing();
  }
});

Deno.test("initTracing: initializes when exporterKind is console", async () => {
  try {
    await initTracing({ exporterKind: "console" });

    const tracer = trace.getTracer("test");
    const span = tracer.startSpan("test-span");
    const ctx = span.spanContext();
    assertEquals(ctx.traceId !== "00000000000000000000000000000000", true);
    span.end();

    await shutdownTracing();
  } finally {
    await shutdownTracing();
  }
});

Deno.test("initTracing: W3C propagator is registered (inject/extract roundtrip)", async () => {
  try {
    await initTracing({ exporterKind: "console" });

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
    await shutdownTracing();
  }
});

Deno.test("initTracing: extracts inbound traceparent from config", async () => {
  try {
    const parentCtx = await initTracing({
      exporterKind: "console",
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
    });
    assertExists(parentCtx);

    await shutdownTracing();
  } finally {
    await shutdownTracing();
  }
});

Deno.test("initTracing: returns undefined when no traceparent is set", async () => {
  try {
    const parentCtx = await initTracing({ exporterKind: "console" });
    assertEquals(parentCtx, undefined);

    await shutdownTracing();
  } finally {
    await shutdownTracing();
  }
});

Deno.test("initTracing: resource includes attributes from detector merge", async () => {
  const { Resource } = await import("@opentelemetry/resources");
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = await import(
    "@opentelemetry/semantic-conventions"
  );
  const { buildOtelResource } = await import("./otel_resource.ts");

  const stubDetector = {
    detect: () =>
      new Resource({
        "site": "bed",
        "deployment.environment": "prod",
      }),
  };

  const resource = buildOtelResource(
    Resource,
    stubDetector,
    {
      serviceNameAttr: ATTR_SERVICE_NAME,
      serviceVersionAttr: ATTR_SERVICE_VERSION,
    },
    () => undefined,
  );

  const attrs = resource.attributes;
  assertEquals(attrs["site"], "bed");
  assertEquals(attrs["deployment.environment"], "prod");
  assertEquals(attrs["service.name"], "swamp");
  assertEquals(attrs["service.version"], "dev");
  assertEquals(attrs["telemetry.sdk.language"], "nodejs");
});

Deno.test("initTracing: explicit service.name wins over detector attributes", async () => {
  const { Resource } = await import("@opentelemetry/resources");
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = await import(
    "@opentelemetry/semantic-conventions"
  );
  const { buildOtelResource } = await import("./otel_resource.ts");

  const stubDetector = {
    detect: () => new Resource({ "service.name": "from-detector" }),
  };

  const resource = buildOtelResource(
    Resource,
    stubDetector,
    {
      serviceNameAttr: ATTR_SERVICE_NAME,
      serviceVersionAttr: ATTR_SERVICE_VERSION,
    },
    () => undefined,
  );

  assertEquals(resource.attributes["service.name"], "swamp");
});

Deno.test("shutdownTracing: no-op when tracing was not initialized", async () => {
  await shutdownTracing();
});
