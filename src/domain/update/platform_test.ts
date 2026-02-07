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
