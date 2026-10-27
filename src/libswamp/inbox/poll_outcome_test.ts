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
import type {
  InboxSummary,
  InboxSummaryResult,
} from "../../infrastructure/http/inbox_schemas.ts";
import { MAX_ETAG_LENGTH } from "../../domain/inbox/inbox_state.ts";
import { toPollOutcome } from "./poll_outcome.ts";

const summary: InboxSummary = {
  unread: 3,
  newestId: "01JBQ0000000000000000000AA",
  newestAt: "2026-10-27T11:00:00Z",
  pollAfterSeconds: 1800,
};

Deno.test("toPollOutcome: ok carries the summary and etag as the snapshot", () => {
  assertEquals(toPollOutcome({ kind: "ok", summary, etag: '"e1"' }), {
    kind: "ok",
    snapshot: { ...summary, etag: '"e1"' },
  });
});

Deno.test("toPollOutcome: ok with no etag keeps it null", () => {
  assertEquals(toPollOutcome({ kind: "ok", summary, etag: null }), {
    kind: "ok",
    snapshot: { ...summary, etag: null },
  });
});

Deno.test("toPollOutcome: an etag the cache cannot store is dropped", () => {
  for (const etag of ['"' + "x".repeat(MAX_ETAG_LENGTH) + '"', '"a\tb"']) {
    const outcome = toPollOutcome({ kind: "ok", summary, etag });
    assertEquals(outcome.kind === "ok" ? outcome.snapshot.etag : "", null);
  }
});

Deno.test("toPollOutcome: an over-long newestAt is dropped", () => {
  const newestAt = "2026-10-27T11:00:00." + "1".repeat(60) + "Z";
  const outcome = toPollOutcome({
    kind: "ok",
    summary: { ...summary, newestAt },
    etag: null,
  });
  assertEquals(outcome.kind === "ok" ? outcome.snapshot.newestAt : "", null);
});

Deno.test("toPollOutcome: every result kind maps to its poll outcome", () => {
  const cases: [InboxSummaryResult, ReturnType<typeof toPollOutcome>][] = [
    [{ kind: "not_modified" }, { kind: "not_modified" }],
    [{ kind: "unsupported" }, { kind: "unsupported" }],
    [{ kind: "unavailable" }, { kind: "unavailable" }],
    [{ kind: "rejected" }, { kind: "rejected" }],
    [{ kind: "backoff" }, { kind: "backoff" }],
    [
      { kind: "backoff", retryAfterSeconds: 120 },
      { kind: "backoff", retryAfterSeconds: 120 },
    ],
    [
      { kind: "failed", reason: "HTTP 500" },
      { kind: "failed", reason: "HTTP 500" },
    ],
  ];
  for (const [result, expected] of cases) {
    assertEquals(toPollOutcome(result), expected);
  }
});
