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
import { resolveDriverConfig } from "./driver_resolution.ts";

Deno.test("resolveDriverConfig - defaults to raw when no sources", () => {
  const result = resolveDriverConfig();
  assertEquals(result.driver, "raw");
  assertEquals(result.driverConfig, undefined);
});

Deno.test("resolveDriverConfig - defaults to raw when all sources undefined", () => {
  const result = resolveDriverConfig(
    undefined,
    undefined,
    undefined,
    undefined,
  );
  assertEquals(result.driver, "raw");
});

Deno.test("resolveDriverConfig - definition driver wins over default", () => {
  const result = resolveDriverConfig(
    undefined,
    undefined,
    undefined,
    { driver: "docker", driverConfig: { image: "node:18" } },
  );
  assertEquals(result.driver, "docker");
  assertEquals(result.driverConfig, { image: "node:18" });
});

Deno.test("resolveDriverConfig - workflow driver wins over definition", () => {
  const result = resolveDriverConfig(
    undefined,
    undefined,
    { driver: "docker", driverConfig: { image: "deno:latest" } },
    { driver: "raw" },
  );
  assertEquals(result.driver, "docker");
  assertEquals(result.driverConfig, { image: "deno:latest" });
});

Deno.test("resolveDriverConfig - job driver wins over workflow", () => {
  const result = resolveDriverConfig(
    undefined,
    { driver: "raw" },
    { driver: "docker" },
    { driver: "docker" },
  );
  assertEquals(result.driver, "raw");
});

Deno.test("resolveDriverConfig - step driver wins over all", () => {
  const result = resolveDriverConfig(
    { driver: "docker", driverConfig: { image: "step-image" } },
    { driver: "raw" },
    { driver: "raw" },
    { driver: "raw" },
  );
  assertEquals(result.driver, "docker");
  assertEquals(result.driverConfig, { image: "step-image" });
});

Deno.test("resolveDriverConfig - skips sources without driver field", () => {
  const result = resolveDriverConfig(
    { driverConfig: { ignore: true } },
    undefined,
    { driver: "docker" },
    undefined,
  );
  assertEquals(result.driver, "docker");
});

Deno.test("resolveDriverConfig - uses driverConfig from winning level only", () => {
  const result = resolveDriverConfig(
    undefined,
    { driver: "docker", driverConfig: { timeout: 30 } },
    { driver: "raw", driverConfig: { verbose: true } },
    undefined,
  );
  assertEquals(result.driver, "docker");
  assertEquals(result.driverConfig, { timeout: 30 });
});
