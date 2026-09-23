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
import { detachFrame, settleDetached, settleRequest } from "./stream.ts";

Deno.test("settleRequest: resolves on a payload and rejects on an error", () => {
  assertEquals(
    settleRequest({
      type: "workflow.approve",
      id: "r1",
      payload: { data: {} },
    }),
    { kind: "resolve", value: { data: {} }, detach: false },
  );
  assertEquals(
    settleRequest({
      type: "error",
      id: "r1",
      error: { code: "unauthorized", message: "no" },
    }),
    { kind: "reject", message: "no" },
  );
  assertEquals(settleRequest({ type: "event", id: "r1", event: {} }), {
    kind: "ignore",
  });
});

Deno.test("settleDetached: resolves on the first event and asks to detach", () => {
  assertEquals(
    settleDetached({ type: "event", id: "r1", event: { kind: "started" } }),
    { kind: "resolve", value: undefined, detach: true },
  );
});

Deno.test("settleDetached: resolves on done without detaching", () => {
  assertEquals(settleDetached({ type: "done", id: "r1" }), {
    kind: "resolve",
    value: undefined,
    detach: false,
  });
});

Deno.test("settleDetached: rejects on an error frame", () => {
  assertEquals(
    settleDetached({
      type: "error",
      id: "r1",
      error: { code: "workflow_resume_failed", message: "not suspended" },
    }),
    { kind: "reject", message: "not suspended" },
  );
});

Deno.test("detachFrame: cancels by request id, never by run id", () => {
  // A cancel carrying a run id would cancel the run itself.
  assertEquals(detachFrame("request-7"), { type: "cancel", id: "request-7" });
});
