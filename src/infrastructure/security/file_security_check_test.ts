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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  checkFileNotBroadlyReadable,
  matchBroadAce,
  parseIcaclsOutput,
} from "./file_security_check.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-file-sec-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native handles yet.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test({
  name: "checkFileNotBroadlyReadable: POSIX 0o600 file is ok",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "secure");
      await Deno.writeTextFile(path, "secret", { mode: 0o600 });

      const result = await checkFileNotBroadlyReadable(path);
      assertEquals(result.ok, true);
    });
  },
});

Deno.test({
  name:
    "checkFileNotBroadlyReadable: POSIX 0o644 file is rejected with chmod hint",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "insecure");
      await Deno.writeTextFile(path, "secret", { mode: 0o644 });

      const result = await checkFileNotBroadlyReadable(path);
      assertEquals(result.ok, false);
      if (!result.ok) {
        assertStringIncludes(result.reason, "insecure permissions");
        assertStringIncludes(result.reason, "0o644");
        assertStringIncludes(result.reason, "chmod 600");
        assertStringIncludes(result.reason, path);
      }
    });
  },
});

Deno.test({
  name: "checkFileNotBroadlyReadable: POSIX 0o640 (group readable) is rejected",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "groupread");
      await Deno.writeTextFile(path, "secret", { mode: 0o640 });

      const result = await checkFileNotBroadlyReadable(path);
      assertEquals(result.ok, false);
      if (!result.ok) {
        assertStringIncludes(result.reason, "0o640");
      }
    });
  },
});

Deno.test({
  name: "checkFileNotBroadlyReadable: Windows file restricted to owner is ok",
  ignore: Deno.build.os !== "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "secure.txt");
      await Deno.writeTextFile(path, "secret");
      // Strip inheritance and grant only the current user — mimics what a
      // hardened vault file should look like on Windows.
      const username = Deno.env.get("USERNAME");
      if (username && username.length > 0) {
        const icacls = new Deno.Command("icacls", {
          args: [path, "/inheritance:r", "/grant:r", `${username}:F`],
          stdin: "null",
          stdout: "null",
          stderr: "null",
        });
        await icacls.output();
      }

      const result = await checkFileNotBroadlyReadable(path);
      assertEquals(result.ok, true, JSON.stringify(result));
    });
  },
});

Deno.test({
  name:
    "checkFileNotBroadlyReadable: Windows file with Everyone:Read is rejected",
  ignore: Deno.build.os !== "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "broad.txt");
      await Deno.writeTextFile(path, "secret");
      // Grant Everyone Read access to simulate a leaked ACL.
      const icacls = new Deno.Command("icacls", {
        args: [path, "/grant", "Everyone:(R)"],
        stdin: "null",
        stdout: "null",
        stderr: "null",
      });
      const grantResult = await icacls.output();
      assertEquals(grantResult.code, 0, "icacls grant failed");

      const result = await checkFileNotBroadlyReadable(path);
      assertEquals(result.ok, false, JSON.stringify(result));
      if (!result.ok) {
        assertStringIncludes(result.reason, "insecure ACL");
        assertStringIncludes(result.reason, "Everyone");
      }
    });
  },
});

Deno.test({
  name: "checkFileNotBroadlyReadable: Windows path with newline fails closed",
  ignore: Deno.build.os !== "windows",
  fn: async () => {
    // Defensive: paths containing CR/LF/NUL never reach the icacls
    // command — we refuse them up front.
    const result = await checkFileNotBroadlyReadable("C:\\bogus\nfile.txt");
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.reason, "Could not verify ACL");
      assertStringIncludes(result.reason, "unsupported characters");
    }
  },
});

// --- icacls parser unit tests (run on every platform) ---
//
// The full Windows path is gated on `Deno.build.os === "windows"`, but the
// pure-string icacls parser/matcher can be exercised on macOS and Linux —
// covering it here means CI catches a parser regression on every PR.

Deno.test("parseIcaclsOutput: typical multi-line output", () => {
  const path = "C:\\path\\to\\file.txt";
  const stdout = [
    "C:\\path\\to\\file.txt Everyone:(R)",
    "                       BUILTIN\\Users:(RX)",
    "                       BUILTIN\\Administrators:(F)",
    "                       DOMAIN\\user:(F)",
    "",
    "Successfully processed 1 files; Failed processing 0 files",
    "",
  ].join("\r\n");

  const aces = parseIcaclsOutput(stdout, path);
  assertEquals(aces.length, 4);
  assertEquals(aces[0], { principal: "Everyone", rights: "(R)" });
  assertEquals(aces[1], { principal: "BUILTIN\\Users", rights: "(RX)" });
  assertEquals(aces[2], {
    principal: "BUILTIN\\Administrators",
    rights: "(F)",
  });
  assertEquals(aces[3], { principal: "DOMAIN\\user", rights: "(F)" });
});

Deno.test("parseIcaclsOutput: handles inheritance flags inline", () => {
  const path = "C:\\dir";
  const stdout = [
    "C:\\dir Everyone:(OI)(CI)(R)",
    "       BUILTIN\\Users:(OI)(CI)(RX)",
    "",
    "Successfully processed 1 files; Failed processing 0 files",
  ].join("\r\n");

  const aces = parseIcaclsOutput(stdout, path);
  assertEquals(aces.length, 2);
  assertEquals(aces[0].principal, "Everyone");
  assertEquals(aces[0].rights, "(OI)(CI)(R)");
});

Deno.test("parseIcaclsOutput: skips localised summary line without parens", () => {
  const path = "C:\\file";
  const stdout = [
    "C:\\file DOMAIN\\user:(F)",
    "",
    "Es wurden 1 Dateien erfolgreich verarbeitet", // German summary, no parens
  ].join("\r\n");

  const aces = parseIcaclsOutput(stdout, path);
  assertEquals(aces.length, 1);
  assertEquals(aces[0].principal, "DOMAIN\\user");
});

Deno.test("parseIcaclsOutput: tolerates LF-only line endings", () => {
  const path = "/tmp/file";
  const stdout = "/tmp/file Everyone:(R)\n          DOMAIN\\u:(F)\n";
  const aces = parseIcaclsOutput(stdout, path);
  assertEquals(aces.length, 2);
  assertEquals(aces[0].principal, "Everyone");
  assertEquals(aces[1].principal, "DOMAIN\\u");
});

Deno.test("parseIcaclsOutput: handles case-mismatched path prefix", () => {
  const path = "C:\\Users\\foo\\file.txt";
  // icacls sometimes normalises the casing on the leading path.
  const stdout = "c:\\users\\foo\\file.txt Everyone:(R)\r\n";
  const aces = parseIcaclsOutput(stdout, path);
  assertEquals(aces.length, 1);
  assertEquals(aces[0].principal, "Everyone");
});

Deno.test("parseIcaclsOutput: empty stdout yields no aces", () => {
  assertEquals(parseIcaclsOutput("", "C:\\x"), []);
});

Deno.test("matchBroadAce: Everyone with Read flagged", () => {
  assertEquals(
    matchBroadAce({ principal: "Everyone", rights: "(R)" }),
    "Everyone",
  );
});

Deno.test("matchBroadAce: Everyone with FullControl flagged", () => {
  assertEquals(
    matchBroadAce({ principal: "Everyone", rights: "(F)" }),
    "Everyone",
  );
});

Deno.test("matchBroadAce: BUILTIN\\Users with ReadAndExecute flagged", () => {
  assertEquals(
    matchBroadAce({ principal: "BUILTIN\\Users", rights: "(OI)(CI)(RX)" }),
    "BUILTIN\\Users",
  );
});

Deno.test("matchBroadAce: Authenticated Users with Modify flagged", () => {
  assertEquals(
    matchBroadAce({
      principal: "NT AUTHORITY\\Authenticated Users",
      rights: "(M)",
    }),
    "NT AUTHORITY\\Authenticated Users",
  );
});

Deno.test("matchBroadAce: SID form for Everyone flagged", () => {
  assertEquals(
    matchBroadAce({ principal: "S-1-1-0", rights: "(R)" }),
    "Everyone",
  );
});

Deno.test("matchBroadAce: Administrators not flagged", () => {
  assertEquals(
    matchBroadAce({ principal: "BUILTIN\\Administrators", rights: "(F)" }),
    null,
  );
});

Deno.test("matchBroadAce: domain user not flagged", () => {
  assertEquals(
    matchBroadAce({ principal: "DOMAIN\\alice", rights: "(F)" }),
    null,
  );
});

Deno.test("matchBroadAce: Everyone with Write-only is not flagged", () => {
  // (W) alone doesn't grant read; current rule treats it as acceptable.
  assertEquals(
    matchBroadAce({ principal: "Everyone", rights: "(W)" }),
    null,
  );
});

Deno.test("matchBroadAce: Everyone with generic-read alias flagged", () => {
  assertEquals(
    matchBroadAce({ principal: "Everyone", rights: "(GR)" }),
    "Everyone",
  );
});

Deno.test("matchBroadAce: case-insensitive principal match", () => {
  // icacls reliably emits "Everyone", but match is case-insensitive
  // defensively to handle locale or version variation.
  assertEquals(
    matchBroadAce({ principal: "EVERYONE", rights: "(R)" }),
    "Everyone",
  );
});
