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

import { assertEquals, assertThrows } from "@std/assert";
import { Platform } from "./platform.ts";
import { UserError } from "../errors.ts";

Deno.test("Platform.from creates darwin aarch64 platform", () => {
  const platform = Platform.from("darwin", "aarch64");
  assertEquals(platform.os, "darwin");
  assertEquals(platform.arch, "aarch64");
});

Deno.test("Platform.from creates linux x86_64 platform", () => {
  const platform = Platform.from("linux", "x86_64");
  assertEquals(platform.os, "linux");
  assertEquals(platform.arch, "x86_64");
});

Deno.test("Platform.from throws UserError for unsupported OS", () => {
  assertThrows(
    () => Platform.from("windows", "x86_64"),
    UserError,
    "Unsupported operating system: windows",
  );
});

Deno.test("Platform.from throws UserError for unsupported arch", () => {
  assertThrows(
    () => Platform.from("darwin", "arm"),
    UserError,
    "Unsupported architecture: arm",
  );
});

Deno.test("tarballName returns correct value for darwin aarch64", () => {
  const platform = Platform.from("darwin", "aarch64");
  assertEquals(
    platform.tarballName,
    "swamp-stable-binary-darwin-aarch64.tar.gz",
  );
});

Deno.test("tarballName returns correct value for linux x86_64", () => {
  const platform = Platform.from("linux", "x86_64");
  assertEquals(platform.tarballName, "swamp-stable-binary-linux-x86_64.tar.gz");
});

Deno.test("stableUrl returns correct artifact URL for darwin aarch64", () => {
  const platform = Platform.from("darwin", "aarch64");
  assertEquals(
    platform.stableUrl(),
    "https://artifacts.systeminit.com/swamp/stable/binary/darwin/aarch64/swamp-stable-binary-darwin-aarch64.tar.gz",
  );
});

Deno.test("stableUrl returns correct artifact URL for darwin x86_64", () => {
  const platform = Platform.from("darwin", "x86_64");
  assertEquals(
    platform.stableUrl(),
    "https://artifacts.systeminit.com/swamp/stable/binary/darwin/x86_64/swamp-stable-binary-darwin-x86_64.tar.gz",
  );
});

Deno.test("stableUrl returns correct artifact URL for linux x86_64", () => {
  const platform = Platform.from("linux", "x86_64");
  assertEquals(
    platform.stableUrl(),
    "https://artifacts.systeminit.com/swamp/stable/binary/linux/x86_64/swamp-stable-binary-linux-x86_64.tar.gz",
  );
});

Deno.test("stableUrl returns correct artifact URL for linux aarch64", () => {
  const platform = Platform.from("linux", "aarch64");
  assertEquals(
    platform.stableUrl(),
    "https://artifacts.systeminit.com/swamp/stable/binary/linux/aarch64/swamp-stable-binary-linux-aarch64.tar.gz",
  );
});

Deno.test("equals returns true for same platform", () => {
  const a = Platform.from("darwin", "aarch64");
  const b = Platform.from("darwin", "aarch64");
  assertEquals(a.equals(b), true);
});

Deno.test("equals returns false for different platforms", () => {
  const a = Platform.from("darwin", "aarch64");
  const b = Platform.from("linux", "x86_64");
  assertEquals(a.equals(b), false);
});

Deno.test("toString returns os/arch", () => {
  const platform = Platform.from("darwin", "aarch64");
  assertEquals(platform.toString(), "darwin/aarch64");
});
