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
import { waitFor } from "@swamp-club/swamp-testing";
import {
  stdinShutdownTrigger,
  watchStdinClose,
} from "./stdin_close_trigger.ts";

interface FakeStdin {
  readonly stream: ReadableStream<Uint8Array>;
  readonly pulls: () => number;
  readonly write: (bytes: Uint8Array) => void;
  readonly close: () => void;
  readonly fail: (error: Error) => void;
}

function fakeStdin(): FakeStdin {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    pull() {
      pulls++;
    },
  }, { highWaterMark: 0 });
  return {
    stream,
    pulls: () => pulls,
    write: (bytes) => controller.enqueue(bytes),
    close: () => controller.close(),
    fail: (error) => controller.error(error),
  };
}

Deno.test("watchStdinClose: end of file calls onClose once", async () => {
  const stdin = fakeStdin();
  let closes = 0;
  const watching = watchStdinClose(() => stdin.stream, () => {
    closes++;
  });
  stdin.close();
  await watching;
  assertEquals(closes, 1);
});

Deno.test("watchStdinClose: data on an open stdin does not call onClose", async () => {
  const stdin = fakeStdin();
  let closes = 0;
  const watching = watchStdinClose(() => stdin.stream, () => {
    closes++;
  });
  await waitFor(() => stdin.pulls() >= 1, "first read of stdin");
  stdin.write(new Uint8Array([1, 2, 3]));
  await waitFor(() => stdin.pulls() >= 2, "read after the first chunk");
  stdin.write(new Uint8Array([4]));
  await waitFor(() => stdin.pulls() >= 3, "read after the second chunk");
  assertEquals(closes, 0);
  stdin.close();
  await watching;
  assertEquals(closes, 1);
});

Deno.test("watchStdinClose: a failed read calls onClose once", async () => {
  const stdin = fakeStdin();
  let closes = 0;
  const watching = watchStdinClose(() => stdin.stream, () => {
    closes++;
  });
  stdin.fail(new Error("broken pipe"));
  await watching;
  assertEquals(closes, 1);
});

Deno.test("watchStdinClose: a stdin already closed calls onClose", async () => {
  const stdin = fakeStdin();
  stdin.close();
  let closes = 0;
  await watchStdinClose(() => stdin.stream, () => {
    closes++;
  });
  assertEquals(closes, 1);
});

Deno.test("watchStdinClose: a stdin that cannot be opened calls onClose once and resolves", async () => {
  let closes = 0;
  await watchStdinClose(() => {
    throw new Error("bad resource id");
  }, () => {
    closes++;
  });
  assertEquals(closes, 1);
});

Deno.test("watchStdinClose: a shutdown that rejects does not reject the watch", async () => {
  const stdin = fakeStdin();
  stdin.close();
  let closes = 0;
  await watchStdinClose(() => stdin.stream, () => {
    closes++;
    return Promise.reject(new Error("shutdown failed"));
  });
  assertEquals(closes, 1);
});

Deno.test("stdinShutdownTrigger: without the flag stdin is never opened", () => {
  let opened = 0;
  let shutdowns = 0;
  const watching = stdinShutdownTrigger(false, () => {
    opened++;
    return fakeStdin().stream;
  }, () => {
    shutdowns++;
    return Promise.resolve();
  });
  assertEquals(watching, undefined);
  assertEquals(opened, 0);
  assertEquals(shutdowns, 0);
});

Deno.test("stdinShutdownTrigger: with the flag end of file starts the shutdown once", async () => {
  const stdin = fakeStdin();
  let shutdowns = 0;
  const watching = stdinShutdownTrigger(true, () => stdin.stream, () => {
    shutdowns++;
    return Promise.resolve();
  });
  assertEquals(shutdowns, 0);
  stdin.close();
  await watching;
  assertEquals(shutdowns, 1);
});
