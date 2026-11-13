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

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { UserError } from "../../domain/errors.ts";
import { ListenHost } from "../../serve/local/listen_host.ts";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  dashboardUrl,
  hubStopSignals,
  pageReach,
  runStart,
  servingFromOptions,
} from "./start.ts";

await initializeLogging({});

Deno.test("hubStopSignals: swamp start stops on SIGTERM and SIGHUP with their exit codes", () => {
  assertEquals(hubStopSignals("linux", false), [
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ]);
});

Deno.test("hubStopSignals: swamp dashboard ignores SIGHUP and still stops on SIGTERM", () => {
  for (const os of ["linux", "darwin"] as const) {
    assertEquals(hubStopSignals(os, true), [
      ["SIGTERM", 143],
      ["SIGHUP", null],
    ]);
  }
});

Deno.test("hubStopSignals: nothing on Windows, which has neither signal", () => {
  assertEquals(hubStopSignals("windows", true), []);
  assertEquals(hubStopSignals("windows", false), []);
});

Deno.test("dashboardUrl: the repo's page on the given origin, with the token in the fragment", () => {
  assertEquals(
    dashboardUrl("https://box.tail1.ts.net", "tok", "my repo"),
    "https://box.tail1.ts.net/dashboard/w/my%20repo#token=tok",
  );
});

Deno.test("servingFromOptions: no flags serve on 127.0.0.1, any free port, no extra hosts", () => {
  const serving = servingFromOptions({});
  assertEquals(serving.port, 0);
  assertEquals(serving.listenHost.address, "127.0.0.1");
  assertEquals(serving.listenHost.exposed, false);
  assertEquals(serving.trustedHosts.entries, []);
});

Deno.test("servingFromOptions: reads --host, --port and --trusted-hosts", () => {
  const serving = servingFromOptions({
    host: "0.0.0.0",
    port: 8765,
    trustedHosts: "box.tail1.ts.net",
  });
  assertEquals(serving.port, 8765);
  assertEquals(serving.listenHost.address, "0.0.0.0");
  assert(serving.listenHost.exposed);
  assertEquals(serving.trustedHosts.entries, ["box.tail1.ts.net"]);
});

Deno.test("servingFromOptions: a --host that is not an IP address is a UserError", () => {
  assertThrows(
    () => servingFromOptions({ host: "devbox" }),
    UserError,
    "--host",
  );
});

Deno.test("runStart: with --json, --host, --port and --trusted-hosts are refused before anything starts", async () => {
  for (
    const flag of [{ host: "0.0.0.0" }, { port: 8765 }, {
      trustedHosts: "proxy.example",
    }]
  ) {
    await assertRejects(
      () => runStart({ json: true, ...flag }, ["start"]),
      UserError,
      "--host, --port or --trusted-hosts",
    );
  }
});

const urlFor = (origin: string) => `${origin}/dashboard/start#token=t`;

Deno.test("pageReach: one network address is exposed and warned about, though its URL is the one already shown", () => {
  const listenHost = ListenHost.parse("192.168.1.40");
  assertEquals(
    pageReach({
      listenHost,
      networkNames: ["192.168.1.40"],
      port: 8765,
      url: urlFor("http://192.168.1.40:8765"),
      urlFor,
      sshSession: true,
    }),
    { exposed: true, networkUrls: [], sshHint: false },
  );
});

Deno.test("pageReach: 0.0.0.0 lists every other name; loopback over SSH hints instead", () => {
  assertEquals(
    pageReach({
      listenHost: ListenHost.parse("0.0.0.0"),
      networkNames: ["devbox", "10.0.0.7"],
      port: 1,
      url: urlFor("http://127.0.0.1:1"),
      urlFor,
      sshSession: false,
    }),
    {
      exposed: true,
      networkUrls: [urlFor("http://devbox:1"), urlFor("http://10.0.0.7:1")],
      sshHint: false,
    },
  );
  assertEquals(
    pageReach({
      listenHost: ListenHost.DEFAULT,
      networkNames: [],
      port: 1,
      url: urlFor("http://127.0.0.1:1"),
      urlFor,
      sshSession: true,
    }),
    { exposed: false, networkUrls: [], sshHint: true },
  );
});

Deno.test("runStart: with --json, a --host that is not an IP address still gets the --json refusal", async () => {
  await assertRejects(
    () => runStart({ json: true, host: "devbox" }, ["start"]),
    UserError,
    "--host, --port or --trusted-hosts",
  );
});
