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
  type DataOutputOverride,
  DataOutputOverrideSchema,
} from "./data_output_override.ts";

Deno.test("DataOutputOverrideSchema: parses a minimal override with only specName", () => {
  const result = DataOutputOverrideSchema.safeParse({ specName: "output" });

  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.specName, "output");
    assertEquals(result.data.lifetime, undefined);
    assertEquals(result.data.garbageCollection, undefined);
    assertEquals(result.data.tags, undefined);
    assertEquals(result.data.vary, undefined);
    assertEquals(result.data.vaultName, undefined);
  }
});

Deno.test("DataOutputOverrideSchema: parses a fully specified override preserving all fields", () => {
  const override: DataOutputOverride = {
    specName: "logs",
    lifetime: "30d",
    garbageCollection: 5,
    tags: { env: "prod", team: "platform" },
    vary: ["region", "account"],
    vaultName: "my-vault",
  };

  const result = DataOutputOverrideSchema.safeParse(override);

  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data, override);
  }
});

Deno.test("DataOutputOverrideSchema: rejects a missing specName", () => {
  const result = DataOutputOverrideSchema.safeParse({ lifetime: "1h" });

  assertEquals(result.success, false);
});

Deno.test("DataOutputOverrideSchema: rejects an empty specName", () => {
  const result = DataOutputOverrideSchema.safeParse({ specName: "" });

  assertEquals(result.success, false);
});

Deno.test("DataOutputOverrideSchema: accepts duration strings and literals for lifetime", () => {
  const lifetimes = [
    "1h",
    "5m",
    "10d",
    "2w",
    "1mo",
    "10y",
    "ephemeral",
    "infinite",
    "job",
    "workflow",
  ];

  for (const lifetime of lifetimes) {
    const result = DataOutputOverrideSchema.safeParse({
      specName: "output",
      lifetime,
    });
    assertEquals(result.success, true, `expected lifetime "${lifetime}" valid`);
  }
});

Deno.test("DataOutputOverrideSchema: rejects invalid lifetime values", () => {
  const invalid = ["5s", "forever", "", "1 h", "h1"];

  for (const lifetime of invalid) {
    const result = DataOutputOverrideSchema.safeParse({
      specName: "output",
      lifetime,
    });
    assertEquals(
      result.success,
      false,
      `expected lifetime "${lifetime}" invalid`,
    );
  }
});

Deno.test("DataOutputOverrideSchema: accepts positive integer and duration garbageCollection", () => {
  for (const garbageCollection of [1, 10, "2w", "1mo"]) {
    const result = DataOutputOverrideSchema.safeParse({
      specName: "output",
      garbageCollection,
    });
    assertEquals(
      result.success,
      true,
      `expected garbageCollection ${garbageCollection} valid`,
    );
  }
});

Deno.test("DataOutputOverrideSchema: rejects zero, negative, fractional, and zero-duration garbageCollection", () => {
  for (const garbageCollection of [0, -1, 1.5, "0d", "abc"]) {
    const result = DataOutputOverrideSchema.safeParse({
      specName: "output",
      garbageCollection,
    });
    assertEquals(
      result.success,
      false,
      `expected garbageCollection ${garbageCollection} invalid`,
    );
  }
});

Deno.test("DataOutputOverrideSchema: rejects non-string tag values", () => {
  const result = DataOutputOverrideSchema.safeParse({
    specName: "output",
    tags: { count: 3 },
  });

  assertEquals(result.success, false);
});

Deno.test("DataOutputOverrideSchema: accepts an empty tags record", () => {
  const result = DataOutputOverrideSchema.safeParse({
    specName: "output",
    tags: {},
  });

  assertEquals(result.success, true);
});

Deno.test("DataOutputOverrideSchema: accepts vary as a list of input key names", () => {
  const result = DataOutputOverrideSchema.safeParse({
    specName: "output",
    vary: ["region"],
  });

  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.vary, ["region"]);
  }
});

Deno.test("DataOutputOverrideSchema: rejects vary entries that are empty strings", () => {
  const result = DataOutputOverrideSchema.safeParse({
    specName: "output",
    vary: ["region", ""],
  });

  assertEquals(result.success, false);
});

Deno.test("DataOutputOverrideSchema: rejects an empty vaultName", () => {
  const result = DataOutputOverrideSchema.safeParse({
    specName: "output",
    vaultName: "",
  });

  assertEquals(result.success, false);
});

Deno.test("DataOutputOverrideSchema: rejects non-object inputs", () => {
  for (const value of [null, undefined, "output", 42, ["output"]]) {
    const result = DataOutputOverrideSchema.safeParse(value);
    assertEquals(result.success, false);
  }
});
