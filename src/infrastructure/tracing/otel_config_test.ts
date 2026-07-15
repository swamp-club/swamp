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
import { parseOtlpHeaders } from "./otel_config.ts";

function withHeaders(
  value: string | undefined,
  fn: () => void,
): void {
  const saved = Deno.env.get("OTEL_EXPORTER_OTLP_HEADERS");
  try {
    if (value === undefined) Deno.env.delete("OTEL_EXPORTER_OTLP_HEADERS");
    else Deno.env.set("OTEL_EXPORTER_OTLP_HEADERS", value);
    fn();
  } finally {
    if (saved === undefined) Deno.env.delete("OTEL_EXPORTER_OTLP_HEADERS");
    else Deno.env.set("OTEL_EXPORTER_OTLP_HEADERS", saved);
  }
}

Deno.test("parseOtlpHeaders: returns an empty record when unset", () => {
  withHeaders(undefined, () => {
    assertEquals(parseOtlpHeaders(), {});
  });
});

Deno.test("parseOtlpHeaders: returns an empty record for an empty string", () => {
  withHeaders("", () => {
    assertEquals(parseOtlpHeaders(), {});
  });
});

Deno.test("parseOtlpHeaders: parses a single key=value pair", () => {
  withHeaders("x-honeycomb-team=abc123", () => {
    assertEquals(parseOtlpHeaders(), { "x-honeycomb-team": "abc123" });
  });
});

Deno.test("parseOtlpHeaders: parses multiple comma-separated pairs", () => {
  withHeaders("a=1,b=2,c=3", () => {
    assertEquals(parseOtlpHeaders(), { a: "1", b: "2", c: "3" });
  });
});

Deno.test("parseOtlpHeaders: trims whitespace around keys and values", () => {
  withHeaders(" a = 1 , b = 2 ", () => {
    assertEquals(parseOtlpHeaders(), { a: "1", b: "2" });
  });
});

Deno.test("parseOtlpHeaders: only the first '=' splits, so values may contain '='", () => {
  withHeaders("Authorization=Basic dXNlcj1wYXNz=", () => {
    assertEquals(parseOtlpHeaders(), {
      Authorization: "Basic dXNlcj1wYXNz=",
    });
  });
});

Deno.test("parseOtlpHeaders: drops entries with no '='", () => {
  withHeaders("valid=1,garbage,also-valid=2", () => {
    assertEquals(parseOtlpHeaders(), { valid: "1", "also-valid": "2" });
  });
});

Deno.test("parseOtlpHeaders: splits on commas (values with literal commas are not supported per OTel spec)", () => {
  // The OTel env-var spec requires comma-containing values to be
  // percent-encoded; a raw comma is treated as a delimiter. This documents that
  // known behavior rather than endorsing it.
  withHeaders("Authorization=Bearer a,b,c", () => {
    assertEquals(parseOtlpHeaders(), { Authorization: "Bearer a" });
  });
});
