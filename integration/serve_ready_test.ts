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
  name: "swamp serve: /ready returns 200 and /health returns 200 after startup",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const repoDir = await Deno.makeTempDir({ prefix: "swamp-serve-ready-" });
    try {
      await initializeTestRepo(repoDir);

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
        stderr: "null",
      });
      const child = cmd.spawn();

      try {
        const listeningLine = await waitForLine(
          child.stdout,
          (line) => line.includes('"status":"listening"'),
          15_000,
        );

        const listening = JSON.parse(listeningLine);
        const port = listening.port;
        const baseUrl = `http://127.0.0.1:${port}`;

        assertEquals(typeof listening.mode, "string");

        const readyRes = await fetch(`${baseUrl}/ready`);
        assertEquals(readyRes.status, 200);
        const readyBody = await readyRes.json();
        assertEquals(readyBody.status, "ready");
        assertEquals(typeof readyBody.mode, "string");

        const healthRes = await fetch(`${baseUrl}/health`);
        assertEquals(healthRes.status, 200);
        const healthBody = await healthRes.json();
        assertEquals(healthBody.status, "ok");

        child.kill("SIGINT");
        await Promise.race([
          child.status,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("serve did not exit")), 6_000)
          ),
        ]);
      } finally {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already dead
        }
        try {
          await child.status;
        } catch {
          // Status already consumed
        }
      }
    } finally {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "swamp serve: JSON listening event includes mode field",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const repoDir = await Deno.makeTempDir({
      prefix: "swamp-serve-mode-json-",
    });
    try {
      await initializeTestRepo(repoDir);

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
        stderr: "null",
      });
      const child = cmd.spawn();

      try {
        const listeningLine = await waitForLine(
          child.stdout,
          (line) => line.includes('"status":"listening"'),
          15_000,
        );

        const listening = JSON.parse(listeningLine);
        assertEquals(listening.mode, "local");

        child.kill("SIGINT");
        await Promise.race([
          child.status,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("serve did not exit")), 6_000)
          ),
        ]);
      } finally {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already dead
        }
        try {
          await child.status;
        } catch {
          // Status already consumed
        }
      }
    } finally {
      await Deno.remove(repoDir, { recursive: true }).catch(() => {});
    }
  },
});
