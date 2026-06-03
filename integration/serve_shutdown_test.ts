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

// Stream-0 regression net for `swamp serve` SIGINT shutdown on POSIX.
// `serve` registers SIGINT/SIGTERM listeners that flip a shutdown flag,
// stop scheduled/webhook services, and abort the HTTP listener so
// `await server.finished` resolves cleanly. Stream C will refactor
// signal handling to be cross-platform; this test pins the POSIX
// happy path so a regression there fails loudly.

import { assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { initializeTestRepo } from "./test_helpers.ts";

const PROJECT_ROOT = join(dirname(fromFileUrl(import.meta.url)), "..");

const CLI_LAUNCH_ARGS = [
  "run",
  "--config",
  join(PROJECT_ROOT, "deno.json"),
  "--unstable-bundle",
  "--allow-read",
  "--allow-write",
  "--allow-env",
  "--allow-run",
  "--allow-sys",
  "--allow-net",
  join(PROJECT_ROOT, "main.ts"),
];

/**
 * Reads stderr/stdout line-by-line via a TextDecoder stream and resolves
 * once `predicate` matches a line, or rejects after `timeoutMs`.
 */
async function waitForLine(
  stream: ReadableStream<Uint8Array>,
  predicate: (line: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const start = Date.now();
  try {
    while (true) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `timed out after ${timeoutMs}ms waiting for line; buffer was: ${buffer}`,
        );
      }
      const { done, value } = await reader.read();
      if (done) {
        throw new Error(
          `stream closed before predicate matched; buffer was: ${buffer}`,
        );
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (predicate(line)) {
          return line;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

Deno.test({
  name:
    "swamp serve: SIGINT triggers clean shutdown and the process exits within 6s on POSIX",
  // SIGINT delivery to a child via process.kill is POSIX-only. Stream C
  // adds a Windows-equivalent path; this test pins the POSIX behavior.
  ignore: Deno.build.os === "windows",
  // The subprocess holds resources (sockets, signal listeners) that
  // can leak briefly into the test sanitizer's view depending on
  // process exit timing — the test owns its own process lifecycle.
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const repoDir = await Deno.makeTempDir({ prefix: "swamp-serve-shutdown-" });
    try {
      await initializeTestRepo(repoDir);

      // Bind to port 0 — Deno picks a free port and reports it on the
      // listening event. We don't connect to the port; we just need to
      // know the server is up before signaling.
      const cmd = new Deno.Command(Deno.execPath(), {
        args: [
          ...CLI_LAUNCH_ARGS,
          "--json",
          "serve",
          "--port",
          "0",
          "--no-schedule",
        ],
        cwd: repoDir,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      });
      const child = cmd.spawn();

      try {
        // Wait for the listening signal on stdout — JSON mode prints
        // {"status":"listening", ...} from onListen.
        await waitForLine(
          child.stdout,
          (line) => line.includes('"status":"listening"'),
          15_000,
        );

        // Send SIGINT and wait for clean exit. The shutdown handler
        // aborts the AbortController, server.finished resolves, and
        // the action returns — Deno exits 0 on a normal return.
        child.kill("SIGINT");

        const exitWithin6s = await Promise.race([
          child.status,
          new Promise<{ code: number; success: boolean; signal: null }>(
            (_, reject) => {
              setTimeout(
                () => reject(new Error("serve did not exit within 6s")),
                6_000,
              );
            },
          ),
        ]);

        // Exit code must be a small, expected integer. The current
        // implementation returns from the action and exits 0 on a
        // graceful shutdown; older POSIX convention for SIGINT-killed
        // processes is 130 (128 + 2). Either is acceptable as long as
        // the process exited in time and didn't crash with a
        // different non-zero code.
        assertEquals(
          exitWithin6s.code === 0 || exitWithin6s.code === 130,
          true,
          `expected exit code 0 or 130 from clean SIGINT shutdown; got ${exitWithin6s.code}`,
        );
      } finally {
        // Best-effort cleanup if we threw before the kill (e.g. the
        // listening signal never arrived).
        try {
          child.kill("SIGKILL");
        } catch {
          // Already dead — fine.
        }
        try {
          await child.status;
        } catch {
          // Status already consumed by the race above.
        }
      }
    } finally {
      await Deno.remove(repoDir, { recursive: true });
    }
  },
});
