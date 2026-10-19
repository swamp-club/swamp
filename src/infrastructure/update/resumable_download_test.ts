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
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { UserError } from "../../domain/errors.ts";
import {
  type DownloadProgress,
  type DownloadRetry,
  formatBytes,
} from "../../domain/update/download_progress.ts";
import { downloadToFile } from "./resumable_download.ts";

const ARCHIVE = new Uint8Array(4096).map((_, i) => i % 251);
const HALF = 2048;
const ETAG = '"archive-v1"';

/** A request the test server saw. */
interface SeenRequest {
  range: string | null;
  ifRange: string | null;
  acceptEncoding: string | null;
}

type Handler = (req: Request, index: number) => Response;

/**
 * Serves each request with `handlers[i]` (the last one repeats) on a port-0
 * server, runs `fn` with the URL, then shuts the server down.
 */
async function withServer<T>(
  handlers: Handler[],
  fn: (url: string, seen: SeenRequest[]) => Promise<T>,
): Promise<T> {
  const seen: SeenRequest[] = [];
  // An IPv4 address, not `localhost`: Windows tries `::1` first, and the
  // refused connect outlasts a short stall timeout before any byte arrives.
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, (req) => {
    const index = seen.length;
    seen.push({
      range: req.headers.get("range"),
      ifRange: req.headers.get("if-range"),
      acceptEncoding: req.headers.get("accept-encoding"),
    });
    return handlers[Math.min(index, handlers.length - 1)](req, index);
  });
  try {
    return await fn(`http://127.0.0.1:${server.addr.port}/swamp.tar.gz`, seen);
  } finally {
    await server.shutdown();
  }
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-download-test-" });
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** The whole archive, with its length and ETag. */
function full(): Response {
  return new Response(ARCHIVE, {
    headers: { "content-length": String(ARCHIVE.length), etag: ETAG },
  });
}

/** The archive from `start` on, as a 206. */
function partial(start: number, contentRangeStart = start): Response {
  return new Response(ARCHIVE.slice(start), {
    status: 206,
    headers: {
      "content-range": `bytes ${contentRangeStart}-${
        ARCHIVE.length - 1
      }/${ARCHIVE.length}`,
      etag: ETAG,
    },
  });
}

/**
 * Answers a request for the archive from `start` (a 200 from zero, else a
 * 206) and sends the bytes up to `end`. Then it either drops the connection
 * or sends nothing more until the client gives up.
 */
function sendThen(
  start: number,
  end: number,
  then: "drop" | "stall",
): Response {
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        if (end > start) {
          controller.enqueue(ARCHIVE.slice(start, end));
          return;
        }
      }
      if (then === "stall") return new Promise<void>(() => {});
      controller.error(new Error("connection dropped"));
    },
  });
  const headers: Record<string, string> = {
    "content-length": String(ARCHIVE.length - start),
    etag: ETAG,
  };
  if (start > 0) {
    headers["content-range"] = `bytes ${start}-${
      ARCHIVE.length - 1
    }/${ARCHIVE.length}`;
  }
  return new Response(body, { status: start > 0 ? 206 : 200, headers });
}

/** The offset a request's `Range` header asks for, or 0 without one. */
function rangeStart(req: Request): number {
  const match = req.headers.get("range")?.match(/^bytes=(\d+)-$/);
  return match ? Number(match[1]) : 0;
}

function recorder() {
  const progress: DownloadProgress[] = [];
  const retries: DownloadRetry[] = [];
  const delays: number[] = [];
  // Each reading of the clock is a second later, so no progress report is
  // throttled away.
  let clock = 0;
  return {
    progress,
    retries,
    delays,
    options: {
      onProgress: (p: DownloadProgress) => progress.push(p),
      onRetry: (r: DownloadRetry) => retries.push(r),
      sleep: (ms: number) => {
        delays.push(ms);
        return Promise.resolve();
      },
      now: () => (clock += 1000),
    },
  };
}

async function assertArchive(path: string): Promise<void> {
  assertEquals(await Deno.readFile(path), ARCHIVE);
}

Deno.test("downloadToFile: downloads the whole body and reports progress up to the total", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "swamp.tar.gz");
    const rec = recorder();
    const seen = await withServer([full], async (url, seen) => {
      await downloadToFile(url, path, rec.options);
      return seen;
    });

    await assertArchive(path);
    assertEquals(seen.length, 1);
    assertEquals(seen[0].acceptEncoding, "identity");
    assertEquals(seen[0].range, null);
    assertEquals(rec.progress[0], {
      receivedBytes: 0,
      totalBytes: ARCHIVE.length,
    });
    assertEquals(rec.progress.at(-1), {
      receivedBytes: ARCHIVE.length,
      totalBytes: ARCHIVE.length,
    });
    for (let i = 1; i < rec.progress.length; i++) {
      assert(
        rec.progress[i].receivedBytes >= rec.progress[i - 1].receivedBytes,
      );
    }
    assertEquals(rec.retries, []);
  });
});

Deno.test("downloadToFile: resumes a dropped connection with Range and If-Range", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "swamp.tar.gz");
    const rec = recorder();
    const seen = await withServer(
      [() => sendThen(0, HALF, "drop"), () => partial(HALF)],
      async (url, seen) => {
        await downloadToFile(url, path, rec.options);
        return seen;
      },
    );

    await assertArchive(path);
    assertEquals(seen.length, 2);
    assertEquals(seen[1].range, `bytes=${HALF}-`);
    assertEquals(seen[1].ifRange, ETAG);
    assertEquals(rec.retries.length, 1);
    assertEquals(rec.retries[0].resumeFromBytes, HALF);
    assertEquals(rec.retries[0].attempt, 1);
    assertEquals(rec.delays, [2000]);
  });
});

Deno.test("downloadToFile: restarts from zero when the server ignores the range", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "swamp.tar.gz");
    const seen = await withServer(
      [() => sendThen(0, HALF, "drop"), full],
      async (url, seen) => {
        await downloadToFile(url, path, recorder().options);
        return seen;
      },
    );

    await assertArchive(path);
    assertEquals(seen.length, 2);
    assertEquals(seen[1].range, `bytes=${HALF}-`);
  });
});

Deno.test("downloadToFile: restarts from zero when the server resumes from the wrong offset", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "swamp.tar.gz");
    const seen = await withServer(
      [
        () => sendThen(0, HALF, "drop"),
        () => partial(HALF, 0),
        full,
      ],
      async (url, seen) => {
        await downloadToFile(url, path, recorder().options);
        return seen;
      },
    );

    await assertArchive(path);
    assertEquals(seen.length, 3);
    assertEquals(seen[2].range, null);
  });
});

Deno.test("downloadToFile: a stalled download fails with what it received once the attempts run out", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "swamp.tar.gz");
    const rec = recorder();
    const error = await withServer(
      [
        () => sendThen(0, HALF, "stall"),
        // Answers the offset asked for, so the retry stalls too even when a
        // loaded runner stalled the first attempt before its bytes arrived. A
        // fixed offset would be refused as the wrong one and restart instead.
        (req) => sendThen(rangeStart(req), rangeStart(req), "stall"),
      ],
      (url) =>
        assertRejects(
          () =>
            downloadToFile(url, path, {
              ...rec.options,
              stallTimeoutMs: 50,
              maxAttempts: 2,
            }),
          UserError,
        ),
    );

    assertStringIncludes(error.message, "no data received for 0.05s");
    // Usually 2.0 KB of 4.0 KB, but on a loaded runner the stall can cut the
    // first attempt short, or fire before any response arrives so the total
    // is never learned. The message is checked against what actually happened.
    const received = (await Deno.stat(path)).size;
    const last = rec.progress.at(-1);
    assertEquals(last?.receivedBytes ?? 0, received);
    assertStringIncludes(
      error.message,
      last
        ? `received ${formatBytes(received)} of 4.0 KB`
        : `received ${formatBytes(received)})`,
    );
    assertStringIncludes(error.message, "Run swamp update again to retry");
    // Usually one retry, but a first request aborted before the server
    // dispatched it leaves the scripted first answer to the retry.
    assert(rec.retries.length > 0);
    for (const retry of rec.retries) {
      assertStringIncludes(retry.reason, "no data received");
    }
  });
});

Deno.test("downloadToFile: an attempt that receives bytes resets the retry budget", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "swamp.tar.gz");
    const quarter = ARCHIVE.length / 4;
    const rec = recorder();
    await withServer(
      [
        () => sendThen(0, quarter, "drop"),
        () => sendThen(quarter, 2 * quarter, "drop"),
        () => sendThen(2 * quarter, 3 * quarter, "drop"),
        () => partial(3 * quarter),
      ],
      (url) => downloadToFile(url, path, { ...rec.options, maxAttempts: 2 }),
    );

    await assertArchive(path);
    assertEquals(rec.retries.map((r) => r.attempt), [1, 1, 1]);
  });
});

Deno.test("downloadToFile: retries a 5xx with growing waits, then gives up", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "swamp.tar.gz");
    const rec = recorder();
    const error = await withServer(
      [() => new Response("busy", { status: 503 })],
      (url) =>
        assertRejects(
          () => downloadToFile(url, path, rec.options),
          UserError,
        ),
    );

    assertStringIncludes(error.message, "after 5 attempts in a row");
    assertStringIncludes(error.message, "HTTP 503");
    assertEquals(rec.delays, [2000, 4000, 8000, 16000]);
  });
});

Deno.test("downloadToFile: a 404 is not retried", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "swamp.tar.gz");
    const rec = recorder();
    const { error, seen } = await withServer(
      [() => new Response("missing", { status: 404 })],
      async (url, seen) => ({
        error: await assertRejects(
          () => downloadToFile(url, path, rec.options),
          UserError,
        ),
        seen,
      }),
    );

    assertEquals(error.message, "Failed to download update: HTTP 404");
    assertEquals(seen.length, 1);
    assertEquals(rec.delays, []);
  });
});

Deno.test("downloadToFile: aborting stops at once with the abort reason and no retry", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "swamp.tar.gz");
    const controller = new AbortController();
    const rec = recorder();
    const { error, seen } = await withServer(
      [() => sendThen(0, HALF, "stall")],
      async (url, seen) => ({
        error: await assertRejects(() =>
          downloadToFile(url, path, {
            ...rec.options,
            signal: controller.signal,
            onProgress: (p) => {
              if (p.receivedBytes > 0) controller.abort();
            },
          })
        ),
        seen,
      }),
    );

    assertInstanceOf(error, DOMException);
    assertEquals((error as DOMException).name, "AbortError");
    assertEquals(seen.length, 1);
    assertEquals(rec.retries, []);
  });
});

Deno.test("downloadToFile: every attempt uses a new HTTP client, so a retry never waits on the stalled connection", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "swamp.tar.gz");
    const clients: { closed: boolean }[] = [];
    const createClient = () => {
      const client = Deno.createHttpClient({});
      const record = { closed: false };
      clients.push(record);
      const close = client.close.bind(client);
      client.close = () => {
        record.closed = true;
        close();
      };
      return client;
    };
    const rec = recorder();
    await withServer(
      [
        () => sendThen(0, HALF, "stall"),
        // Answers the offset asked for: a loaded runner can stall the first
        // attempt before any byte arrives, and the retry then starts from zero.
        (req) => rangeStart(req) > 0 ? partial(rangeStart(req)) : full(),
      ],
      (url) =>
        downloadToFile(url, path, {
          ...rec.options,
          stallTimeoutMs: 50,
          createClient,
        }),
    );

    await assertArchive(path);
    assert(rec.retries.length > 0);
    assertEquals(clients.length, rec.retries.length + 1);
    assert(clients.every((client) => client.closed));
  });
});

Deno.test("downloadToFile: an attempt that restarts from zero and receives bytes still resets the retry budget", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "swamp.tar.gz");
    const rec = recorder();
    await withServer(
      [
        () => sendThen(0, HALF, "drop"),
        // Ignores the range and drops before passing the old offset.
        () => sendThen(0, HALF / 2, "drop"),
        full,
      ],
      (url) => downloadToFile(url, path, { ...rec.options, maxAttempts: 2 }),
    );

    await assertArchive(path);
    assertEquals(rec.retries.map((r) => r.attempt), [1, 1]);
  });
});
