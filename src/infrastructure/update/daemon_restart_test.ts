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
import {
  type DaemonRestartOutcome,
  type DaemonRestartTarget,
  restartDaemonsAfterUpdate,
} from "./daemon_restart.ts";

function target(
  name: string,
  outcome: DaemonRestartOutcome | Error,
  calls: string[],
): DaemonRestartTarget {
  return {
    name,
    scheduler: () =>
      Promise.resolve({
        restart: () => {
          calls.push(name);
          return outcome instanceof Error
            ? Promise.reject(outcome)
            : Promise.resolve(outcome);
        },
      }),
  };
}

Deno.test("restartDaemonsAfterUpdate: lists every daemon that restarted", async () => {
  const calls: string[] = [];
  const result = await restartDaemonsAfterUpdate([
    target("worker", "restarted", calls),
    target("serve", "restarted", calls),
  ]);
  assertEquals(result, { restarted: ["worker", "serve"] });
  assertEquals(calls, ["worker", "serve"]);
});

Deno.test("restartDaemonsAfterUpdate: a stopped or absent daemon is not listed and is no error", async () => {
  const calls: string[] = [];
  const result = await restartDaemonsAfterUpdate([
    target("worker", "not_running", calls),
    target("serve", "not_installed", calls),
  ]);
  assertEquals(result, { restarted: [] });
  assertEquals(calls, ["worker", "serve"]);
});

Deno.test("restartDaemonsAfterUpdate: a failing restart is recorded and the next daemon is still restarted", async () => {
  const calls: string[] = [];
  const result = await restartDaemonsAfterUpdate([
    target("worker", new Error("systemctl try-restart failed"), calls),
    target("serve", "restarted", calls),
  ]);
  assertEquals(result, {
    restarted: ["serve"],
    error: "worker: systemctl try-restart failed",
  });
  assertEquals(calls, ["worker", "serve"]);
});

Deno.test("restartDaemonsAfterUpdate: a scheduler that cannot be created is recorded, not thrown", async () => {
  const calls: string[] = [];
  const result = await restartDaemonsAfterUpdate([
    {
      name: "worker",
      scheduler: () => Promise.reject(new Error("systemctl was not found")),
    },
    target("serve", "restarted", calls),
  ]);
  assertEquals(result, {
    restarted: ["serve"],
    error: "worker: systemctl was not found",
  });
});
