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

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  misdirectedResponse,
  refusedHost,
  RefusedHostLog,
} from "./misdirected_host.ts";

Deno.test("refusedHost: names the host and the flag that allows it", () => {
  assertEquals(refusedHost("Phone.Tail1234.ts.net:443", "swamp start"), {
    host: "phone.tail1234.ts.net",
    message:
      'Misdirected request: swamp start does not answer for host "phone.tail1234.ts.net". To allow it, start swamp start with --trusted-hosts phone.tail1234.ts.net',
  });
  assertStringIncludes(
    refusedHost("proxy.example", "swamp dashboard").message,
    "start swamp dashboard with --trusted-hosts proxy.example",
  );
});

Deno.test("refusedHost: without a command names the host and gives no hint", () => {
  assertEquals(
    refusedHost("proxy.example", null).message,
    'Misdirected request: this server does not answer for host "proxy.example".',
  );
});

Deno.test("refusedHost: keeps a bracketed IPv6 and drops only its port", () => {
  assertEquals(refusedHost("[FD7A::1]:8080", "swamp start").host, "[fd7a::1]");
  assertEquals(refusedHost("[fd7a::1]", "swamp start").host, "[fd7a::1]");
});

Deno.test("refusedHost: echoes nothing from a missing, malformed, odd or long Host", () => {
  assertEquals(refusedHost(null, "swamp start"), {
    host: null,
    message: "Misdirected request: the request has no Host header.",
  });
  assertEquals(refusedHost("", "swamp start").host, null);
  const odd = [
    "fd7a::1",
    "[:]",
    "999.1.1.1",
    "proxy.example:",
    "proxy.example:80:80",
    "<script>alert(1)</script>",
    "evil.example\r\nX-Injected: 1",
    "{host}.example",
    "proxy example",
    "pröxy.example",
    `${"a".repeat(250)}.example`,
  ];
  for (const header of odd) {
    const refused = refusedHost(header, "swamp start");
    assertEquals(refused.host, null, header);
    assertEquals(
      refused.message,
      "Misdirected request: swamp start refused a Host header that is not a valid host name.",
      header,
    );
  }
});

Deno.test("misdirectedResponse: answers 421 with the message as plain text", async () => {
  const response = misdirectedResponse(refusedHost("proxy.example", null));
  assertEquals(response.status, 421);
  assertEquals(
    response.headers.get("content-type"),
    "text/plain; charset=utf-8",
  );
  assertStringIncludes(await response.text(), '"proxy.example"');
});

Deno.test("RefusedHostLog: warns once per host, and once for every host it does not echo", () => {
  const warnings: string[] = [];
  const log = new RefusedHostLog((m) => warnings.push(m));
  for (let i = 0; i < 3; i++) {
    log.note(refusedHost("a.example", "swamp start"));
    log.note(refusedHost("A.example:9000", "swamp start"));
    log.note(refusedHost("b.example", "swamp start"));
    log.note(refusedHost("<odd>", "swamp start"));
    log.note(refusedHost(null, "swamp start"));
  }
  assertEquals(warnings, [
    refusedHost("a.example", "swamp start").message,
    refusedHost("b.example", "swamp start").message,
    refusedHost("<odd>", "swamp start").message,
  ]);
});

Deno.test("RefusedHostLog: stops remembering at its limit and says so once", () => {
  const warnings: string[] = [];
  const log = new RefusedHostLog((m) => warnings.push(m), 3);
  for (let i = 0; i < 100; i++) {
    log.note(refusedHost(`h${i}.example`, null));
  }
  assertEquals(warnings.length, 4);
  assertEquals(
    warnings[3],
    "Refused requests for 3 different hosts; further refused hosts are not logged.",
  );
});
