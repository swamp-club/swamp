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
import { parseOtlpHeaders, resolveOtlpEndpoint } from "./otel_config.ts";

const SIGNALS = ["traces", "logs", "metrics"] as const;

function fakeEnv(
  vars: Record<string, string>,
): (key: string) => string | undefined {
  return (key: string) => vars[key];
}

Deno.test("resolveOtlpEndpoint: signal-specific endpoints take precedence and remain complete URLs", () => {
  for (const signal of SIGNALS) {
    const specific = `https://${signal}.example/custom/`;
    const env = fakeEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example/base",
      [`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`]: specific,
    });
    assertEquals(resolveOtlpEndpoint(signal, undefined, env), specific);
  }
});

Deno.test("resolveOtlpEndpoint: appends the signal path to the generic endpoint", () => {
  for (const signal of SIGNALS) {
    const env = fakeEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example/base///",
    });
    assertEquals(
      resolveOtlpEndpoint(signal, undefined, env),
      `https://collector.example/base/v1/${signal}`,
    );
  }
});

Deno.test("resolveOtlpEndpoint: empty signal-specific endpoints fall back to generic", () => {
  for (const signal of SIGNALS) {
    const env = fakeEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example",
      [`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`]: "",
    });
    assertEquals(
      resolveOtlpEndpoint(signal, undefined, env),
      `https://collector.example/v1/${signal}`,
    );
  }
});

Deno.test("resolveOtlpEndpoint: returns undefined when no endpoint is set", () => {
  const env = fakeEnv({});
  for (const signal of SIGNALS) {
    assertEquals(resolveOtlpEndpoint(signal, undefined, env), undefined);
  }
});

Deno.test("resolveOtlpEndpoint: preserves query parameters when appending signal path", () => {
  for (const signal of SIGNALS) {
    const env = fakeEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT:
        "https://collector.example/otlp?token=secret",
    });
    assertEquals(
      resolveOtlpEndpoint(signal, undefined, env),
      `https://collector.example/otlp/v1/${signal}?token=secret`,
    );
  }
});

Deno.test("resolveOtlpEndpoint: preserves fragment when appending signal path", () => {
  for (const signal of SIGNALS) {
    const env = fakeEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example/otlp#section",
    });
    assertEquals(
      resolveOtlpEndpoint(signal, undefined, env),
      `https://collector.example/otlp/v1/${signal}#section`,
    );
  }
});

Deno.test("resolveOtlpEndpoint: preserves both query and fragment when appending signal path", () => {
  for (const signal of SIGNALS) {
    const env = fakeEnv({
      OTEL_EXPORTER_OTLP_ENDPOINT:
        "https://collector.example/otlp?token=secret#section",
    });
    assertEquals(
      resolveOtlpEndpoint(signal, undefined, env),
      `https://collector.example/otlp/v1/${signal}?token=secret#section`,
    );
  }
});

Deno.test("resolveOtlpEndpoint: explicit config bypasses process environment", () => {
  const env = fakeEnv({
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://environment.example",
  });
  assertEquals(
    resolveOtlpEndpoint("traces", {
      genericEndpoint: "https://injected.example/",
    }, env),
    "https://injected.example/v1/traces",
  );
});

Deno.test("parseOtlpHeaders: returns an empty record when unset", () => {
  assertEquals(parseOtlpHeaders("traces", fakeEnv({})), {});
});

Deno.test("parseOtlpHeaders: returns an empty record for an empty string", () => {
  assertEquals(
    parseOtlpHeaders("traces", fakeEnv({ OTEL_EXPORTER_OTLP_HEADERS: "" })),
    {},
  );
});

Deno.test("parseOtlpHeaders: parses a single key=value pair", () => {
  assertEquals(
    parseOtlpHeaders(
      "traces",
      fakeEnv({ OTEL_EXPORTER_OTLP_HEADERS: "x-honeycomb-team=abc123" }),
    ),
    { "x-honeycomb-team": "abc123" },
  );
});

Deno.test("parseOtlpHeaders: parses multiple comma-separated pairs", () => {
  assertEquals(
    parseOtlpHeaders(
      "traces",
      fakeEnv({ OTEL_EXPORTER_OTLP_HEADERS: "a=1,b=2,c=3" }),
    ),
    { a: "1", b: "2", c: "3" },
  );
});

Deno.test("parseOtlpHeaders: trims whitespace around keys and values", () => {
  assertEquals(
    parseOtlpHeaders(
      "traces",
      fakeEnv({ OTEL_EXPORTER_OTLP_HEADERS: " a = 1 , b = 2 " }),
    ),
    { a: "1", b: "2" },
  );
});

Deno.test("parseOtlpHeaders: only the first '=' splits, so values may contain '='", () => {
  assertEquals(
    parseOtlpHeaders(
      "traces",
      fakeEnv({
        OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic dXNlcj1wYXNz=",
      }),
    ),
    { Authorization: "Basic dXNlcj1wYXNz=" },
  );
});

Deno.test("parseOtlpHeaders: drops entries with no '='", () => {
  assertEquals(
    parseOtlpHeaders(
      "traces",
      fakeEnv({
        OTEL_EXPORTER_OTLP_HEADERS: "valid=1,garbage,also-valid=2",
      }),
    ),
    { valid: "1", "also-valid": "2" },
  );
});

Deno.test("parseOtlpHeaders: splits on commas (values with literal commas are not supported per OTel spec)", () => {
  assertEquals(
    parseOtlpHeaders(
      "traces",
      fakeEnv({ OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer a,b,c" }),
    ),
    { Authorization: "Bearer a" },
  );
});

Deno.test("parseOtlpHeaders: signal-specific headers replace generic headers", () => {
  for (const signal of SIGNALS) {
    const env = fakeEnv({
      OTEL_EXPORTER_OTLP_HEADERS: "generic=1,shared=generic",
      [`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_HEADERS`]:
        "specific=1,shared=specific",
    });
    assertEquals(parseOtlpHeaders(signal, env), {
      specific: "1",
      shared: "specific",
    });
  }
});

Deno.test("parseOtlpHeaders: every signal falls back to generic headers", () => {
  const env = fakeEnv({
    OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer token",
  });
  for (const signal of SIGNALS) {
    assertEquals(parseOtlpHeaders(signal, env), {
      Authorization: "Bearer token",
    });
  }
});

Deno.test("parseOtlpHeaders: empty signal-specific headers fall back to generic", () => {
  for (const signal of SIGNALS) {
    const env = fakeEnv({
      OTEL_EXPORTER_OTLP_HEADERS: "generic=1",
      [`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_HEADERS`]: "",
    });
    assertEquals(parseOtlpHeaders(signal, env), { generic: "1" });
  }
});
