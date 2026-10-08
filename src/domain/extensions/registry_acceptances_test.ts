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
import {
  MAX_REGISTRY_ACCEPTANCES,
  parseRegistryAcceptances,
} from "./registry_acceptances.ts";

Deno.test("parseRegistryAcceptances: reads the registry shape, turning nulls into absent fields", () => {
  const parsed = parseRegistryAcceptances({
    accepted: [
      {
        rule: "credentials-sensitive-field",
        file: "models/x.ts",
        line: 12,
        reason: "the token is a placeholder",
        source: "inline",
      },
      {
        rule: "ipv4-literal",
        file: "README.txt",
        line: null,
        reason: null,
        source: "sidecar",
      },
      {
        rule: "testing-completeness",
        file: null,
        line: null,
        reason: null,
        source: "generated",
      },
    ],
    generated: { by: "gen-tool", source: "spec.yaml", commit: "abc123" },
    total: 3,
  });
  assertEquals(parsed, {
    accepted: [
      {
        rule: "credentials-sensitive-field",
        file: "models/x.ts",
        line: 12,
        reason: "the token is a placeholder",
        source: "inline",
      },
      { rule: "ipv4-literal", file: "README.txt", source: "sidecar" },
      { rule: "testing-completeness", source: "generated" },
    ],
    generated: { by: "gen-tool", source: "spec.yaml", commit: "abc123" },
    total: 3,
  });
});

Deno.test("parseRegistryAcceptances: absent, null and malformed fields declare nothing", () => {
  assertEquals(parseRegistryAcceptances(undefined), undefined);
  assertEquals(parseRegistryAcceptances(null), undefined);
  assertEquals(parseRegistryAcceptances("acceptances"), undefined);
  assertEquals(parseRegistryAcceptances([]), undefined);
  assertEquals(parseRegistryAcceptances({ accepted: "x" }), undefined);
  assertEquals(
    parseRegistryAcceptances({ accepted: [], generated: null, total: 0 }),
    undefined,
  );
});

Deno.test("parseRegistryAcceptances: drops entries without a rule or a known source", () => {
  const parsed = parseRegistryAcceptances({
    accepted: [
      { file: "models/x.ts", source: "inline" },
      { rule: "", source: "inline" },
      { rule: "a-rule", source: "somewhere" },
      { rule: 7, source: "inline" },
      "a-rule",
      null,
      { rule: "kept", line: 0, file: 3, reason: 5, source: "inline" },
    ],
    total: 7,
  });
  assertEquals(parsed, {
    accepted: [{ rule: "kept", source: "inline" }],
    total: 7,
  });
});

Deno.test("parseRegistryAcceptances: a generated declaration alone is kept, a partial one is dropped", () => {
  assertEquals(
    parseRegistryAcceptances({
      accepted: [],
      generated: { by: "gen", source: "spec", commit: "c1" },
      total: 0,
    }),
    {
      accepted: [],
      generated: { by: "gen", source: "spec", commit: "c1" },
      total: 0,
    },
  );
  assertEquals(
    parseRegistryAcceptances({
      accepted: [],
      generated: { by: "gen", source: "spec" },
      total: 0,
    }),
    undefined,
  );
});

Deno.test("parseRegistryAcceptances: a missing or too-small total falls back to the entries read", () => {
  const entry = { rule: "r", source: "inline" };
  assertEquals(
    parseRegistryAcceptances({ accepted: [entry, entry] })?.total,
    2,
  );
  assertEquals(
    parseRegistryAcceptances({ accepted: [entry, entry], total: 1 })?.total,
    2,
  );
  assertEquals(
    parseRegistryAcceptances({ accepted: [entry], total: 1.5 })?.total,
    1,
  );
  assertEquals(
    parseRegistryAcceptances({ accepted: [entry], total: 640 })?.total,
    640,
  );
});

Deno.test("parseRegistryAcceptances: keeps at most the registry's cap and counts the rest in total", () => {
  const accepted = Array.from(
    { length: MAX_REGISTRY_ACCEPTANCES + 20 },
    (_, i) => ({ rule: `rule-${i}`, source: "inline" }),
  );
  const parsed = parseRegistryAcceptances({ accepted, total: 3 });
  assertEquals(parsed?.accepted.length, MAX_REGISTRY_ACCEPTANCES);
  assertEquals(parsed?.total, MAX_REGISTRY_ACCEPTANCES + 20);
});
