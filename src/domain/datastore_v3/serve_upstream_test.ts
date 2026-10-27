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
import { ServeUpstreamTarget } from "./serve_upstream.ts";
import { UserError } from "../errors.ts";

Deno.test("ServeUpstreamTarget.create: normalizes ws(s) addresses to their http(s) key", () => {
  const target = ServeUpstreamTarget.create({
    serverUrl: "wss://user:pw@Serve.Test:443/team/?token=abc",
  });
  assertEquals(target.serverUrl, "https://serve.test/team");
  assertEquals(target.token, undefined);
  assertEquals(target.hasToken, false);
  assertEquals(target.caCerts, undefined);
  assertEquals(target.extraHeaders, {});
});

Deno.test("ServeUpstreamTarget.create: refuses an invalid address without echoing it", () => {
  for (const serverUrl of ["not a url", "ftp://hunter2@serve.test"]) {
    const error = assertThrows(
      () => ServeUpstreamTarget.create({ serverUrl }),
      UserError,
    );
    assert(!error.message.includes("hunter2"));
    assert(!error.message.includes("not a url"));
  }
});

Deno.test("ServeUpstreamTarget.create: refuses an empty or malformed token", () => {
  for (const token of ["", "a b", "a\nb"]) {
    assertThrows(
      () =>
        ServeUpstreamTarget.create({
          serverUrl: "http://serve.test",
          token,
        }),
      UserError,
    );
  }
});

Deno.test("ServeUpstreamTarget.create: refuses reserved or control-character headers", () => {
  for (
    const extraHeaders of <Record<string, string>[]> [
      { Authorization: "Bearer x" },
      { host: "evil" },
      { "X-Ok": "a\r\nb" },
      { "": "v" },
    ]
  ) {
    assertThrows(
      () =>
        ServeUpstreamTarget.create({
          serverUrl: "http://serve.test",
          extraHeaders,
        }),
      UserError,
    );
  }
});

Deno.test("ServeUpstreamTarget.create: refuses an empty CA certificate and drops an empty list", () => {
  assertThrows(
    () =>
      ServeUpstreamTarget.create({
        serverUrl: "https://serve.test",
        caCerts: ["  "],
      }),
    UserError,
  );
  const target = ServeUpstreamTarget.create({
    serverUrl: "https://serve.test",
    caCerts: [],
  });
  assertEquals(target.caCerts, undefined);
});

Deno.test("ServeUpstreamTarget: is immutable and never prints its token", () => {
  const headers = { "X-Tunnel": "abc" };
  const certs = ["PEM"];
  const target = ServeUpstreamTarget.create({
    serverUrl: "http://serve.test:9090",
    token: "alice.secret",
    caCerts: certs,
    extraHeaders: headers,
  });
  headers["X-Tunnel"] = "changed";
  certs.push("other");
  assertEquals(target.extraHeaders, { "X-Tunnel": "abc" });
  assertEquals(target.caCerts, ["PEM"]);
  assert(Object.isFrozen(target.extraHeaders));
  assertEquals(String(target), "http://serve.test:9090");
  assert(!JSON.stringify(target).includes("alice.secret"));
  assertEquals(JSON.parse(JSON.stringify(target)), {
    serverUrl: "http://serve.test:9090",
    hasToken: true,
  });
});

Deno.test("ServeUpstreamTarget.equals: compares by value", () => {
  const a = ServeUpstreamTarget.create({
    serverUrl: "ws://serve.test:9090/",
    token: "t.s",
    extraHeaders: { A: "1", B: "2" },
  });
  const b = ServeUpstreamTarget.create({
    serverUrl: "http://serve.test:9090",
    token: "t.s",
    extraHeaders: { B: "2", A: "1" },
  });
  const c = ServeUpstreamTarget.create({
    serverUrl: "http://serve.test:9090",
    token: "other.s",
    extraHeaders: { A: "1", B: "2" },
  });
  assert(a.equals(b));
  assert(!a.equals(c));
});
