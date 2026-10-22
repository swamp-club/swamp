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
import { dispatchTraceCarrier, traceCarrier } from "./observability.ts";

const owner = {
  traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
  tracestate: "vendor=value",
};
Deno.test("traceCarrier: rejects malformed, oversized and zero context without rejecting execution", () => {
  for (
    const input of [
      null,
      1,
      [],
      {},
      { traceparent: "x" },
      {
        traceparent: owner.traceparent.replace(
          "b7ad6b7169203331",
          "0000000000000000",
        ),
      },
      { ...owner, tracestate: "x".repeat(513) },
      { ...owner, tracestate: "a=b\n" },
    ]
  ) {
    assertEquals(traceCarrier(input), undefined);
  }
  assertEquals(traceCarrier(owner), owner);
});
Deno.test("dispatchTraceCarrier: accepts a nested parent only in the authorized trace with matching sampling", () => {
  const child = {
    ...owner,
    traceparent: owner.traceparent.replace(
      "b7ad6b7169203331",
      "b7ad6b7169203332",
    ),
  };
  assertEquals(dispatchTraceCarrier(owner, child), child);
  for (
    const input of [undefined, {}, {
      traceparent: child.traceparent.replace("-01", "-00"),
    }, { traceparent: child.traceparent.replace("0af7", "1af7") }]
  ) {
    assertEquals(dispatchTraceCarrier(owner, input), owner);
  }
  assertEquals(dispatchTraceCarrier(undefined, child), undefined);
});
