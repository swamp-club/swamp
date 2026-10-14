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

import {
  assertEquals,
  assertInstanceOf,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { TarStream } from "@std/tar/tar-stream";
import { Platform } from "../../domain/update/platform.ts";
import {
  cleanupStaleBinary,
  HttpUpdateChecker,
} from "./http_update_checker.ts";
import { computeChecksum } from "../../domain/models/checksum.ts";
import {
  ABANDONED_TEMP_DIR_MAX_AGE_MS,
  ABANDONED_TEMP_FILE_MAX_AGE_MS,
} from "../persistence/abandoned_temp_files.ts";
import { UserError } from "../../domain/errors.ts";
import { withMockedFetch } from "@swamp-club/swamp-testing";

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

Deno.test("stable URL uses .zip extension for windows", () => {
  const platform = Platform.from("windows", "x86_64");
  const url = platform.stableUrl();
  assertStringIncludes(url, "windows/x86_64");
  assertStringIncludes(url, "swamp-stable-binary-windows-x86_64.zip");
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
 *
 * Built entirely in-process with TarStream + CompressionStream — no external
 * `tar` binary required, which eliminates flaky spawn failures on CI.
 */
async function buildFakeSwampTarball(): Promise<{
  body: ArrayBuffer;
  checksum: string;
}> {
  const payload = new TextEncoder().encode("#!/bin/sh\necho fake swamp\n");
  const chunks: Uint8Array[] = [];
  await ReadableStream.from([
    {
      type: "file" as const,
      path: "swamp",
      size: payload.length,
      readable: new ReadableStream({
        start(controller) {
          controller.enqueue(payload);
          controller.close();
        },
      }),
    },
  ])
    .pipeThrough(new TarStream())
    .pipeThrough(new CompressionStream("gzip"))
    .pipeTo(
      new WritableStream({
        write(chunk) {
          chunks.push(new Uint8Array(chunk));
        },
      }),
    );

  let totalLen = 0;
  for (const c of chunks) totalLen += c.length;
  const bytes = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }

  const checksum = await computeChecksum(bytes);
  const body = bytes.buffer as ArrayBuffer;
  return { body, checksum };
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

        const checker = new HttpUpdateChecker({ tempRoot: tempDir });
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
    "HttpUpdateChecker.downloadAndInstall: replacement creates a new inode (old inode survives)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "swamp-update-test-" });
    try {
      const { body, checksum } = await buildFakeSwampTarball();
      const binaryPath = join(tempDir, "swamp");

      // Place an initial binary and record its inode
      await Deno.writeTextFile(binaryPath, "#!/bin/sh\necho original\n");
      await Deno.chmod(binaryPath, 0o755);
      const oldStat = await Deno.stat(binaryPath);
      const oldIno = oldStat.ino;

      const server = Deno.serve({ port: 0, onListen: () => {} }, (_req) => {
        return new Response(body, {
          headers: { "content-type": "application/gzip" },
        });
      });

      try {
        const port = server.addr.port;
        const url = `http://localhost:${port}/swamp.tar.gz`;

        const checker = new HttpUpdateChecker({ tempRoot: tempDir });
        await checker.downloadAndInstall(url, binaryPath, checksum);

        const newStat = await Deno.stat(binaryPath);
        assertNotEquals(
          newStat.ino,
          oldIno,
          "replacement must create a new inode so running processes keep the old one",
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
    "HttpUpdateChecker.downloadAndInstall: cleans up stale .swamp.tmp files",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "swamp-update-test-" });
    try {
      const { body, checksum } = await buildFakeSwampTarball();
      const binaryPath = join(tempDir, "swamp");

      // Simulate a stale temp file from a previous crashed update
      const stalePath = join(tempDir, ".swamp.tmp.stale-uuid");
      await Deno.writeTextFile(stalePath, "stale");
      const staleTime = new Date(
        Date.now() - ABANDONED_TEMP_FILE_MAX_AGE_MS - 60_000,
      );
      await Deno.utime(stalePath, staleTime, staleTime);

      const server = Deno.serve({ port: 0, onListen: () => {} }, (_req) => {
        return new Response(body, {
          headers: { "content-type": "application/gzip" },
        });
      });

      try {
        const port = server.addr.port;
        const url = `http://localhost:${port}/swamp.tar.gz`;

        const checker = new HttpUpdateChecker({ tempRoot: tempDir });
        await checker.downloadAndInstall(url, binaryPath, checksum);

        // Stale temp file should be cleaned up
        let staleExists = true;
        try {
          await Deno.stat(stalePath);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) {
            staleExists = false;
          }
        }
        assertEquals(
          staleExists,
          false,
          "stale .swamp.tmp file should be cleaned up during update",
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
    "HttpUpdateChecker.downloadAndInstall: keeps a fresh .swamp.tmp file owned by a concurrent update",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "swamp-update-test-" });
    try {
      const { body, checksum } = await buildFakeSwampTarball();
      const binaryPath = join(tempDir, "swamp");

      // Simulate a temp file another update process is still copying
      const inFlightPath = join(tempDir, ".swamp.tmp.in-flight-uuid");
      await Deno.writeTextFile(inFlightPath, "in-flight");

      const server = Deno.serve({ port: 0, onListen: () => {} }, (_req) => {
        return new Response(body, {
          headers: { "content-type": "application/gzip" },
        });
      });

      try {
        const port = server.addr.port;
        const url = `http://localhost:${port}/swamp.tar.gz`;

        const checker = new HttpUpdateChecker({ tempRoot: tempDir });
        await checker.downloadAndInstall(url, binaryPath, checksum);

        const info = await Deno.stat(inFlightPath);
        assertEquals(
          info.isFile,
          true,
          "fresh .swamp.tmp file should survive a concurrent update",
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

        const checker = new HttpUpdateChecker({ tempRoot: tempDir });
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

// --- cleanupStaleBinary tests ---

Deno.test("cleanupStaleBinary: removes .old file when it exists", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "swamp-cleanup-test-" });
  try {
    const binaryPath = join(tempDir, "swamp");
    const oldPath = binaryPath + ".old";
    await Deno.writeTextFile(oldPath, "stale binary");

    await cleanupStaleBinary(binaryPath);

    let exists = true;
    try {
      await Deno.stat(oldPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        exists = false;
      }
    }
    assertEquals(exists, false, ".old file should be removed");
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("cleanupStaleBinary: succeeds silently when no .old file exists", async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "swamp-cleanup-test-" });
  try {
    const binaryPath = join(tempDir, "swamp");
    // No .old file created — should not throw
    await cleanupStaleBinary(binaryPath);
  } finally {
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});

// ============================================================================
// checkForUpdate retries (swamp-club#3428)
// ============================================================================

const RETRY_PLATFORM = Platform.from("linux", "x86_64");
const VERSIONED_URL =
  "https://artifacts.swamp-club.com/swamp/20261014.015425.0-sha.fd84c826/binary/linux/x86_64/swamp.tar.gz";

function timeoutError(): DOMException {
  return new DOMException(
    "The operation was aborted due to timeout",
    "TimeoutError",
  );
}

function recordingSleep(): {
  delays: number[];
  sleep: (ms: number) => Promise<void>;
} {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

function redirectResponse(): Response {
  return new Response(null, {
    status: 302,
    headers: { location: VERSIONED_URL },
  });
}

Deno.test("HttpUpdateChecker.checkForUpdate: retries timeouts with backoff, then returns the redirect", async () => {
  const { delays, sleep } = recordingSleep();
  const checker = new HttpUpdateChecker({ maxAttempts: 3, sleep });
  let attempt = 0;
  const { result, calls } = await withMockedFetch(() => {
    attempt++;
    if (attempt < 3) throw timeoutError();
    return redirectResponse();
  }, () => checker.checkForUpdate(RETRY_PLATFORM));

  assertEquals(result, VERSIONED_URL);
  assertEquals(calls.length, 3);
  assertEquals(calls.every((c) => c.method === "HEAD"), true);
  assertEquals(delays, [1000, 2000]);
});

Deno.test("HttpUpdateChecker.checkForUpdate: every attempt timing out raises a UserError, not a TimeoutError", async () => {
  const { sleep } = recordingSleep();
  const checker = new HttpUpdateChecker({ maxAttempts: 3, sleep });
  const { result: error, calls } = await withMockedFetch(
    () => {
      throw timeoutError();
    },
    () =>
      assertRejects(
        () => checker.checkForUpdate(RETRY_PLATFORM),
        UserError,
      ),
  );

  assertEquals(calls.length, 3);
  assertInstanceOf(error, UserError);
  assertEquals(
    error.message,
    "Failed to check for updates after 3 attempts. Last attempt: the update server did not respond within 5s",
  );
});

Deno.test("HttpUpdateChecker.checkForUpdate: retries a 5xx, then returns the stable URL on 200", async () => {
  const { delays, sleep } = recordingSleep();
  const checker = new HttpUpdateChecker({ maxAttempts: 3, sleep });
  const { result, calls } = await withMockedFetch(
    [
      new Response("busy", { status: 503 }),
      new Response(null, { status: 200 }),
    ],
    () => checker.checkForUpdate(RETRY_PLATFORM),
  );

  assertEquals(result, RETRY_PLATFORM.stableUrl());
  assertEquals(calls.length, 2);
  assertEquals(delays, [1000]);
});

Deno.test("HttpUpdateChecker.checkForUpdate: a 5xx on every attempt keeps the HTTP status wording", async () => {
  const { sleep } = recordingSleep();
  const checker = new HttpUpdateChecker({ maxAttempts: 2, sleep });
  const { result: error, calls } = await withMockedFetch(
    [
      new Response(null, { status: 502 }),
      new Response(null, { status: 502 }),
    ],
    () =>
      assertRejects(
        () => checker.checkForUpdate(RETRY_PLATFORM),
        UserError,
      ),
  );

  assertEquals(calls.length, 2);
  assertEquals(
    error.message,
    "Failed to check for updates after 2 attempts. Last attempt: HTTP 502",
  );
});

Deno.test("HttpUpdateChecker.checkForUpdate: a 404 is not retried", async () => {
  const { delays, sleep } = recordingSleep();
  const checker = new HttpUpdateChecker({ maxAttempts: 3, sleep });
  const { result: error, calls } = await withMockedFetch(
    [new Response(null, { status: 404 })],
    () =>
      assertRejects(
        () => checker.checkForUpdate(RETRY_PLATFORM),
        UserError,
      ),
  );

  assertEquals(calls.length, 1);
  assertEquals(delays, []);
  assertStringIncludes(error.message, "No binary available");
});

Deno.test("HttpUpdateChecker.checkForUpdate: makes a single attempt by default and still raises a UserError", async () => {
  const { delays, sleep } = recordingSleep();
  const checker = new HttpUpdateChecker({ sleep });
  const { result: error, calls } = await withMockedFetch(
    () => {
      throw timeoutError();
    },
    () =>
      assertRejects(
        () => checker.checkForUpdate(RETRY_PLATFORM),
        UserError,
      ),
  );

  assertEquals(calls.length, 1);
  assertEquals(delays, []);
  assertEquals(
    error.message,
    "Failed to check for updates: the update server did not respond within 5s",
  );
});

Deno.test("HttpUpdateChecker.checkForUpdate: a connection error is wrapped with its message", async () => {
  const { sleep } = recordingSleep();
  const checker = new HttpUpdateChecker({ maxAttempts: 2, sleep });
  const { result: error, calls } = await withMockedFetch(
    () => {
      throw new TypeError("error sending request: connection refused");
    },
    () =>
      assertRejects(
        () => checker.checkForUpdate(RETRY_PLATFORM),
        UserError,
      ),
  );

  assertEquals(calls.length, 2);
  assertEquals(
    error.message,
    "Failed to check for updates after 2 attempts. Last attempt: error sending request: connection refused",
  );
});

Deno.test("HttpUpdateChecker.checkForUpdate: names only the last attempt's failure when attempts fail differently", async () => {
  const { sleep } = recordingSleep();
  const checker = new HttpUpdateChecker({ maxAttempts: 3, sleep });
  let attempt = 0;
  const { result: error, calls } = await withMockedFetch(
    () => {
      attempt++;
      if (attempt === 1) return new Response(null, { status: 503 });
      if (attempt === 2) throw new TypeError("connection reset");
      throw timeoutError();
    },
    () =>
      assertRejects(
        () => checker.checkForUpdate(RETRY_PLATFORM),
        UserError,
      ),
  );

  assertEquals(calls.length, 3);
  assertEquals(
    error.message,
    "Failed to check for updates after 3 attempts. Last attempt: the update server did not respond within 5s",
  );
});

Deno.test("HttpUpdateChecker.checkForUpdate: a single-attempt 5xx keeps the original wording", async () => {
  const checker = new HttpUpdateChecker();
  const { result: error, calls } = await withMockedFetch(
    [new Response(null, { status: 500 })],
    () =>
      assertRejects(
        () => checker.checkForUpdate(RETRY_PLATFORM),
        UserError,
      ),
  );

  assertEquals(calls.length, 1);
  assertEquals(error.message, "Failed to check for updates: HTTP 500");
});

// ============================================================================
// Cancellation, checksum retries and temp cleanup (swamp-club#3447)
// ============================================================================

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

Deno.test("HttpUpdateChecker.checkForUpdate: aborting during the retry wait stops with no further attempt", async () => {
  const controller = new AbortController();
  const checker = new HttpUpdateChecker({
    maxAttempts: 3,
    sleep: (_ms, signal) => {
      controller.abort();
      return Promise.reject(signal?.reason);
    },
  });
  const { result: error, calls } = await withMockedFetch(
    () => {
      throw timeoutError();
    },
    () =>
      assertRejects(() =>
        checker.checkForUpdate(RETRY_PLATFORM, controller.signal)
      ),
  );

  assertEquals(calls.length, 1);
  assertInstanceOf(error, DOMException);
  assertEquals((error as DOMException).name, "AbortError");
});

Deno.test("HttpUpdateChecker.checkForUpdate: an abort during the request is not retried", async () => {
  const controller = new AbortController();
  const { sleep, delays } = recordingSleep();
  const checker = new HttpUpdateChecker({ maxAttempts: 3, sleep });
  const { result: error, calls } = await withMockedFetch(
    () => {
      controller.abort();
      throw abortError();
    },
    () =>
      assertRejects(() =>
        checker.checkForUpdate(RETRY_PLATFORM, controller.signal)
      ),
  );

  assertEquals(calls.length, 1);
  assertEquals(delays, []);
  assertEquals((error as DOMException).name, "AbortError");
});

Deno.test("HttpUpdateChecker.fetchChecksum: retries a timeout, then parses the checksum", async () => {
  const { delays, sleep } = recordingSleep();
  const checker = new HttpUpdateChecker({ maxAttempts: 3, sleep });
  const hash = "a".repeat(64);
  let attempt = 0;
  const { result, calls } = await withMockedFetch(() => {
    attempt++;
    if (attempt === 1) throw timeoutError();
    return new Response(`${hash}  swamp.tar.gz\n`);
  }, () => checker.fetchChecksum(VERSIONED_URL));

  assertEquals(result, hash);
  assertEquals(calls.length, 2);
  assertEquals(calls[1].url, `${VERSIONED_URL}.sha256`);
  assertEquals(delays, [1000]);
});

Deno.test("HttpUpdateChecker.fetchChecksum: every attempt timing out raises a UserError", async () => {
  const { sleep } = recordingSleep();
  const checker = new HttpUpdateChecker({ maxAttempts: 3, sleep });
  const { result: error } = await withMockedFetch(
    () => {
      throw timeoutError();
    },
    () => assertRejects(() => checker.fetchChecksum(VERSIONED_URL), UserError),
  );

  assertEquals(
    error.message,
    "Failed to fetch checksum after 3 attempts. Last attempt: the update server did not respond within 5s",
  );
});

Deno.test("HttpUpdateChecker.fetchChecksum: a 404 is not retried and names the URL", async () => {
  const { delays, sleep } = recordingSleep();
  const checker = new HttpUpdateChecker({ maxAttempts: 3, sleep });
  const { result: error, calls } = await withMockedFetch(
    [new Response("missing", { status: 404 })],
    () => assertRejects(() => checker.fetchChecksum(VERSIONED_URL), UserError),
  );

  assertEquals(calls.length, 1);
  assertEquals(delays, []);
  assertEquals(
    error.message,
    `Failed to fetch checksum: HTTP 404 from ${VERSIONED_URL}.sha256`,
  );
});

/** The names of the update temp directories under `root`. */
async function updateTempDirs(root: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    if (entry.name.startsWith("swamp-update-")) names.push(entry.name);
  }
  return names;
}

/**
 * Runs `downloadAndInstall` against a local server that sends `body`, with
 * temp directories under `root/tmp` and an existing binary at `root/swamp`.
 */
async function installFromLocalServer(
  root: string,
  body: ArrayBuffer | ReadableStream<Uint8Array>,
  checksum: string,
  options: Parameters<HttpUpdateChecker["downloadAndInstall"]>[3],
): Promise<void> {
  const tempRoot = join(root, "tmp");
  await Deno.mkdir(tempRoot, { recursive: true });
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    () =>
      new Response(body, {
        headers: { "content-type": "application/gzip" },
      }),
  );
  try {
    const checker = new HttpUpdateChecker({ tempRoot });
    await checker.downloadAndInstall(
      `http://localhost:${server.addr.port}/swamp.tar.gz`,
      join(root, "swamp"),
      checksum,
      options,
    );
  } finally {
    await server.shutdown();
  }
}

Deno.test({
  name:
    "HttpUpdateChecker.downloadAndInstall: Ctrl+C mid-download removes the temp dir and keeps the binary",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "swamp-update-test-" });
    try {
      await Deno.writeTextFile(join(root, "swamp"), "original");
      const controller = new AbortController();
      // Sends a first chunk, then nothing, like a download on a slow link.
      // The user presses Ctrl+C once the download is under way.
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          if (sent) {
            controller.abort();
            return new Promise<void>(() => {});
          }
          sent = true;
          c.enqueue(new Uint8Array(1024));
        },
      });

      const error = await assertRejects(() =>
        installFromLocalServer(root, body, "0".repeat(64), {
          signal: controller.signal,
        })
      );

      assertEquals((error as DOMException).name, "AbortError");
      assertEquals(await updateTempDirs(join(root, "tmp")), []);
      assertEquals(await Deno.readTextFile(join(root, "swamp")), "original");
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "HttpUpdateChecker.downloadAndInstall: Ctrl+C after the download but before the swap keeps the binary",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "swamp-update-test-" });
    try {
      await Deno.writeTextFile(join(root, "swamp"), "original");
      const { body, checksum } = await buildFakeSwampTarball();
      const controller = new AbortController();

      await assertRejects(() =>
        installFromLocalServer(root, body, checksum, {
          signal: controller.signal,
          onProgress: (p) => {
            if (p.receivedBytes === p.totalBytes) controller.abort();
          },
        })
      );

      assertEquals(await updateTempDirs(join(root, "tmp")), []);
      assertEquals(await Deno.readTextFile(join(root, "swamp")), "original");
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "HttpUpdateChecker.downloadAndInstall: removes a temp dir a killed update left behind",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "swamp-update-test-" });
    try {
      const tempRoot = join(root, "tmp");
      const leftover = join(tempRoot, "swamp-update-killed");
      await Deno.mkdir(leftover, { recursive: true });
      const partial = join(leftover, "swamp.tar.gz");
      await Deno.writeTextFile(partial, "53 MB of a partial download");
      const staleTime = new Date(
        Date.now() - ABANDONED_TEMP_DIR_MAX_AGE_MS - 60_000,
      );
      await Deno.utime(partial, staleTime, staleTime);
      await Deno.utime(leftover, staleTime, staleTime);
      const { body, checksum } = await buildFakeSwampTarball();

      await installFromLocalServer(root, body, checksum, {});

      assertEquals(await updateTempDirs(tempRoot), []);
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
});
