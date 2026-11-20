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

import { assertEquals, assertRejects } from "@std/assert";
import type { BridgePort } from "./bridge.ts";
import { isAppMessage } from "./bridge.ts";
import { BridgeTransport } from "./bridge_transport.ts";

function port(): BridgePort & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    onmessage: null,
    postMessage: (message) => sent.push(message),
    close() {},
  };
}

Deno.test("BridgeTransport: an older bridge fails with what to do", async () => {
  const fake = port();
  const transport = new BridgeTransport(fake);
  fake.onmessage?.({
    data: {
      kind: "init",
      bridge: 999,
      app: {},
      theme: {},
      connected: true,
      path: "/",
    },
  });
  await assertRejects(() => transport.ready, Error, "Rebuild the app");
});

Deno.test("isAppMessage: refuses frames without a usable id", () => {
  assertEquals(isAppMessage({ kind: "frame", frame: { type: "x" } }), false);
  assertEquals(
    isAppMessage({ kind: "frame", frame: { type: "x", id: "" } }),
    false,
  );
  assertEquals(
    isAppMessage({ kind: "frame", frame: { type: "x", id: "a".repeat(129) } }),
    false,
  );
  assertEquals(
    isAppMessage({ kind: "frame", frame: { type: "x", id: "a" } }),
    true,
  );
  assertEquals(isAppMessage({ kind: "navigate", path: 3 }), false);
  assertEquals(isAppMessage(null), false);
});
