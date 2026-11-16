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

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import { startLoadedWorker } from "./graph_worker.ts";

function fixture(params: Record<string, string>): string {
  const url = new URL("./fixtures/graph_worker_fixture.ts", import.meta.url);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.href;
}

Deno.test("startLoadedWorker: a Worker that loads at once starts once and answers", async () => {
  const messages: unknown[] = [];
  const worker = await startLoadedWorker(fixture({ mode: "now" }), {
    loadTimeoutMs: 30_000,
    attempts: 1,
    onMessage: (message) => messages.push(message),
  });
  try {
    worker.postMessage("ping");
    await waitFor(() => messages.length > 0, "the echo");
    assertEquals(messages, [{ kind: "echo", value: "ping" }]);
  } finally {
    worker.terminate();
  }
});

Deno.test("startLoadedWorker: a start that never loads is terminated and the next start is used", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const flag = join(dir, "starts");
    await Deno.writeTextFile(flag, "0");
    const worker = await startLoadedWorker(
      fixture({ mode: "stall-once", flag }),
      { loadTimeoutMs: 10_000, attempts: 3 },
    );
    worker.terminate();
    assertEquals(await Deno.readTextFile(flag), "2");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
});

Deno.test("startLoadedWorker: a Worker that never loads fails after its attempts, naming the script", async () => {
  const error = await assertRejects(() =>
    startLoadedWorker(fixture({ mode: "never" }), {
      loadTimeoutMs: 200,
      attempts: 2,
    })
  );
  assertStringIncludes((error as Error).message, "graph_worker_fixture.ts");
  assertStringIncludes((error as Error).message, "2 attempt(s)");
});

Deno.test("startLoadedWorker: a Worker that throws while loading fails at once, not after a retry", async () => {
  const error = await assertRejects(() =>
    startLoadedWorker(fixture({ mode: "throw" }), {
      loadTimeoutMs: 30_000,
      attempts: 3,
    })
  );
  assertStringIncludes((error as Error).message, "fixture refused to load");
});

Deno.test("startLoadedWorker: a message posted right after loaded reaches onMessage", async () => {
  const messages: unknown[] = [];
  const worker = await startLoadedWorker(fixture({ mode: "chatty" }), {
    loadTimeoutMs: 30_000,
    attempts: 1,
    onMessage: (message) => messages.push(message),
  });
  try {
    await waitFor(() => messages.length > 0, "the message after loaded");
    assertEquals(messages, [{ kind: "hello" }]);
  } finally {
    worker.terminate();
  }
});
