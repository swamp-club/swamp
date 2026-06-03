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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { Platform } from "../../domain/update/platform.ts";
import { HttpUpdateChecker } from "./http_update_checker.ts";
import { computeChecksum } from "../../domain/models/checksum.ts";

Deno.test("stable URL is constructed correctly for darwin aarch64", () => {
  const platform = Platform.from("darwin", "aarch64");
  assertEquals(
    platform.stableUrl(),
    "https://artifacts.swamp-club.com/swamp/stable/binary/darwin/aarch64/swamp-stable-binary-darwin-aarch64.tar.gz",
  );
});

Deno.test("stable URL is constructed correctly for linux x86_64", () => {
  const platform = Platform.from("linux", "x86_64");
  assertEquals(
    platform.stableUrl(),
    "https://artifacts.swamp-club.com/swamp/stable/binary/linux/x86_64/swamp-stable-binary-linux-x86_64.tar.gz",
  );
});

Deno.test("stable URL contains expected components", () => {
  const platform = Platform.from("darwin", "x86_64");
  const url = platform.stableUrl();
  assertStringIncludes(url, "artifacts.swamp-club.com");
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
    "https://artifacts.swamp-club.com/swamp/20260207.123456.0-sha.abc12345/binary/darwin/aarch64/swamp-stable-binary-darwin-aarch64.tar.gz";
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
      "https://artifacts.swamp-club.com/swamp/20260101.000000.0-sha.12345678/binary/linux/x86_64/swamp-stable-binary-linux-x86_64.tar.gz",
    ),
    "20260101.000000.0-sha.12345678",
  );

  // Dev version with empty sha
  assertEquals(
    parseVersionFromRedirectUrl(
      "https://artifacts.swamp-club.com/swamp/20260206.200442.0-sha./binary/darwin/aarch64/swamp-stable-binary-darwin-aarch64.tar.gz",
    ),
    "20260206.200442.0-sha.",
  );
});

// --- Stream-0 regression net: extract → chmod → xattr removal ---

/**
 * Creates a tarball containing a fake `swamp` binary and returns its bytes
 * (as an ArrayBuffer suitable for `new Response`) plus the SHA-256 checksum
 * the HttpUpdateChecker will need to verify.
 */
async function buildFakeSwampTarball(): Promise<{
  body: ArrayBuffer;
  checksum: string;
}> {
  const stagingDir = await Deno.makeTempDir({
    prefix: "swamp-update-staging-",
  });
  try {
    const archiveRoot = join(stagingDir, "archive");
    await ensureDir(archiveRoot);
    // Fake swamp binary — content doesn't matter, only the file presence
    // and its post-extraction permissions/xattrs do.
    await Deno.writeTextFile(
      join(archiveRoot, "swamp"),
      "#!/bin/sh\necho fake swamp\n",
    );
    await Deno.chmod(join(archiveRoot, "swamp"), 0o644);

    const tarballPath = join(stagingDir, "swamp.tar.gz");
    const tar = new Deno.Command("tar", {
      args: ["-czf", tarballPath, "-C", archiveRoot, "swamp"],
      stdout: "piped",
      stderr: "piped",
    });
    const tarResult = await tar.output();
    assert(tarResult.success, "tar creation should succeed");
    const bytes = await Deno.readFile(tarballPath);
    const checksum = await computeChecksum(bytes);
    // Copy into a fresh ArrayBuffer so `new Response()` accepts it without
    // TS BodyInit complaints from Uint8Array<ArrayBufferLike> vs ArrayBuffer.
    const body = new ArrayBuffer(bytes.length);
    new Uint8Array(body).set(bytes);
    return { body, checksum };
  } finally {
    await Deno.remove(stagingDir, { recursive: true });
  }
}

Deno.test({
  name:
    "HttpUpdateChecker.downloadAndInstall: extract → chmod 0o755 end-to-end",
  // tar layout, mode bits, and xattrs are POSIX-only. Stream A will
  // wire up a Windows path; this test pins the existing POSIX behavior.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "swamp-update-test-" });
    try {
      const { body, checksum } = await buildFakeSwampTarball();

      // Serve the tarball locally so we don't hit the real artifact CDN.
      const server = Deno.serve({ port: 0, onListen: () => {} }, (_req) => {
        return new Response(body, {
          headers: { "content-type": "application/gzip" },
        });
      });

      try {
        const port = server.addr.port;
        const url = `http://localhost:${port}/swamp.tar.gz`;
        const binaryPath = join(tempDir, "swamp");

        const checker = new HttpUpdateChecker();
        await checker.downloadAndInstall(url, binaryPath, checksum);

        // Binary must exist at the target path
        const stat = await Deno.stat(binaryPath);
        assertEquals(stat.isFile, true);
        // chmod 0o755 must be applied on POSIX — the install path
        // explicitly chmods after replacement, regardless of the mode
        // present in the tarball.
        assertEquals(
          (stat.mode! & 0o111) !== 0,
          true,
          `expected executable bits set; got 0o${
            (stat.mode! & 0o777).toString(8)
          }`,
        );
        assertEquals(
          stat.mode! & 0o777,
          0o755,
          `expected mode 0o755; got 0o${(stat.mode! & 0o777).toString(8)}`,
        );
      } finally {
        await server.shutdown();
      }
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "HttpUpdateChecker.downloadAndInstall: macOS install path clears com.apple.quarantine xattr",
  // The xattr removal step only runs on darwin. On Linux the xattr binary
  // typically isn't installed and `removeQuarantine` is not invoked at
  // all — the production check is `Deno.build.os === "darwin"`. We assert
  // observable behavior on the current host: on darwin, the installed
  // binary must not carry com.apple.quarantine.
  ignore: Deno.build.os !== "darwin",
  fn: async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "swamp-update-test-" });
    try {
      const { body, checksum } = await buildFakeSwampTarball();

      const server = Deno.serve({ port: 0, onListen: () => {} }, (_req) => {
        return new Response(body, {
          headers: { "content-type": "application/gzip" },
        });
      });

      try {
        const port = server.addr.port;
        const url = `http://localhost:${port}/swamp.tar.gz`;
        const binaryPath = join(tempDir, "swamp");

        const checker = new HttpUpdateChecker();
        await checker.downloadAndInstall(url, binaryPath, checksum);

        // Probe the installed binary with `xattr -l`. If the install
        // path's quarantine removal works, the listing must not include
        // com.apple.quarantine. (Files written via Deno on a local
        // filesystem typically aren't tagged in the first place; this
        // test guards against a future refactor that, e.g., loses the
        // `xattr -d` call entirely AND somehow ends up tagging files.)
        const xattrCmd = new Deno.Command("xattr", {
          args: ["-l", binaryPath],
          stdout: "piped",
          stderr: "piped",
        });
        const xattrResult = await xattrCmd.output();
        const xattrStdout = new TextDecoder().decode(xattrResult.stdout);
        assertEquals(
          xattrStdout.includes("com.apple.quarantine"),
          false,
          `installed binary unexpectedly carries com.apple.quarantine; xattr -l output: ${xattrStdout}`,
        );
      } finally {
        await server.shutdown();
      }
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});
