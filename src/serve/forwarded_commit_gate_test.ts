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
import { ForwardedCommitGate } from "./forwarded_commit_gate.ts";

function latch(): { open: () => void; opened: Promise<void> } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => open = resolve);
  return { open, opened };
}

Deno.test("ForwardedCommitGate.run: shared sections run together", async () => {
  const gate = new ForwardedCommitGate();
  const both = latch();
  let most = 0;
  const run = () =>
    gate.run("shared", async () => {
      most = Math.max(most, gate.state.shared);
      if (gate.state.shared === 2) both.open();
      await both.opened;
    });
  await Promise.all([run(), run()]);
  assertEquals(most, 2);
});

Deno.test("ForwardedCommitGate.run: an exclusive section runs alone", async () => {
  const gate = new ForwardedCommitGate();
  const order: string[] = [];
  const first = latch();
  const shared = gate.run("shared", async () => {
    order.push("shared:start");
    await first.opened;
    order.push("shared:end");
  });
  const exclusive = gate.run("exclusive", () => {
    order.push(`exclusive:${gate.state.shared}`);
    return Promise.resolve();
  });
  first.open();
  await Promise.all([shared, exclusive]);
  assertEquals(order, ["shared:start", "shared:end", "exclusive:0"]);
});

Deno.test("ForwardedCommitGate.run: a shared section behind a waiting exclusive one waits for it", async () => {
  const gate = new ForwardedCommitGate();
  const order: string[] = [];
  const first = latch();
  const runs = [
    gate.run("shared", async () => {
      await first.opened;
      order.push("shared-1");
    }),
    gate.run("exclusive", () => {
      order.push("exclusive");
      return Promise.resolve();
    }),
    gate.run("shared", () => {
      order.push("shared-2");
      return Promise.resolve();
    }),
  ];
  assertEquals(gate.state.waiting, 2);
  first.open();
  await Promise.all(runs);
  assertEquals(order, ["shared-1", "exclusive", "shared-2"]);
});

Deno.test("ForwardedCommitGate.run: a failing section leaves the gate", async () => {
  const gate = new ForwardedCommitGate();
  await gate.run("exclusive", () => Promise.reject(new Error("boom"))).catch(
    () => {},
  );
  assertEquals(gate.state, { shared: 0, exclusive: false, waiting: 0 });
  assertEquals(await gate.run("shared", () => Promise.resolve(1)), 1);
});
