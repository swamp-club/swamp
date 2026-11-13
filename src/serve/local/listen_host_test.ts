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

import { assert, assertEquals, assertThrows } from "@std/assert";
import { UserError } from "../../domain/errors.ts";
import {
  ListenHost,
  type MachineAddress,
  networkHosts,
} from "./listen_host.ts";

Deno.test("ListenHost.parse: no --host is 127.0.0.1, this machine only", () => {
  const host = ListenHost.parse(undefined);
  assertEquals(host.address, "127.0.0.1");
  assertEquals(host.kind, "loopback");
  assertEquals(host.exposed, false);
});

Deno.test("ListenHost.parse: classifies loopback, wildcard and one interface", () => {
  const cases: Array<[string, string, string, boolean, string]> = [
    ["127.0.0.1", "127.0.0.1", "loopback", false, "127.0.0.1"],
    ["localhost", "127.0.0.1", "loopback", false, "127.0.0.1"],
    [" LocalHost ", "127.0.0.1", "loopback", false, "127.0.0.1"],
    ["::1", "::1", "loopback", false, "::1"],
    ["[::1]", "::1", "loopback", false, "::1"],
    ["0.0.0.0", "0.0.0.0", "wildcard", true, "127.0.0.1"],
    ["::", "::", "wildcard", true, "::1"],
    ["192.168.1.40", "192.168.1.40", "interface", true, "192.168.1.40"],
    ["FD00:0:0::1", "fd00::1", "interface", true, "fd00::1"],
  ];
  for (const [raw, address, kind, exposed, probe] of cases) {
    const host = ListenHost.parse(raw);
    assertEquals(host.address, address, raw);
    assertEquals(host.kind, kind, raw);
    assertEquals(host.exposed, exposed, raw);
    assertEquals(host.probeAddress, probe, raw);
  }
});

Deno.test("ListenHost.parse: refuses names and anything but an IP address, naming the flag and the value", () => {
  for (
    const raw of [
      "devbox",
      "example.com",
      "",
      "256.0.0.1",
      "1.2.3",
      "0.0.0.0:8080",
      "http://0.0.0.0",
      "::g",
    ]
  ) {
    const error = assertThrows(() => ListenHost.parse(raw), UserError);
    assert(error.message.includes("--host"), error.message);
    assert(error.message.includes(JSON.stringify(raw)), error.message);
  }
});

const ADDRESSES: MachineAddress[] = [
  { family: "IPv4", address: "127.0.0.1" },
  { family: "IPv4", address: "192.168.1.40" },
  { family: "IPv4", address: "169.254.3.4" },
  { family: "IPv4", address: "10.0.0.7" },
  { family: "IPv4", address: "192.168.1.40" },
  { family: "IPv6", address: "::1" },
  { family: "IPv6", address: "fe80::1" },
  { family: "IPv6", address: "fd00::1" },
];

Deno.test("networkHosts: loopback serves no other machine", () => {
  assertEquals(networkHosts(ListenHost.DEFAULT, "devbox", ADDRESSES), []);
  assertEquals(networkHosts(ListenHost.parse("::1"), "devbox", ADDRESSES), []);
});

Deno.test("networkHosts: 0.0.0.0 gives the machine name and each routable IPv4 address once", () => {
  assertEquals(
    networkHosts(ListenHost.parse("0.0.0.0"), "DevBox", ADDRESSES),
    ["devbox", "192.168.1.40", "10.0.0.7"],
  );
});

Deno.test("networkHosts: :: gives routable IPv6 addresses in brackets, never link-local", () => {
  assertEquals(
    networkHosts(ListenHost.parse("::"), "devbox", ADDRESSES),
    ["devbox", "[fd00::1]"],
  );
});

Deno.test("networkHosts: a machine called localhost, or with no name, adds only addresses", () => {
  const wildcard = ListenHost.parse("0.0.0.0");
  assertEquals(networkHosts(wildcard, "localhost", ADDRESSES), [
    "192.168.1.40",
    "10.0.0.7",
  ]);
  assertEquals(networkHosts(wildcard, null, ADDRESSES), [
    "192.168.1.40",
    "10.0.0.7",
  ]);
});

Deno.test("networkHosts: one interface address gives only that address", () => {
  assertEquals(
    networkHosts(ListenHost.parse("10.0.0.7"), "devbox", ADDRESSES),
    ["10.0.0.7"],
  );
  assertEquals(
    networkHosts(ListenHost.parse("fd00::1"), "devbox", ADDRESSES),
    ["[fd00::1]"],
  );
});
