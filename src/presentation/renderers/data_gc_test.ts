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
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { createDataGcRenderer, renderDataGcPreview } from "./data_gc.ts";

await initializeLogging({});

function captureStdout(fn: () => void): string {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(
      args.map((a) => typeof a === "string" ? a : String(a)).join(" "),
    );
  };
  try {
    fn();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

Deno.test("renderDataGcPreview: json mode emits both expired and version-gc fields", () => {
  const out = captureStdout(() =>
    renderDataGcPreview({
      items: [
        {
          type: "aws/s3-bucket",
          modelId: "m1",
          dataName: "d1",
          reason: "duration-expired",
        },
      ],
      versionGcItems: [
        {
          type: "command/shell",
          modelId: "m2",
          versionsWouldBeRemoved: 3,
          bytesWouldBeReclaimed: 256,
        },
        {
          type: "command/shell",
          modelId: "m3",
          versionsWouldBeRemoved: 2,
          bytesWouldBeReclaimed: 128,
        },
      ],
    }, "json")
  );
  const parsed = JSON.parse(out);
  assertEquals(parsed.expiredDataCount, 1);
  assertEquals(parsed.expiredData.length, 1);
  assertEquals(parsed.versionGcModelCount, 2);
  assertEquals(parsed.versionGcVersionCount, 5);
  assertEquals(parsed.versionGcData.length, 2);
});

Deno.test("renderDataGcPreview: json mode with no version-gc work reports zeroes", () => {
  const out = captureStdout(() =>
    renderDataGcPreview({
      items: [],
      versionGcItems: [],
    }, "json")
  );
  const parsed = JSON.parse(out);
  assertEquals(parsed.expiredDataCount, 0);
  assertEquals(parsed.versionGcModelCount, 0);
  assertEquals(parsed.versionGcVersionCount, 0);
});

Deno.test("renderDataGcPreview: log mode omits version-gc line when empty", () => {
  // Should not throw; the log-mode branch writes via the logger (not console.log),
  // so we just verify nothing was written to console.log.
  const out = captureStdout(() =>
    renderDataGcPreview({
      items: [
        {
          type: "aws/s3-bucket",
          modelId: "m1",
          dataName: "d1",
          reason: "duration-expired",
        },
      ],
      versionGcItems: [],
    }, "log")
  );
  assertEquals(out, "");
});

Deno.test("renderDataGcPreview: log mode includes version-gc data when present", () => {
  // Log mode routes through the logger — this test just asserts the call doesn't
  // throw with a populated versionGcItems array.
  renderDataGcPreview({
    items: [],
    versionGcItems: [
      {
        type: "command/shell",
        modelId: "m2",
        versionsWouldBeRemoved: 3,
        bytesWouldBeReclaimed: 256,
      },
    ],
  }, "log");
});

Deno.test("createDataGcRenderer: json completed handler includes versionsDeleted and bytesReclaimed", () => {
  const renderer = createDataGcRenderer("json");
  const handlers = renderer.handlers();
  const out = captureStdout(() =>
    handlers.completed({
      kind: "completed",
      data: {
        dataEntriesExpired: 3,
        versionsDeleted: 42,
        bytesReclaimed: 8192,
        dryRun: false,
        expiredEntries: [],
        walPagesTotal: 0,
        walPagesCheckpointed: 0,
      },
    })
  );
  const parsed = JSON.parse(out);
  assertEquals(parsed.versionsDeleted, 42);
  assertEquals(parsed.bytesReclaimed, 8192);
  assertEquals(parsed.dataEntriesExpired, 3);
});

Deno.test("createDataGcRenderer: log completed handler does not throw", () => {
  const renderer = createDataGcRenderer("log");
  const handlers = renderer.handlers();
  handlers.completed({
    kind: "completed",
    data: {
      dataEntriesExpired: 5,
      versionsDeleted: 100,
      bytesReclaimed: 16384,
      dryRun: false,
      expiredEntries: [],
      walPagesTotal: 0,
      walPagesCheckpointed: 0,
    },
  });
});

Deno.test("renderDataGcPreview: json output is valid JSON", () => {
  const out = captureStdout(() =>
    renderDataGcPreview({
      items: [],
      versionGcItems: [
        {
          type: "command/shell",
          modelId: "m2",
          versionsWouldBeRemoved: 7,
          bytesWouldBeReclaimed: 4096,
        },
      ],
    }, "json")
  );
  // Should parse; and the raw output should include the versionGc payload key.
  JSON.parse(out);
  assertStringIncludes(out, "versionGcData");
});
