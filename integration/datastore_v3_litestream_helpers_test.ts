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

import { assertEquals, assertThrows } from "@std/assert";
import { hostLitestreamProcesses } from "../src/infrastructure/datastore_v3/litestream/litestream_processes.ts";
import { killSidecarAtTeardown } from "./datastore_v3_litestream_helpers.ts";

/** Runs `fn` with the host's group signal replaced by `signalGroup`. */
function withSignalGroup(
  signalGroup: typeof hostLitestreamProcesses.signalGroup,
  fn: (sent: string[]) => void,
): void {
  const original = hostLitestreamProcesses.signalGroup;
  const originalSignal = hostLitestreamProcesses.signal;
  const sent: string[] = [];
  Object.assign(hostLitestreamProcesses, {
    signal: (pid: number, signal: Deno.Signal) => sent.push(`${signal} ${pid}`),
    signalGroup: (pgid: number, signal: Deno.Signal) => {
      sent.push(`${signal} -${pgid}`);
      signalGroup(pgid, signal);
    },
  });
  try {
    fn(sent);
  } finally {
    Object.assign(hostLitestreamProcesses, {
      signal: originalSignal,
      signalGroup: original,
    });
  }
}

Deno.test("killSidecarAtTeardown: a group that already exited (EPERM on macOS) is not a teardown failure (swamp-club#4148)", () => {
  withSignalGroup(() => {
    throw new Deno.errors.PermissionDenied("EPERM: Operation not permitted");
  }, (sent) => {
    killSidecarAtTeardown(4242);
    assertEquals(sent, ["SIGCONT 4242", "SIGKILL -4242"]);
  });
});

Deno.test("killSidecarAtTeardown: any other failure still fails the teardown", () => {
  withSignalGroup(() => {
    throw new Error("unexpected");
  }, () => {
    assertThrows(() => killSidecarAtTeardown(4242), Error, "unexpected");
  });
});
