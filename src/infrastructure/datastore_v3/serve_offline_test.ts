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
import { initializeLogging } from "../logging/logger.ts";
import {
  anyServeOffline,
  enterServeOffline,
  modelOfLockKey,
  noteQueuedOffline,
  queuedOfflineAt,
  recordServeClock,
  reportQueuedOffline,
  resetServeOffline,
  resetServeOfflineForTesting,
  serveClockOf,
  serveOfflineAt,
  type ServeOfflineNotice,
  setServeOfflineNoticeWriter,
} from "./serve_offline.ts";

await initializeLogging({});

Deno.test("recordServeClock: measures serve's clock against the midpoint of the exchange, from the Date header's second", () => {
  resetServeOfflineForTesting();
  const sentAt = Date.parse("2026-10-30T10:00:00.000Z");
  // Serve answered in the second 10:05:00, the exchange took 200ms.
  recordServeClock(
    "https://serve.test",
    new Date("2026-10-30T10:05:00.000Z").toUTCString(),
    sentAt,
    sentAt + 200,
  );
  assertEquals(serveClockOf("https://serve.test"), {
    offsetMs: 5 * 60_000 + 500 - 100,
    uncertaintyMs: 1_100,
    measuredAt: sentAt + 200,
  });
  // No header, or one that does not parse, keeps the last measurement.
  recordServeClock("https://serve.test", null, sentAt, sentAt);
  recordServeClock("https://serve.test", "not a date", sentAt, sentAt);
  assertEquals(serveClockOf("https://serve.test")?.offsetMs, 300_400);
  assertEquals(serveClockOf("https://other.test"), undefined);
});

Deno.test("enterServeOffline: lasts until the command ends, and an entry keeps its first state", () => {
  resetServeOfflineForTesting();
  assertEquals(anyServeOffline(), false);
  enterServeOffline("/tmp/root", {
    serveUrl: "https://serve.test",
    since: 1,
    clockOffsetMs: 42,
  }, "refused");
  enterServeOffline("/tmp/root", { serveUrl: "x", since: 2 }, "again");
  assertEquals(serveOfflineAt("/tmp/root")?.clockOffsetMs, 42);
  assertEquals(serveOfflineAt("/tmp/other"), undefined);
  noteQueuedOffline("/tmp/root", crypto.randomUUID());
  noteQueuedOffline("/tmp/root", crypto.randomUUID());
  assertEquals(queuedOfflineAt("/tmp/root"), 2);
  resetServeOffline();
  assertEquals(anyServeOffline(), false);
  assertEquals(queuedOfflineAt("/tmp/root"), 0);
});

Deno.test("modelOfLockKey: names the behavior of a model lock key, and nothing else", () => {
  assertEquals(
    modelOfLockKey(
      "data/@org/aws/ec2/0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a01/.lock",
    ),
    { type: "@org/aws/ec2", id: "0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a01" },
  );
  assertEquals(
    modelOfLockKey(
      "workflow-run-claims/0b6c4bb4-9d61-4f0c-9a43-6f0c1f7b2a01/.lock",
    ),
    undefined,
  );
  assertEquals(modelOfLockKey("data/x/.lock"), undefined);
});

Deno.test("reportQueuedOffline: in json mode, says going offline and, once the command ends, what it queued, with each txnId", () => {
  resetServeOfflineForTesting();
  const notices: ServeOfflineNotice[] = [];
  setServeOfflineNoticeWriter((notice) => notices.push(notice));
  try {
    enterServeOffline("/tmp/root", {
      serveUrl: "https://serve.test",
      since: 1,
      lastContactAt: "2026-10-30T09:00:00.000Z",
    }, "refused");
    noteQueuedOffline("/tmp/root", "t-1");
    noteQueuedOffline("/tmp/root", "t-2");
    // Nothing said per commit: the command's result comes first.
    assertEquals(notices.map((notice) => notice.notice), [
      "datastore_offline",
    ]);
    reportQueuedOffline();
    const queued = notices[1];
    assertEquals(queued.notice, "datastore_offline_queued");
    if (queued.notice === "datastore_offline_queued") {
      assertEquals(queued.queued, 2);
      assertEquals(queued.txnIds, ["t-1", "t-2"]);
    }
  } finally {
    setServeOfflineNoticeWriter(undefined);
    resetServeOfflineForTesting();
  }
});

Deno.test("reportQueuedOffline: says nothing in log mode, or when nothing was queued", () => {
  resetServeOfflineForTesting();
  enterServeOffline(
    "/tmp/root",
    { serveUrl: "https://serve.test", since: 1 },
    "x",
  );
  noteQueuedOffline("/tmp/root", "t-1");
  reportQueuedOffline();
  const notices: ServeOfflineNotice[] = [];
  setServeOfflineNoticeWriter((notice) => notices.push(notice));
  try {
    enterServeOffline("/tmp/other", {
      serveUrl: "https://serve.test",
      since: 1,
    }, "x");
    resetServeOffline();
    enterServeOffline("/tmp/other", {
      serveUrl: "https://serve.test",
      since: 1,
    }, "x");
    reportQueuedOffline();
    assertEquals(
      notices.filter((notice) => notice.notice === "datastore_offline_queued"),
      [],
    );
  } finally {
    setServeOfflineNoticeWriter(undefined);
    resetServeOfflineForTesting();
  }
});
