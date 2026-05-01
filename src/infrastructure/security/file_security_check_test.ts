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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { checkFileNotBroadlyReadable } from "./file_security_check.ts";

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
    // Defensive: paths containing CR/LF/NUL never reach the PowerShell
    // command — we refuse them up front.
    const result = await checkFileNotBroadlyReadable("C:\\bogus\nfile.txt");
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.reason, "Could not verify ACL");
      assertStringIncludes(result.reason, "unsupported characters");
    }
  },
});
