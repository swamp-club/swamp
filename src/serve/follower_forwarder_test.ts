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

import { assert } from "@std/assert";
import { isFinalFrame, isRpcFrame } from "./follower_forwarder.ts";

Deno.test("isFinalFrame: errors, done frames and plain replies end a request; events and more-to-come replies do not", () => {
  assert(isFinalFrame({ type: "error", id: "1" }, "workflow.run"));
  assert(isFinalFrame({ type: "done", id: "1" }, "workflow.run"));
  assert(!isFinalFrame({ type: "event", id: "1" }, "workflow.run"));
  assert(
    isFinalFrame({ type: "vault.put", id: "1", payload: {} }, "vault.put"),
  );
  assert(
    !isFinalFrame(
      { type: "audit.export", id: "1", payload: { done: false } },
      "audit.export",
    ),
  );
  assert(
    isFinalFrame(
      { type: "audit.export", id: "1", payload: { done: true } },
      "audit.export",
    ),
  );
  assert(!isFinalFrame({ type: "other", id: "1" }, "vault.put"));
  // An attach ends without a reply of its own type.
  assert(isFinalFrame({ type: "run.elsewhere", id: "1" }, "run.attach"));
  assert(isFinalFrame({ type: "run.interrupted", id: "1" }, "run.attach"));
  assert(!isFinalFrame({ type: "run.attached", id: "1" }, "run.attach"));
});

Deno.test("isRpcFrame: only a worker's rpc.* frames", () => {
  assert(isRpcFrame(JSON.stringify({ type: "rpc.request", id: "1" })));
  assert(!isRpcFrame(JSON.stringify({ type: "workflow.run", id: "1" })));
  assert(!isRpcFrame(JSON.stringify({ type: "x", note: '"rpc.' })));
  assert(!isRpcFrame("not json"));
});
