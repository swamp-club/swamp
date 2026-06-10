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

import { assertEquals, assertThrows } from "@std/assert";
import { ReleaseChannel } from "./release_channel.ts";

// --- Validation ---

Deno.test("ReleaseChannel.create: accepts valid channel names", () => {
  assertEquals(ReleaseChannel.create("beta").name, "beta");
  assertEquals(ReleaseChannel.create("rc").name, "rc");
  assertEquals(ReleaseChannel.create("stable").name, "stable");
});

Deno.test("ReleaseChannel.create: rejects invalid channel names", () => {
  assertThrows(
    () => ReleaseChannel.create("alpha"),
    Error,
    'Invalid release channel: "alpha"',
  );
  assertThrows(
    () => ReleaseChannel.create("nightly"),
    Error,
    'Invalid release channel: "nightly"',
  );
  assertThrows(
    () => ReleaseChannel.create(""),
    Error,
    'Invalid release channel: ""',
  );
  assertThrows(
    () => ReleaseChannel.create("BETA"),
    Error,
    'Invalid release channel: "BETA"',
  );
});

Deno.test("ReleaseChannel.isValid: returns true for valid names", () => {
  assertEquals(ReleaseChannel.isValid("beta"), true);
  assertEquals(ReleaseChannel.isValid("rc"), true);
  assertEquals(ReleaseChannel.isValid("stable"), true);
});

Deno.test("ReleaseChannel.isValid: returns false for invalid names", () => {
  assertEquals(ReleaseChannel.isValid("alpha"), false);
  assertEquals(ReleaseChannel.isValid(""), false);
  assertEquals(ReleaseChannel.isValid("STABLE"), false);
});

// --- Static instances ---

Deno.test("ReleaseChannel: static instances have correct names", () => {
  assertEquals(ReleaseChannel.BETA.name, "beta");
  assertEquals(ReleaseChannel.RC.name, "rc");
  assertEquals(ReleaseChannel.STABLE.name, "stable");
});

// --- isPrerelease ---

Deno.test("ReleaseChannel.isPrerelease: beta is prerelease", () => {
  assertEquals(ReleaseChannel.BETA.isPrerelease(), true);
});

Deno.test("ReleaseChannel.isPrerelease: rc is prerelease", () => {
  assertEquals(ReleaseChannel.RC.isPrerelease(), true);
});

Deno.test("ReleaseChannel.isPrerelease: stable is not prerelease", () => {
  assertEquals(ReleaseChannel.STABLE.isPrerelease(), false);
});

Deno.test("ReleaseChannel.isPrereleaseName: checks name strings", () => {
  assertEquals(ReleaseChannel.isPrereleaseName("beta"), true);
  assertEquals(ReleaseChannel.isPrereleaseName("rc"), true);
  assertEquals(ReleaseChannel.isPrereleaseName("stable"), false);
  assertEquals(ReleaseChannel.isPrereleaseName("other"), false);
});

// --- canPromoteTo (promotion ladder) ---

Deno.test("ReleaseChannel.canPromoteTo: beta can promote to rc", () => {
  assertEquals(ReleaseChannel.BETA.canPromoteTo(ReleaseChannel.RC), true);
});

Deno.test("ReleaseChannel.canPromoteTo: beta can promote to stable", () => {
  assertEquals(ReleaseChannel.BETA.canPromoteTo(ReleaseChannel.STABLE), true);
});

Deno.test("ReleaseChannel.canPromoteTo: rc can promote to stable", () => {
  assertEquals(ReleaseChannel.RC.canPromoteTo(ReleaseChannel.STABLE), true);
});

Deno.test("ReleaseChannel.canPromoteTo: stable cannot promote to rc", () => {
  assertEquals(ReleaseChannel.STABLE.canPromoteTo(ReleaseChannel.RC), false);
});

Deno.test("ReleaseChannel.canPromoteTo: stable cannot promote to beta", () => {
  assertEquals(ReleaseChannel.STABLE.canPromoteTo(ReleaseChannel.BETA), false);
});

Deno.test("ReleaseChannel.canPromoteTo: rc cannot promote to beta", () => {
  assertEquals(ReleaseChannel.RC.canPromoteTo(ReleaseChannel.BETA), false);
});

Deno.test("ReleaseChannel.canPromoteTo: cannot promote to same channel", () => {
  assertEquals(ReleaseChannel.BETA.canPromoteTo(ReleaseChannel.BETA), false);
  assertEquals(ReleaseChannel.RC.canPromoteTo(ReleaseChannel.RC), false);
  assertEquals(
    ReleaseChannel.STABLE.canPromoteTo(ReleaseChannel.STABLE),
    false,
  );
});

// --- Equality ---

Deno.test("ReleaseChannel.equals: same channels are equal", () => {
  assertEquals(ReleaseChannel.BETA.equals(ReleaseChannel.create("beta")), true);
  assertEquals(ReleaseChannel.RC.equals(ReleaseChannel.create("rc")), true);
  assertEquals(
    ReleaseChannel.STABLE.equals(ReleaseChannel.create("stable")),
    true,
  );
});

Deno.test("ReleaseChannel.equals: different channels are not equal", () => {
  assertEquals(ReleaseChannel.BETA.equals(ReleaseChannel.RC), false);
  assertEquals(ReleaseChannel.RC.equals(ReleaseChannel.STABLE), false);
  assertEquals(ReleaseChannel.STABLE.equals(ReleaseChannel.BETA), false);
});

// --- toString ---

Deno.test("ReleaseChannel.toString: returns channel name", () => {
  assertEquals(ReleaseChannel.BETA.toString(), "beta");
  assertEquals(ReleaseChannel.RC.toString(), "rc");
  assertEquals(ReleaseChannel.STABLE.toString(), "stable");
});
