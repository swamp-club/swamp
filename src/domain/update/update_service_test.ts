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
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import {
  isDevBuild,
  needlessRootUpdateWarning,
  parseVersionFromRedirectUrl,
  permissionDeniedMessage,
  stickyDirectoryBlocksReplace,
  type UpdateChecker,
  UpdateService,
} from "./update_service.ts";
import { Platform } from "./platform.ts";
import { UserError } from "../errors.ts";
import type { DownloadOptions } from "./download_progress.ts";

interface MockCheckerCalls {
  downloadUrls: string[];
  checksumUrls: string[];
  expectedChecksums: string[];
}

function createMockChecker(
  redirectUrl: string | null = null,
  calls?: MockCheckerCalls,
  checksumToReturn: string = "a".repeat(64),
): UpdateChecker {
  return {
    checkForUpdate: (_platform: Platform) => Promise.resolve(redirectUrl),
    fetchChecksum: (tarballUrl: string) => {
      calls?.checksumUrls.push(tarballUrl);
      return Promise.resolve(checksumToReturn);
    },
    downloadAndInstall: (
      url: string,
      _binaryPath: string,
      expectedChecksum: string,
    ) => {
      calls?.downloadUrls.push(url);
      calls?.expectedChecksums.push(expectedChecksum);
      return Promise.resolve();
    },
  };
}

const platform = Platform.from("darwin", "aarch64");

// The update pre-flight probes the binary's directory; a missing directory is
// not a permission problem, so these tests never touch a real install dir.
const missingBinaryPath = "/nonexistent-swamp-update-test/bin/swamp";

// --- isDevBuild tests ---

Deno.test("isDevBuild returns true for empty sha", () => {
  assertEquals(isDevBuild("20260206.200442.0-sha."), true);
});

Deno.test("isDevBuild returns true for version without -sha. segment", () => {
  assertEquals(isDevBuild("20260206.200442.0"), true);
});

Deno.test("isDevBuild returns false for version with full sha", () => {
  assertEquals(isDevBuild("20260207.123456.0-sha.abc12345"), false);
});

Deno.test("isDevBuild returns false for version with short sha", () => {
  assertEquals(isDevBuild("20260207.123456.0-sha.abcd"), false);
});

// --- parseVersionFromRedirectUrl tests ---

Deno.test("parseVersionFromRedirectUrl extracts version from redirect URL", () => {
  const url =
    "https://artifacts.swamp-club.com/swamp/20260207.123456.0-sha.abc12345/binary/darwin/aarch64/swamp-stable-binary-darwin-aarch64.tar.gz";
  assertEquals(
    parseVersionFromRedirectUrl(url),
    "20260207.123456.0-sha.abc12345",
  );
});

Deno.test("parseVersionFromRedirectUrl returns null for non-matching URL", () => {
  assertEquals(parseVersionFromRedirectUrl("https://example.com/foo"), null);
});

Deno.test("parseVersionFromRedirectUrl handles URL with dev sha", () => {
  const url =
    "https://artifacts.swamp-club.com/swamp/20260206.200442.0-sha./binary/darwin/aarch64/swamp-stable-binary-darwin-aarch64.tar.gz";
  assertEquals(parseVersionFromRedirectUrl(url), "20260206.200442.0-sha.");
});

// --- UpdateService.check tests ---

Deno.test("check returns up_to_date when no redirect", async () => {
  const service = new UpdateService(
    createMockChecker(null),
    "20260207.123456.0-sha.abc12345",
    missingBinaryPath,
  );

  const result = await service.check(platform);
  assertEquals(result.status, "up_to_date");
  if (result.status === "up_to_date") {
    assertEquals(result.currentVersion, "20260207.123456.0-sha.abc12345");
  }
});

Deno.test("check returns up_to_date when versions match", async () => {
  const redirectUrl =
    "https://artifacts.swamp-club.com/swamp/20260207.123456.0-sha.abc12345/binary/darwin/aarch64/swamp-stable-binary-darwin-aarch64.tar.gz";
  const service = new UpdateService(
    createMockChecker(redirectUrl),
    "20260207.123456.0-sha.abc12345",
    missingBinaryPath,
  );

  const result = await service.check(platform);
  assertEquals(result.status, "up_to_date");
});

Deno.test("check returns update_available when versions differ", async () => {
  const redirectUrl =
    "https://artifacts.swamp-club.com/swamp/20260208.000000.0-sha.def56789/binary/darwin/aarch64/swamp-stable-binary-darwin-aarch64.tar.gz";
  const service = new UpdateService(
    createMockChecker(redirectUrl),
    "20260207.123456.0-sha.abc12345",
    missingBinaryPath,
  );

  const result = await service.check(platform);
  assertEquals(result.status, "update_available");
  if (result.status === "update_available") {
    assertEquals(result.currentVersion, "20260207.123456.0-sha.abc12345");
    assertEquals(result.latestVersion, "20260208.000000.0-sha.def56789");
  }
});

Deno.test("check includes warning for dev build", async () => {
  const service = new UpdateService(
    createMockChecker(null),
    "20260206.200442.0-sha.",
    missingBinaryPath,
  );

  const result = await service.check(platform);
  assertEquals(result.status, "up_to_date");
  assertEquals(typeof result.warning, "string");
  assertEquals(result.warning?.includes("development build"), true);
});

Deno.test("check has no warning for release build", async () => {
  const service = new UpdateService(
    createMockChecker(null),
    "20260207.123456.0-sha.abc12345",
    missingBinaryPath,
  );

  const result = await service.check(platform);
  assertEquals(result.warning, undefined);
});

// --- UpdateService.update tests ---

Deno.test("update returns up_to_date when already current", async () => {
  const redirectUrl =
    "https://artifacts.swamp-club.com/swamp/20260207.123456.0-sha.abc12345/binary/darwin/aarch64/swamp-stable-binary-darwin-aarch64.tar.gz";
  const service = new UpdateService(
    createMockChecker(redirectUrl),
    "20260207.123456.0-sha.abc12345",
    missingBinaryPath,
  );

  const result = await service.update(platform);
  assertEquals(result.status, "up_to_date");
});

Deno.test("update returns updated when new version available", async () => {
  const redirectUrl =
    "https://artifacts.swamp-club.com/swamp/20260208.000000.0-sha.def56789/binary/darwin/aarch64/swamp-stable-binary-darwin-aarch64.tar.gz";
  const calls: MockCheckerCalls = {
    downloadUrls: [],
    checksumUrls: [],
    expectedChecksums: [],
  };
  const service = new UpdateService(
    createMockChecker(redirectUrl, calls),
    "20260207.123456.0-sha.abc12345",
    missingBinaryPath,
  );

  const result = await service.update(platform);
  assertEquals(result.status, "updated");
  if (result.status === "updated") {
    assertEquals(result.previousVersion, "20260207.123456.0-sha.abc12345");
    assertEquals(result.newVersion, "20260208.000000.0-sha.def56789");
  }
  // Verify download used the resolved versioned URL, not the stable URL
  assertEquals(calls.downloadUrls, [redirectUrl]);
});

Deno.test("update includes warning for dev build", async () => {
  const redirectUrl =
    "https://artifacts.swamp-club.com/swamp/20260208.000000.0-sha.def56789/binary/darwin/aarch64/swamp-stable-binary-darwin-aarch64.tar.gz";
  const service = new UpdateService(
    createMockChecker(redirectUrl),
    "20260206.200442.0-sha.",
    missingBinaryPath,
  );

  const result = await service.update(platform);
  assertEquals(result.status, "updated");
  assertEquals(typeof result.warning, "string");
  assertEquals(result.warning?.includes("development build"), true);
});

// --- Redirect URL validation tests ---

Deno.test("check rejects redirect to untrusted host", async () => {
  const redirectUrl =
    "https://evil.com/swamp/20260208.000000.0-sha.def56789/binary/darwin/aarch64/swamp.tar.gz";
  const service = new UpdateService(
    createMockChecker(redirectUrl),
    "20260207.123456.0-sha.abc12345",
    missingBinaryPath,
  );

  await assertRejects(
    () => service.check(platform),
    UserError,
    "Untrusted redirect host",
  );
});

Deno.test("update rejects redirect to untrusted host", async () => {
  const redirectUrl =
    "https://evil.com/swamp/20260208.000000.0-sha.def56789/binary/darwin/aarch64/swamp.tar.gz";
  const service = new UpdateService(
    createMockChecker(redirectUrl),
    "20260207.123456.0-sha.abc12345",
    missingBinaryPath,
  );

  await assertRejects(
    () => service.update(platform),
    UserError,
    "Untrusted redirect host",
  );
});

// --- Checksum flow tests ---

Deno.test("update fetches checksum and passes it to downloadAndInstall", async () => {
  const redirectUrl =
    "https://artifacts.swamp-club.com/swamp/20260208.000000.0-sha.def56789/binary/darwin/aarch64/swamp-stable-binary-darwin-aarch64.tar.gz";
  const expectedHash = "b".repeat(64);
  const calls: MockCheckerCalls = {
    downloadUrls: [],
    checksumUrls: [],
    expectedChecksums: [],
  };
  const service = new UpdateService(
    createMockChecker(redirectUrl, calls, expectedHash),
    "20260207.123456.0-sha.abc12345",
    missingBinaryPath,
  );

  const result = await service.update(platform);
  assertEquals(result.status, "updated");
  assertEquals(calls.checksumUrls, [redirectUrl]);
  assertEquals(calls.expectedChecksums, [expectedHash]);
});

Deno.test("update passes the signal to every checker call and the options to the download", async () => {
  const redirectUrl =
    "https://artifacts.swamp-club.com/swamp/20260208.000000.0-sha.def56789/binary/darwin/aarch64/swamp-stable-binary-darwin-aarch64.tar.gz";
  const signals: (AbortSignal | undefined)[] = [];
  let downloadOptions: DownloadOptions | undefined;
  const checker: UpdateChecker = {
    checkForUpdate: (_platform, signal) => {
      signals.push(signal);
      return Promise.resolve(redirectUrl);
    },
    fetchChecksum: (_url, signal) => {
      signals.push(signal);
      return Promise.resolve("a".repeat(64));
    },
    downloadAndInstall: (_url, _binaryPath, _checksum, options) => {
      downloadOptions = options;
      return Promise.resolve();
    },
  };
  const service = new UpdateService(
    checker,
    "20260207.123456.0-sha.abc12345",
    missingBinaryPath,
  );
  const controller = new AbortController();
  const onProgress = () => {};

  await service.update(platform, { signal: controller.signal, onProgress });

  assertEquals(signals, [controller.signal, controller.signal]);
  assertEquals(downloadOptions?.signal, controller.signal);
  assertEquals(downloadOptions?.onProgress, onProgress);
});

Deno.test("update stops before the checksum fetch once the signal is aborted", async () => {
  const redirectUrl =
    "https://artifacts.swamp-club.com/swamp/20260208.000000.0-sha.def56789/binary/darwin/aarch64/swamp-stable-binary-darwin-aarch64.tar.gz";
  const controller = new AbortController();
  const calls: MockCheckerCalls = {
    downloadUrls: [],
    checksumUrls: [],
    expectedChecksums: [],
  };
  const mock = createMockChecker(redirectUrl, calls);
  const checker: UpdateChecker = {
    ...mock,
    checkForUpdate: (p) => {
      // Ctrl+C lands just as the update check returns.
      controller.abort();
      return mock.checkForUpdate(p);
    },
  };
  const service = new UpdateService(
    checker,
    "20260207.123456.0-sha.abc12345",
    missingBinaryPath,
  );

  const error = await assertRejects(() =>
    service.update(platform, { signal: controller.signal })
  );

  assertEquals((error as DOMException).name, "AbortError");
  assertEquals(calls.checksumUrls, []);
  assertEquals(calls.downloadUrls, []);
});

// --- Pre-flight permission check tests ---

// chmod mode bits are POSIX-only, and root ignores them.
const modeBitsIgnored = Deno.build.os === "windows" || Deno.uid() === 0;

Deno.test({
  name:
    "update replaces a read-only binary when its directory is writable (swamp-club#3817)",
  ignore: modeBitsIgnored,
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    try {
      const readOnlyFile = join(tempDir, "swamp");
      await Deno.writeTextFile(readOnlyFile, "binary");
      await Deno.chmod(readOnlyFile, 0o555);
      const calls: MockCheckerCalls = {
        downloadUrls: [],
        checksumUrls: [],
        expectedChecksums: [],
      };
      const redirectUrl =
        "https://artifacts.swamp-club.com/swamp/20260208.000000.0-sha.def56789/binary/darwin/aarch64/swamp-stable-binary-darwin-aarch64.tar.gz";
      const service = new UpdateService(
        createMockChecker(redirectUrl, calls),
        "20260207.123456.0-sha.abc12345",
        readOnlyFile,
      );

      const result = await service.update(platform);

      assertEquals(result.status, "updated");
      assertEquals(calls.downloadUrls, [redirectUrl]);
      // The write probe leaves nothing behind
      const entries = [];
      for await (const entry of Deno.readDir(tempDir)) entries.push(entry.name);
      assertEquals(entries, ["swamp"]);
    } finally {
      await Deno.chmod(join(tempDir, "swamp"), 0o644).catch(() => {});
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "update rejects with UserError before downloading when the binary's directory is not writable",
  ignore: modeBitsIgnored,
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    const binDir = join(tempDir, "bin");
    try {
      await Deno.mkdir(binDir);
      const binaryPath = join(binDir, "swamp");
      await Deno.writeTextFile(binaryPath, "binary");
      await Deno.chmod(binDir, 0o555);
      const calls: MockCheckerCalls = {
        downloadUrls: [],
        checksumUrls: [],
        expectedChecksums: [],
      };
      const redirectUrl =
        "https://artifacts.swamp-club.com/swamp/20260208.000000.0-sha.def56789/binary/darwin/aarch64/swamp-stable-binary-darwin-aarch64.tar.gz";
      const service = new UpdateService(
        createMockChecker(redirectUrl, calls),
        "20260207.123456.0-sha.abc12345",
        binaryPath,
      );

      const error = await assertRejects(
        () => service.update(platform),
        UserError,
      );

      assertStringIncludes(
        error.message,
        `Cannot update ${binaryPath}: permission denied.`,
      );
      // The test user owns the directory, so the hint is chmod, not sudo
      assertStringIncludes(error.message, `chmod u+w ${binDir}`);
      assert(!error.message.includes("sudo swamp update"));
      assert(!error.message.includes("sudo chown"));
      assertEquals(calls.checksumUrls, []);
      assertEquals(calls.downloadUrls, []);
    } finally {
      await Deno.chmod(binDir, 0o755).catch(() => {});
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test("update proceeds when binary path is writable", async () => {
  const tempDir = await Deno.makeTempDir();
  const writableFile = `${tempDir}/swamp`;
  await Deno.writeTextFile(writableFile, "binary");

  const redirectUrl =
    "https://artifacts.swamp-club.com/swamp/20260208.000000.0-sha.def56789/binary/darwin/aarch64/swamp-stable-binary-darwin-aarch64.tar.gz";
  const service = new UpdateService(
    createMockChecker(redirectUrl),
    "20260207.123456.0-sha.abc12345",
    writableFile,
  );

  const result = await service.update(platform);
  assertEquals(result.status, "updated");

  await Deno.remove(tempDir, { recursive: true });
});

Deno.test("update proceeds when binary does not exist yet", async () => {
  const service = new UpdateService(
    createMockChecker(null),
    "20260207.123456.0-sha.abc12345",
    "/tmp/nonexistent-swamp-binary-path",
  );

  const result = await service.update(platform);
  assertEquals(result.status, "up_to_date");
});

Deno.test({
  name:
    "update replaces the user's own binary in a sticky directory (swamp-club#3822)",
  ignore: modeBitsIgnored,
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    try {
      await Deno.chmod(tempDir, 0o1777);
      const binaryPath = join(tempDir, "swamp");
      await Deno.writeTextFile(binaryPath, "binary");
      const calls: MockCheckerCalls = {
        downloadUrls: [],
        checksumUrls: [],
        expectedChecksums: [],
      };
      const redirectUrl =
        "https://artifacts.swamp-club.com/swamp/20260208.000000.0-sha.def56789/binary/darwin/aarch64/swamp-stable-binary-darwin-aarch64.tar.gz";
      const service = new UpdateService(
        createMockChecker(redirectUrl, calls),
        "20260207.123456.0-sha.abc12345",
        binaryPath,
      );

      const result = await service.update(platform);

      assertEquals(result.status, "updated");
      assertEquals(calls.downloadUrls, [redirectUrl]);
    } finally {
      await Deno.chmod(tempDir, 0o755).catch(() => {});
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "update rejects before downloading when a sticky directory holds another user's binary (swamp-club#3822)",
  ignore: modeBitsIgnored,
  fn: async () => {
    const tempDir = await Deno.makeTempDir();
    try {
      const binaryPath = join(tempDir, "swamp");
      await Deno.writeTextFile(binaryPath, "binary");
      const otherUid = Deno.uid()! + 1;
      const calls: MockCheckerCalls = {
        downloadUrls: [],
        checksumUrls: [],
        expectedChecksums: [],
      };
      const redirectUrl =
        "https://artifacts.swamp-club.com/swamp/20260208.000000.0-sha.def56789/binary/darwin/aarch64/swamp-stable-binary-darwin-aarch64.tar.gz";
      // Only root can give a file to another user, so the owners are faked
      const service = new UpdateService(
        createMockChecker(redirectUrl, calls),
        "20260207.123456.0-sha.abc12345",
        binaryPath,
        () =>
          Promise.resolve({
            dirMode: 0o41777,
            dirOwnerUid: 0,
            binaryOwnerUid: otherUid,
          }),
      );

      const error = await assertRejects(
        () => service.update(platform),
        UserError,
      );

      assertStringIncludes(
        error.message,
        `Cannot update ${binaryPath}: permission denied.`,
      );
      assertStringIncludes(error.message, `${tempDir} is a sticky directory`);
      assertStringIncludes(error.message, `(uid ${otherUid})`);
      assertStringIncludes(error.message, "sudo swamp update");
      assertStringIncludes(error.message, `sudo chown`);
      assert(!error.message.includes("immutable flag"));
      assertEquals(calls.checksumUrls, []);
      assertEquals(calls.downloadUrls, []);
    } finally {
      await Deno.remove(tempDir, { recursive: true });
    }
  },
});

// --- permissionDeniedMessage tests ---

const posixFacts = {
  os: "darwin" as const,
  binaryPath: "/Users/alice/.local/bin/swamp",
  dirWritable: false,
  homeDir: "/Users/alice",
  currentUid: 501,
  userName: "alice",
};

Deno.test("permissionDeniedMessage: Windows suggests running as Administrator", () => {
  const message = permissionDeniedMessage({
    os: "windows",
    dirWritable: false,
    binaryPath: "C:\\swamp\\swamp.exe",
    dirOwnerUid: null,
    currentUid: null,
  });
  assertEquals(
    message,
    "Cannot update C:\\swamp\\swamp.exe: permission denied. Try running the terminal as Administrator.",
  );
});

Deno.test("permissionDeniedMessage: a root-owned system directory suggests sudo swamp update", () => {
  const message = permissionDeniedMessage({
    ...posixFacts,
    binaryPath: "/usr/local/bin/swamp",
    dirOwnerUid: 0,
  });
  assertEquals(
    message,
    "Cannot update /usr/local/bin/swamp: permission denied. Re-run with: sudo swamp update",
  );
});

Deno.test("permissionDeniedMessage: a root-owned directory under HOME gives the chown fix, not sudo swamp update", () => {
  const message = permissionDeniedMessage({ ...posixFacts, dirOwnerUid: 0 });
  assertStringIncludes(
    message,
    "Cannot update /Users/alice/.local/bin/swamp: permission denied.",
  );
  assertStringIncludes(message, "owned by another user (uid 0)");
  assertStringIncludes(message, "sudo chown alice /Users/alice/.local/bin");
  assertStringIncludes(message, "run swamp update without sudo");
  assert(!message.includes("sudo swamp update"));
});

Deno.test("permissionDeniedMessage: a directory the user owns gives the chmod fix", () => {
  const message = permissionDeniedMessage({ ...posixFacts, dirOwnerUid: 501 });
  assertStringIncludes(message, "is owned by you but is not writable");
  assertStringIncludes(message, "chmod u+w /Users/alice/.local/bin");
  assert(!message.includes("sudo swamp update"));
  assert(!message.includes("sudo chown"));
});

Deno.test("permissionDeniedMessage: a directory another non-root user owns gives the chown fix", () => {
  const message = permissionDeniedMessage({
    ...posixFacts,
    os: "linux",
    binaryPath: "/opt/tools/bin/swamp",
    dirOwnerUid: 1002,
  });
  assertStringIncludes(message, "/opt/tools/bin is owned by another user");
  assertStringIncludes(message, "sudo chown alice /opt/tools/bin");
  assert(!message.includes("sudo swamp update"));
});

Deno.test("permissionDeniedMessage: HOME unset treats a root-owned directory as a system location", () => {
  const message = permissionDeniedMessage({
    ...posixFacts,
    homeDir: undefined,
    dirOwnerUid: 0,
  });
  assertStringIncludes(message, "Re-run with: sudo swamp update");
});

Deno.test("permissionDeniedMessage: an unreadable directory owner falls back to sudo swamp update", () => {
  const message = permissionDeniedMessage({ ...posixFacts, dirOwnerUid: null });
  assertStringIncludes(message, "Re-run with: sudo swamp update");
});

Deno.test("permissionDeniedMessage: USER unset names the user with whoami", () => {
  const message = permissionDeniedMessage({
    ...posixFacts,
    userName: undefined,
    dirOwnerUid: 0,
  });
  assertStringIncludes(message, "sudo chown $(whoami) /Users/alice/.local/bin");
});

Deno.test("permissionDeniedMessage: a sibling of HOME with a shared prefix is not under HOME", () => {
  const message = permissionDeniedMessage({
    ...posixFacts,
    binaryPath: "/Users/alice2/bin/swamp",
    dirOwnerUid: 0,
  });
  assertStringIncludes(message, "Re-run with: sudo swamp update");
});

Deno.test("permissionDeniedMessage: a writable directory means the binary itself is protected", () => {
  const message = permissionDeniedMessage({
    ...posixFacts,
    dirWritable: true,
    dirOwnerUid: 501,
  });
  assertStringIncludes(message, "protected against replacement");
  assertStringIncludes(message, "immutable flag");
  assert(!message.includes("sudo swamp update"));
  assert(!message.includes("sudo chown"));
  assert(!message.includes("chmod"));
});

Deno.test("permissionDeniedMessage: root denied gives neither sudo nor chown advice", () => {
  const message = permissionDeniedMessage({
    ...posixFacts,
    binaryPath: "/usr/local/bin/swamp",
    currentUid: 0,
    dirOwnerUid: 0,
  });
  assertStringIncludes(message, "even as root");
  assert(!message.includes("sudo swamp update"));
  assert(!message.includes("sudo chown"));
});

Deno.test("permissionDeniedMessage: a HOME subdirectory whose name starts with .. is under HOME", () => {
  const message = permissionDeniedMessage({
    ...posixFacts,
    binaryPath: "/Users/alice/..tools/swamp",
    dirOwnerUid: 0,
  });
  assertStringIncludes(message, "sudo chown alice /Users/alice/..tools");
});

// --- needlessRootUpdateWarning tests ---

const stickyFacts = {
  ...posixFacts,
  binaryPath: "/opt/shared/swamp",
  dirWritable: true,
  dirSticky: true,
  dirOwnerUid: 0,
  binaryOwnerUid: 502,
};

Deno.test("permissionDeniedMessage: another user's binary in a sticky directory gives sudo and take-ownership fixes", () => {
  const message = permissionDeniedMessage(stickyFacts);
  assertStringIncludes(
    message,
    "/opt/shared is a sticky directory and the binary is owned by another user (uid 502)",
  );
  assertStringIncludes(message, "sudo swamp update");
  assertStringIncludes(message, "sudo chown alice /opt/shared/swamp");
  assert(!message.includes("immutable flag"));
});

Deno.test("stickyDirectoryBlocksReplace: blocks only a non-root user who owns neither the binary nor the directory", () => {
  assertEquals(stickyDirectoryBlocksReplace(stickyFacts), true);
  // The binary's owner, the directory's owner and root may rename over it
  assertEquals(
    stickyDirectoryBlocksReplace({ ...stickyFacts, binaryOwnerUid: 501 }),
    false,
  );
  assertEquals(
    stickyDirectoryBlocksReplace({ ...stickyFacts, dirOwnerUid: 501 }),
    false,
  );
  assertEquals(
    stickyDirectoryBlocksReplace({ ...stickyFacts, currentUid: 0 }),
    false,
  );
  assertEquals(
    stickyDirectoryBlocksReplace({ ...stickyFacts, dirSticky: false }),
    false,
  );
  assertEquals(
    stickyDirectoryBlocksReplace({ ...stickyFacts, binaryOwnerUid: null }),
    false,
  );
  assertEquals(
    stickyDirectoryBlocksReplace({ ...stickyFacts, currentUid: null }),
    false,
  );
  assertEquals(
    stickyDirectoryBlocksReplace({ ...stickyFacts, os: "windows" }),
    false,
  );
});

Deno.test("permissionDeniedMessage: a sticky directory with an unknown binary owner names both causes", () => {
  const message = permissionDeniedMessage({
    ...stickyFacts,
    binaryOwnerUid: null,
  });
  assertStringIncludes(message, "protected against replacement");
  assertStringIncludes(message, "immutable flag (chflags or chattr)");
  assertStringIncludes(message, "/opt/shared is a sticky directory");
  assert(!message.includes("sudo"));
});

Deno.test("needlessRootUpdateWarning: sudo into the invoking user's own directory warns", () => {
  const warning = needlessRootUpdateWarning(
    "/Users/alice/.local/bin/swamp",
    0,
    501,
    501,
  );
  assertStringIncludes(warning ?? "", "owned by uid 501");
  assertStringIncludes(warning ?? "", "run swamp update without sudo");
});

Deno.test("needlessRootUpdateWarning: sudo into a directory another user owns does not warn", () => {
  // e.g. a Homebrew prefix owned by a dedicated user: sudo was needed
  assertEquals(
    needlessRootUpdateWarning(
      "/home/linuxbrew/.linuxbrew/bin/swamp",
      0,
      501,
      1002,
    ),
    undefined,
  );
});

Deno.test("needlessRootUpdateWarning: root without sudo does not warn", () => {
  // A root scheduler has no SUDO_UID
  assertEquals(
    needlessRootUpdateWarning("/Users/alice/.local/bin/swamp", 0, null, 501),
    undefined,
  );
});

Deno.test("needlessRootUpdateWarning: root updating into a root-owned directory does not warn", () => {
  assertEquals(
    needlessRootUpdateWarning("/usr/local/bin/swamp", 0, 501, 0),
    undefined,
  );
});

Deno.test("needlessRootUpdateWarning: a non-root update does not warn", () => {
  assertEquals(
    needlessRootUpdateWarning("/Users/alice/.local/bin/swamp", 501, null, 501),
    undefined,
  );
});

Deno.test("needlessRootUpdateWarning: an unreadable directory owner does not warn", () => {
  assertEquals(
    needlessRootUpdateWarning("/Users/alice/.local/bin/swamp", 0, 501, null),
    undefined,
  );
});
