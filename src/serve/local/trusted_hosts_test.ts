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
import { TrustedHosts } from "./trusted_hosts.ts";

Deno.test("TrustedHosts.parse: none given trusts nothing", () => {
  assertEquals(TrustedHosts.parse(undefined).entries, []);
  assertEquals(TrustedHosts.NONE.acceptsHost("proxy.example"), false);
});

Deno.test("TrustedHosts.parse: comma-separated as serve takes it, trimmed and lowercased", () => {
  assertEquals(
    TrustedHosts.parse(" Box.tail1.ts.net , proxy.example:8443,[::1]:9 ")
      .entries,
    ["box.tail1.ts.net", "proxy.example:8443", "[::1]:9"],
  );
});

Deno.test("TrustedHosts.parse: refuses anything but host or host:port, naming it", () => {
  for (
    const raw of [
      "https://proxy.example",
      "proxy.example/dashboard",
      "user@proxy.example",
      "*.ts.net",
      "proxy.example:",
      "proxy example",
      "::1",
    ]
  ) {
    const error = assertThrows(() => TrustedHosts.parse(raw), UserError);
    assert(error.message.includes(JSON.stringify(raw)), error.message);
  }
  assertThrows(() => TrustedHosts.parse(" , "), UserError);
});

Deno.test("TrustedHosts.acceptsHost: matches the host name on any port, in any case, and nothing else", () => {
  const trusted = TrustedHosts.parse("proxy.example,[::1]");
  assertEquals(trusted.acceptsHost("proxy.example"), true);
  assertEquals(trusted.acceptsHost("PROXY.EXAMPLE:443"), true);
  assertEquals(trusted.acceptsHost("[::1]:8080"), true);
  for (
    const host of [
      null,
      "proxy.example.",
      "proxy.example:",
      "evil.proxy.example",
      "proxy.example.evil",
      "user@proxy.example",
      "proxy.example/x",
      "",
    ]
  ) {
    assertEquals(trusted.acceptsHost(host), false, String(host));
  }
});

Deno.test("TrustedHosts.acceptsOrigin: only the exact origin of a trusted Host, over http or https", () => {
  const trusted = TrustedHosts.parse("proxy.example");
  assertEquals(
    trusted.acceptsOrigin("https://proxy.example", "proxy.example"),
    true,
  );
  assertEquals(
    trusted.acceptsOrigin("HTTPS://Proxy.Example:8443", "proxy.example:8443"),
    true,
  );
  assertEquals(
    trusted.acceptsOrigin("http://proxy.example", "proxy.example"),
    true,
  );
  assertEquals(
    trusted.acceptsOrigin("https://proxy.example:1", "proxy.example"),
    false,
  );
  assertEquals(
    trusted.acceptsOrigin("https://evil.example", "proxy.example"),
    false,
  );
  assertEquals(
    trusted.acceptsOrigin("https://127.0.0.1:9", "127.0.0.1:9"),
    false,
  );
  assertEquals(trusted.acceptsOrigin("https://proxy.example", null), false);
});
