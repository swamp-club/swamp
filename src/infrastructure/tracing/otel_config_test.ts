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
const ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  ...SIGNALS.flatMap((signal) => [
    `OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`,
    `OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_HEADERS`,
  ]),
];

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void,
): void {
  const saved = new Map(ENV_KEYS.map((key) => [key, Deno.env.get(key)]));
  try {
    for (const key of ENV_KEYS) Deno.env.delete(key);
    for (const [key, value] of Object.entries(vars)) {
      if (value !== undefined) Deno.env.set(key, value);
    }
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

function withHeaders(
  value: string | undefined,
  fn: () => void,
): void {
  withEnv({ OTEL_EXPORTER_OTLP_HEADERS: value }, fn);
}

Deno.test("resolveOtlpEndpoint: signal-specific endpoints take precedence and remain complete URLs", () => {
  for (const signal of SIGNALS) {
    const specific = `https://${signal}.example/custom/`;
    withEnv(
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example/base",
        [`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`]: specific,
      },
      () => assertEquals(resolveOtlpEndpoint(signal), specific),
    );
  }
});

Deno.test("resolveOtlpEndpoint: appends the signal path to the generic endpoint", () => {
  for (const signal of SIGNALS) {
    withEnv(
      { OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example/base///" },
      () =>
        assertEquals(
          resolveOtlpEndpoint(signal),
          `https://collector.example/base/v1/${signal}`,
        ),
    );
  }
});

Deno.test("resolveOtlpEndpoint: empty signal-specific endpoints fall back to generic", () => {
  for (const signal of SIGNALS) {
    withEnv(
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example",
        [`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`]: "",
      },
      () =>
        assertEquals(
          resolveOtlpEndpoint(signal),
          `https://collector.example/v1/${signal}`,
        ),
    );
  }
});

Deno.test("resolveOtlpEndpoint: returns undefined when no endpoint is set", () => {
  for (const signal of SIGNALS) {
    withEnv({}, () => assertEquals(resolveOtlpEndpoint(signal), undefined));
  }
});

Deno.test("resolveOtlpEndpoint: explicit config bypasses process environment", () => {
  withEnv(
    { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://environment.example" },
    () =>
      assertEquals(
        resolveOtlpEndpoint("traces", {
          genericEndpoint: "https://injected.example/",
        }),
        "https://injected.example/v1/traces",
      ),
  );
});

Deno.test("parseOtlpHeaders: returns an empty record when unset", () => {
  withHeaders(undefined, () => {
    assertEquals(parseOtlpHeaders("traces"), {});
  });
});

Deno.test("parseOtlpHeaders: returns an empty record for an empty string", () => {
  withHeaders("", () => {
    assertEquals(parseOtlpHeaders("traces"), {});
  });
});

Deno.test("parseOtlpHeaders: parses a single key=value pair", () => {
  withHeaders("x-honeycomb-team=abc123", () => {
    assertEquals(parseOtlpHeaders("traces"), {
      "x-honeycomb-team": "abc123",
    });
  });
});

Deno.test("parseOtlpHeaders: parses multiple comma-separated pairs", () => {
  withHeaders("a=1,b=2,c=3", () => {
    assertEquals(parseOtlpHeaders("traces"), { a: "1", b: "2", c: "3" });
  });
});

Deno.test("parseOtlpHeaders: trims whitespace around keys and values", () => {
  withHeaders(" a = 1 , b = 2 ", () => {
    assertEquals(parseOtlpHeaders("traces"), { a: "1", b: "2" });
  });
});

Deno.test("parseOtlpHeaders: only the first '=' splits, so values may contain '='", () => {
  withHeaders("Authorization=Basic dXNlcj1wYXNz=", () => {
    assertEquals(parseOtlpHeaders("traces"), {
      Authorization: "Basic dXNlcj1wYXNz=",
    });
  });
});

Deno.test("parseOtlpHeaders: drops entries with no '='", () => {
  withHeaders("valid=1,garbage,also-valid=2", () => {
    assertEquals(parseOtlpHeaders("traces"), {
      valid: "1",
      "also-valid": "2",
    });
  });
});

Deno.test("parseOtlpHeaders: splits on commas (values with literal commas are not supported per OTel spec)", () => {
  // The OTel env-var spec requires comma-containing values to be
  // percent-encoded; a raw comma is treated as a delimiter. This documents that
  // known behavior rather than endorsing it.
  withHeaders("Authorization=Bearer a,b,c", () => {
    assertEquals(parseOtlpHeaders("traces"), {
      Authorization: "Bearer a",
    });
  });
});

Deno.test("parseOtlpHeaders: signal-specific headers replace generic headers", () => {
  for (const signal of SIGNALS) {
    withEnv(
      {
        OTEL_EXPORTER_OTLP_HEADERS: "generic=1,shared=generic",
        [`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_HEADERS`]:
          "specific=1,shared=specific",
      },
      () =>
        assertEquals(parseOtlpHeaders(signal), {
          specific: "1",
          shared: "specific",
        }),
    );
  }
});

Deno.test("parseOtlpHeaders: every signal falls back to generic headers", () => {
  for (const signal of SIGNALS) {
    withEnv(
      { OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer token" },
      () =>
        assertEquals(parseOtlpHeaders(signal), {
          Authorization: "Bearer token",
        }),
    );
  }
});

Deno.test("parseOtlpHeaders: empty signal-specific headers fall back to generic", () => {
  for (const signal of SIGNALS) {
    withEnv(
      {
        OTEL_EXPORTER_OTLP_HEADERS: "generic=1",
        [`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_HEADERS`]: "",
      },
      () => assertEquals(parseOtlpHeaders(signal), { generic: "1" }),
    );
  }
});
