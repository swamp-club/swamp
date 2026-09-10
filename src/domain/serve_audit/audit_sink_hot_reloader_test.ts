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
import { AuditSinkHotReloader } from "./audit_sink_hot_reloader.ts";
import type { AuditSink } from "./audit_sink.ts";

interface MockSinkLog {
  readonly action: "write" | "flush" | "close";
  readonly sink: string;
}

function createMockSink(
  name: string,
  log: MockSinkLog[],
  opts?: { flushError?: Error; closeError?: Error },
): AuditSink {
  return {
    name,
    durable: false,
    write: (_events) => {
      log.push({ action: "write", sink: name });
      return Promise.resolve();
    },
    flush: () => {
      log.push({ action: "flush", sink: name });
      if (opts?.flushError) return Promise.reject(opts.flushError);
      return Promise.resolve();
    },
    close: () => {
      log.push({ action: "close", sink: name });
      if (opts?.closeError) return Promise.reject(opts.closeError);
      return Promise.resolve();
    },
  };
}

Deno.test("AuditSinkHotReloader: successful reload returns new sinks and closes old ones", async () => {
  const log: MockSinkLog[] = [];
  const oldSink = createMockSink("old-sink", log);
  const newSink = createMockSink("new-sink", log);

  const reloader = new AuditSinkHotReloader();
  const result = await reloader.reload(
    [oldSink],
    () => Promise.resolve([newSink]),
  );

  assertEquals(result.length, 1);
  assertEquals(result[0].name, "new-sink");
  assertEquals(log, [
    { action: "flush", sink: "old-sink" },
    { action: "close", sink: "old-sink" },
  ]);
});

Deno.test("AuditSinkHotReloader: failed rebuild returns old sinks unchanged", async () => {
  const log: MockSinkLog[] = [];
  const oldSink = createMockSink("old-sink", log);

  const reloader = new AuditSinkHotReloader();
  const result = await reloader.reload(
    [oldSink],
    () => Promise.reject(new Error("config invalid")),
  );

  assertEquals(result.length, 1);
  assertEquals(result[0].name, "old-sink");
  assertEquals(log, []);
});

Deno.test("AuditSinkHotReloader: old sink flush error does not block close", async () => {
  const log: MockSinkLog[] = [];
  const oldSink = createMockSink("old-sink", log, {
    flushError: new Error("flush boom"),
  });
  const newSink = createMockSink("new-sink", log);

  const reloader = new AuditSinkHotReloader();
  const result = await reloader.reload(
    [oldSink],
    () => Promise.resolve([newSink]),
  );

  assertEquals(result[0].name, "new-sink");
  assertEquals(log, [
    { action: "flush", sink: "old-sink" },
    { action: "close", sink: "old-sink" },
  ]);
});

Deno.test("AuditSinkHotReloader: old sink close error does not prevent returning new sinks", async () => {
  const log: MockSinkLog[] = [];
  const oldSink = createMockSink("old-sink", log, {
    closeError: new Error("close boom"),
  });
  const newSink = createMockSink("new-sink", log);

  const reloader = new AuditSinkHotReloader();
  const result = await reloader.reload(
    [oldSink],
    () => Promise.resolve([newSink]),
  );

  assertEquals(result[0].name, "new-sink");
  assertEquals(log, [
    { action: "flush", sink: "old-sink" },
    { action: "close", sink: "old-sink" },
  ]);
});

Deno.test("AuditSinkHotReloader: multiple old sinks are all flushed then closed in order", async () => {
  const log: MockSinkLog[] = [];
  const old1 = createMockSink("old-1", log);
  const old2 = createMockSink("old-2", log);
  const newSink = createMockSink("new-sink", log);

  const reloader = new AuditSinkHotReloader();
  const result = await reloader.reload(
    [old1, old2],
    () => Promise.resolve([newSink]),
  );

  assertEquals(result.length, 1);
  assertEquals(log, [
    { action: "flush", sink: "old-1" },
    { action: "flush", sink: "old-2" },
    { action: "close", sink: "old-1" },
    { action: "close", sink: "old-2" },
  ]);
});
