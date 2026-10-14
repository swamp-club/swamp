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
import { withMockedCommand } from "@swamp-club/swamp-testing";
import {
  hostLitestreamProcesses,
  isLitestreamFor,
  isSupervisorFor,
  SUPERVISOR_MARKER,
} from "./litestream_processes.ts";

const DB = "/private/tmp/d/commits.db";

Deno.test("isSupervisorFor: the marker and this database, whatever the build or timings", () => {
  assertEquals(
    isSupervisorFor(
      `/usr/local/bin/swamp ${SUPERVISOR_MARKER} --db ${DB} --idle-ms 300000`,
      DB,
    ),
    true,
  );
  assertEquals(
    isSupervisorFor(
      `/opt/deno run -A /src/entry.ts ${SUPERVISOR_MARKER} --db ${DB} --idle-ms 2000`,
      DB,
    ),
    true,
  );
  assertEquals(
    isSupervisorFor(`swamp ${SUPERVISOR_MARKER} --db /other/commits.db`, DB),
    false,
  );
  assertEquals(isSupervisorFor(`vim ${DB}`, DB), false);
  assertEquals(isSupervisorFor(undefined, DB), false);
});

Deno.test("isLitestreamFor: replicate with this database's config only", () => {
  const config = "/tmp/swamp-501/abcd1234/litestream.yml";
  assertEquals(
    isLitestreamFor(`litestream replicate -config ${config}`, config),
    true,
  );
  assertEquals(
    isLitestreamFor(`litestream restore -config ${config}`, config),
    false,
  );
  assertEquals(
    isLitestreamFor("litestream replicate -config /etc/x.yml", config),
    false,
  );
  assertEquals(isLitestreamFor(undefined, config), false);
});

Deno.test({
  name:
    "hostLitestreamProcesses.commandLine: asks ps for the whole line on macOS, in the C locale",
  ignore: Deno.build.os !== "darwin",
  async fn() {
    const { result, calls } = await withMockedCommand(
      [{ stdout: "litestream replicate -config /c.yml\n", code: 0 }],
      () => hostLitestreamProcesses.commandLine(42),
    );
    assertEquals(result, "litestream replicate -config /c.yml");
    assertEquals(calls[0].args, ["-ww", "-o", "command=", "-p", "42"]);
  },
});

Deno.test({
  name:
    "hostLitestreamProcesses.commandLine: a pid ps cannot read is unreadable",
  ignore: Deno.build.os !== "darwin",
  async fn() {
    const { result } = await withMockedCommand(
      [{ stdout: "", code: 1 }],
      () => hostLitestreamProcesses.commandLine(42),
    );
    assertEquals(result, undefined);
  },
});

Deno.test("hostLitestreamProcesses: this process is alive, and signalling a gone pid is harmless", () => {
  assertEquals(hostLitestreamProcesses.isAlive(Deno.pid), true);
  // Pids this high are never handed out.
  assertEquals(hostLitestreamProcesses.isAlive(2 ** 22 + 12345), false);
  hostLitestreamProcesses.signal(2 ** 22 + 12345, "SIGTERM");
});
