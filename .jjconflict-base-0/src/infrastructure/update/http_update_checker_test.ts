import { assertEquals, assertStringIncludes } from "@std/assert";
import { Platform } from "../../domain/update/platform.ts";

Deno.test("stable URL is constructed correctly for darwin aarch64", () => {
  const platform = Platform.from("darwin", "aarch64");
  assertEquals(
    platform.stableUrl(),
    "https://artifacts.systeminit.com/swamp/stable/binary/darwin/aarch64/swamp-stable-binary-darwin-aarch64.tar.gz",
  );
});

Deno.test("stable URL is constructed correctly for linux x86_64", () => {
  const platform = Platform.from("linux", "x86_64");
  assertEquals(
    platform.stableUrl(),
    "https://artifacts.systeminit.com/swamp/stable/binary/linux/x86_64/swamp-stable-binary-linux-x86_64.tar.gz",
  );
});

Deno.test("stable URL contains expected components", () => {
  const platform = Platform.from("darwin", "x86_64");
  const url = platform.stableUrl();
  assertStringIncludes(url, "artifacts.systeminit.com");
  assertStringIncludes(url, "swamp/stable/binary");
  assertStringIncludes(url, "darwin/x86_64");
  assertStringIncludes(url, "swamp-stable-binary-darwin-x86_64.tar.gz");
});

Deno.test("version extraction from redirect URL works with parseVersionFromRedirectUrl", async () => {
  const { parseVersionFromRedirectUrl } = await import(
    "../../domain/update/update_service.ts"
  );

  // Simulate a redirect URL that the artifact server would return
  const redirectUrl =
    "https://artifacts.systeminit.com/swamp/20260207.123456.0-sha.abc12345/binary/darwin/aarch64/swamp-stable-binary-darwin-aarch64.tar.gz";
  const version = parseVersionFromRedirectUrl(redirectUrl);
  assertEquals(version, "20260207.123456.0-sha.abc12345");
});

Deno.test("version extraction handles various CalVer formats", async () => {
  const { parseVersionFromRedirectUrl } = await import(
    "../../domain/update/update_service.ts"
  );

  // Standard release version
  assertEquals(
    parseVersionFromRedirectUrl(
      "https://artifacts.systeminit.com/swamp/20260101.000000.0-sha.12345678/binary/linux/x86_64/swamp-stable-binary-linux-x86_64.tar.gz",
    ),
    "20260101.000000.0-sha.12345678",
  );

  // Dev version with empty sha
  assertEquals(
    parseVersionFromRedirectUrl(
      "https://artifacts.systeminit.com/swamp/20260206.200442.0-sha./binary/darwin/aarch64/swamp-stable-binary-darwin-aarch64.tar.gz",
    ),
    "20260206.200442.0-sha.",
  );
});
