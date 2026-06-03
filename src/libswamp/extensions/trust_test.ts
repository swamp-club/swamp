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
import { resolveTrustedCollectives } from "./trust.ts";

Deno.test("resolveTrustedCollectives returns swamp-only default when no marker", () => {
  const result = resolveTrustedCollectives(null);
  assertEquals(result, ["swamp"]);
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

Deno.test("resolveTrustedCollectives does NOT trust membership collectives by default", () => {
  // No trustMemberCollectives opt-in → auth collectives are ignored.
  const result = resolveTrustedCollectives(null, ["myorg", "other"]);
  assertEquals(result, ["swamp"]);
});

Deno.test("resolveTrustedCollectives merges membership collectives only when opted in", () => {
  const marker = {
    swampVersion: "0.1.0",
    initializedAt: "2024-01-01T00:00:00Z",
    trustedCollectives: ["swamp"],
    trustMemberCollectives: true,
  };
  const result = resolveTrustedCollectives(marker, ["myorg", "other"]);
  assertEquals(result, ["swamp", "myorg", "other"]);
});

Deno.test("resolveTrustedCollectives deduplicates when opted in", () => {
  const marker = {
    swampVersion: "0.1.0",
    initializedAt: "2024-01-01T00:00:00Z",
    trustedCollectives: ["swamp", "myorg"],
    trustMemberCollectives: true,
  };
  const result = resolveTrustedCollectives(marker, ["myorg", "neworg"]);
  assertEquals(result, ["swamp", "myorg", "neworg"]);
});

Deno.test("resolveTrustedCollectives ignores membership collectives when opt-in is false", () => {
  const marker = {
    swampVersion: "0.1.0",
    initializedAt: "2024-01-01T00:00:00Z",
    trustedCollectives: ["swamp"],
    trustMemberCollectives: false,
  };
  const result = resolveTrustedCollectives(marker, ["myorg", "other"]);
  assertEquals(result, ["swamp"]);
});

Deno.test("resolveTrustedCollectives explicit trust add works without membership opt-in", () => {
  // The opt-in escape hatch is per-collective: adding myorg to the explicit
  // list trusts it without trusting every membership collective.
  const marker = {
    swampVersion: "0.1.0",
    initializedAt: "2024-01-01T00:00:00Z",
    trustedCollectives: ["swamp", "myorg"],
  };
  const result = resolveTrustedCollectives(marker, ["myorg", "other"]);
  assertEquals(result, ["swamp", "myorg"]);
});

Deno.test("resolveTrustedCollectives handles undefined auth collectives", () => {
  const marker = {
    swampVersion: "0.1.0",
    initializedAt: "2024-01-01T00:00:00Z",
    trustedCollectives: ["swamp"],
    trustMemberCollectives: true,
  };
  const result = resolveTrustedCollectives(marker, undefined);
  assertEquals(result, ["swamp"]);
});

Deno.test("resolveTrustedCollectives handles empty auth collectives", () => {
  const result = resolveTrustedCollectives(null, []);
  assertEquals(result, ["swamp"]);
});
