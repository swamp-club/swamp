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

// The datastore sync coordinator's SIGINT handler releases every held lock
// and then calls Deno.exit(130), so it cannot run in-process: this test
// spawns a child deno script (not the swamp CLI), as tls_trust_test.ts
// does. Moved here from datastore_sync_coordinator_test.ts
// (swamp-club#2859), with its elapsed-time assertion replaced by work
// done: the child reports READY once its lock is registered and RELEASED
// from the lock's release(), so the test asserts the release ran.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";

const REPO_ROOT = fromFileUrl(new URL("..", import.meta.url));
const COORDINATOR_URL = new URL(
  "../src/infrastructure/persistence/datastore_sync_coordinator.ts",
  import.meta.url,
).href;

/**
 * A child that registers one lock whose release() runs `releaseBody`, prints
 * READY, then blocks until the SIGINT handler exits it.
 */
function childProgram(releaseBody: string): string {
  return `
import { registerDatastoreSyncNamed } from ${JSON.stringify(COORDINATOR_URL)};

const lock = {
  async acquire() {},
  async release() { ${releaseBody} },
  async withLock(fn) {
    await this.acquire();
    try { return await fn(); } finally { await this.release(); }
  },
  async inspect() { return null; },
  async forceRelease() { return false; },
};

await registerDatastoreSyncNamed("sigint-fixture", { lock });
console.log("READY");

// Block forever: the SIGINT handler's Deno.exit(130) ends this process.
await new Promise(() => {});
`;
}

/** Reads until `marker` appears or the stream ends; returns what was read. */
async function readUntil(
  reader: ReadableStreamDefaultReader<string>,
  marker: string,
): Promise<string> {
  let text = "";
  while (!text.includes(marker)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += value;
  }
  return text;
}

async function readRest(
  reader: ReadableStreamDefaultReader<string>,
): Promise<string> {
  let text = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) return text;
    text += value;
  }
}

interface SigintRun {
  code: number;
  signal: Deno.Signal | null;
  beforeSignal: string;
  afterSignal: string;
  stderr: string;
}

/** Spawns the child, waits for READY, sends SIGINT and collects the exit. */
async function runChildAndInterrupt(program: string): Promise<SigintRun> {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "-"],
    // deno.json at the repo root resolves the coordinator's imports.
    cwd: REPO_ROOT,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    // Hang guard, not a timing assertion: a child that never exits is
    // killed, so the test fails on its exit status instead of stalling CI.
    signal: AbortSignal.timeout(60_000),
  }).spawn();
  const stderr = new Response(child.stderr).text();
  const writer = child.stdin.getWriter();
  try {
    await writer.write(new TextEncoder().encode(program));
  } finally {
    await writer.close();
  }

  const stdout = child.stdout.pipeThrough(new TextDecoderStream())
    .getReader();
  const beforeSignal = await readUntil(stdout, "READY");
  if (!beforeSignal.includes("READY")) {
    await stdout.cancel();
    const status = await child.status;
    throw new Error(
      `child exited ${status.code} before registering its lock:\n${await stderr}`,
    );
  }
  child.kill("SIGINT");
  const afterSignal = await readRest(stdout);
  const status = await child.status;
  return {
    code: status.code,
    signal: status.signal,
    beforeSignal,
    afterSignal,
    stderr: await stderr,
  };
}

Deno.test({
  name:
    "datastore sync SIGINT handler: releases every held lock, then exits 130 (POSIX)",
  // Windows has no SIGINT to send to a child process.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const run = await runChildAndInterrupt(
      childProgram(`console.log("RELEASED");`),
    );

    // Exit 130 with no terminating signal: the handler called
    // Deno.exit(130) rather than the default SIGINT action killing it.
    assertEquals(
      { code: run.code, signal: run.signal },
      { code: 130, signal: null },
      run.stderr,
    );
    assertStringIncludes(run.afterSignal, "RELEASED");
    assertEquals(run.beforeSignal.includes("RELEASED"), false);
  },
});

Deno.test({
  name:
    "datastore sync SIGINT handler: force-exits 130 when a lock release never settles (POSIX)",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const run = await runChildAndInterrupt(
      childProgram(
        `console.log("RELEASE_STARTED"); await new Promise(() => {}); console.log("RELEASED");`,
      ),
    );

    // The release never settles, so only the handler's force-exit fallback
    // can end the process with 130.
    assertEquals(
      { code: run.code, signal: run.signal },
      { code: 130, signal: null },
      run.stderr,
    );
    assertStringIncludes(run.afterSignal, "RELEASE_STARTED");
    assertEquals(run.afterSignal.includes("RELEASED"), false);
  },
});
