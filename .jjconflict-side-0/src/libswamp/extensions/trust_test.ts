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
import { resolveTrustedCollectives } from "./trust.ts";

Deno.test("resolveTrustedCollectives returns defaults when no marker", () => {
  const result = resolveTrustedCollectives(null);
  assertEquals(result, ["swamp", "si"]);
});

Deno.test("resolveTrustedCollectives returns explicit collectives from marker", () => {
  const marker = {
    swampVersion: "0.1.0",
    initializedAt: "2024-01-01T00:00:00Z",
    trustedCollectives: ["myorg"],
  };
  const result = resolveTrustedCollectives(marker);
  assertEquals(result, ["myorg"]);
});

Deno.test("resolveTrustedCollectives merges auth collectives with defaults", () => {
  const result = resolveTrustedCollectives(null, ["myorg", "other"]);
  assertEquals(result, ["swamp", "si", "myorg", "other"]);
});

Deno.test("resolveTrustedCollectives deduplicates merged collectives", () => {
  const marker = {
    swampVersion: "0.1.0",
    initializedAt: "2024-01-01T00:00:00Z",
    trustedCollectives: ["swamp", "si", "myorg"],
  };
  const result = resolveTrustedCollectives(marker, ["myorg", "neworg"]);
  assertEquals(result, ["swamp", "si", "myorg", "neworg"]);
});

Deno.test("resolveTrustedCollectives respects trustMemberCollectives false", () => {
  const marker = {
    swampVersion: "0.1.0",
    initializedAt: "2024-01-01T00:00:00Z",
    trustedCollectives: ["swamp"],
    trustMemberCollectives: false,
  };
  const result = resolveTrustedCollectives(marker, ["myorg", "other"]);
  assertEquals(result, ["swamp"]);
});

Deno.test("resolveTrustedCollectives merges when trustMemberCollectives is true", () => {
  const marker = {
    swampVersion: "0.1.0",
    initializedAt: "2024-01-01T00:00:00Z",
    trustedCollectives: ["swamp"],
    trustMemberCollectives: true,
  };
  const result = resolveTrustedCollectives(marker, ["myorg"]);
  assertEquals(result, ["swamp", "myorg"]);
});

Deno.test("resolveTrustedCollectives handles undefined auth collectives", () => {
  const marker = {
    swampVersion: "0.1.0",
    initializedAt: "2024-01-01T00:00:00Z",
    trustedCollectives: ["swamp", "si"],
  };
  const result = resolveTrustedCollectives(marker, undefined);
  assertEquals(result, ["swamp", "si"]);
});

Deno.test("resolveTrustedCollectives handles empty auth collectives", () => {
  const result = resolveTrustedCollectives(null, []);
  assertEquals(result, ["swamp", "si"]);
});
