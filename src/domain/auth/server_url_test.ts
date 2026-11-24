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
import {
  describeRefusedRedirect,
  envServerTokenBinding,
  isRedirectStatus,
  normalizeServerUrl,
  redactServerUrl,
} from "./server_url.ts";

Deno.test("normalizeServerUrl: strips trailing slash", () => {
  assertEquals(
    normalizeServerUrl("https://swamp.example.com/"),
    "https://swamp.example.com",
  );
});

Deno.test("normalizeServerUrl: strips multiple trailing slashes", () => {
  assertEquals(
    normalizeServerUrl("https://swamp.example.com///"),
    "https://swamp.example.com",
  );
});

Deno.test("normalizeServerUrl: lowercases hostname", () => {
  assertEquals(
    normalizeServerUrl("https://SWAMP.Example.COM"),
    "https://swamp.example.com",
  );
});

Deno.test("normalizeServerUrl: preserves non-default port", () => {
  assertEquals(
    normalizeServerUrl("https://swamp.example.com:9090"),
    "https://swamp.example.com:9090",
  );
});

Deno.test("normalizeServerUrl: strips default https port 443", () => {
  assertEquals(
    normalizeServerUrl("https://swamp.example.com:443"),
    "https://swamp.example.com",
  );
});

Deno.test("normalizeServerUrl: strips default http port 80", () => {
  assertEquals(
    normalizeServerUrl("http://swamp.example.com:80"),
    "http://swamp.example.com",
  );
});

Deno.test("normalizeServerUrl: preserves non-root path", () => {
  assertEquals(
    normalizeServerUrl("https://swamp.example.com/api/v1/"),
    "https://swamp.example.com/api/v1",
  );
});

Deno.test("normalizeServerUrl: handles IPv6 address", () => {
  assertEquals(
    normalizeServerUrl("https://[::1]:9090"),
    "https://[::1]:9090",
  );
});

Deno.test("normalizeServerUrl: same URL normalizes identically", () => {
  const a = normalizeServerUrl("https://Swamp.Example.COM:443/");
  const b = normalizeServerUrl("https://swamp.example.com");
  assertEquals(a, b);
});

Deno.test("normalizeServerUrl: throws on invalid URL", () => {
  assertThrows(() => normalizeServerUrl("not a url"), TypeError);
});

Deno.test("normalizeServerUrl: throws on unsupported protocol", () => {
  assertThrows(
    () => normalizeServerUrl("ftp://swamp.example.com"),
    TypeError,
    "Unsupported protocol",
  );
});

Deno.test("normalizeServerUrl: http scheme preserved", () => {
  assertEquals(
    normalizeServerUrl("http://localhost:8080"),
    "http://localhost:8080",
  );
});

Deno.test("normalizeServerUrl: ws converts to http", () => {
  assertEquals(
    normalizeServerUrl("ws://swamp.example.com:8080"),
    "http://swamp.example.com:8080",
  );
});

Deno.test("normalizeServerUrl: wss converts to https", () => {
  assertEquals(
    normalizeServerUrl("wss://swamp.example.com"),
    "https://swamp.example.com",
  );
});

Deno.test("normalizeServerUrl: wss with port converts to https with port", () => {
  assertEquals(
    normalizeServerUrl("wss://swamp.example.com:9090/"),
    "https://swamp.example.com:9090",
  );
});

Deno.test("normalizeServerUrl: ws and http normalize to same key", () => {
  assertEquals(
    normalizeServerUrl("ws://swamp.example.com:8080"),
    normalizeServerUrl("http://swamp.example.com:8080"),
  );
});

Deno.test("normalizeServerUrl: wss and https normalize to same key", () => {
  assertEquals(
    normalizeServerUrl("wss://SWAMP.Example.COM:443/"),
    normalizeServerUrl("https://swamp.example.com"),
  );
});

Deno.test("redactServerUrl: drops a token query string", () => {
  assertEquals(
    redactServerUrl("http://127.0.0.1:9000/?token=abc.s3cret"),
    "http://127.0.0.1:9000",
  );
});

Deno.test("redactServerUrl: drops userinfo", () => {
  assertEquals(
    redactServerUrl("https://alice:hunter2@serve.example.com"),
    "https://serve.example.com",
  );
});

Deno.test("redactServerUrl: drops the fragment", () => {
  assertEquals(
    redactServerUrl("wss://serve.example.com:4000/#s3cret"),
    "wss://serve.example.com:4000",
  );
});

Deno.test("redactServerUrl: keeps the scheme as given", () => {
  assertEquals(redactServerUrl("ws://h:1"), "ws://h:1");
  assertEquals(redactServerUrl("wss://h:1"), "wss://h:1");
  assertEquals(redactServerUrl("http://h:1"), "http://h:1");
  assertEquals(redactServerUrl("https://h:1"), "https://h:1");
  assertEquals(redactServerUrl("ftp://u:p@h/?token=x"), "ftp://h");
});

Deno.test("redactServerUrl: keeps a non-root path", () => {
  assertEquals(
    redactServerUrl("https://u:p@serve.example.com/swamp/?token=x#f"),
    "https://serve.example.com/swamp/",
  );
});

Deno.test("redactServerUrl: returns undefined for a value that does not parse", () => {
  assertEquals(redactServerUrl("not a url"), undefined);
  assertEquals(redactServerUrl(""), undefined);
});

Deno.test("redactServerUrl: returns undefined for a URL without a host", () => {
  assertEquals(redactServerUrl("localhost:9000/?token=s3cret"), undefined);
  assertEquals(redactServerUrl("mailto:alice@example.com"), undefined);
});

Deno.test("envServerTokenBinding: SWAMP_SERVER_URL pairs the token with its server alone", () => {
  const key = "https://a.example.com";
  assertEquals(envServerTokenBinding(key, "wss://A.example.com:443/", []), {
    kind: "bound",
  });
  assertEquals(
    envServerTokenBinding("https://b.example.com", key, [
      "https://b.example.com",
    ]),
    { kind: "paired", invalidUrl: false, unsetBinds: true },
  );
  assertEquals(envServerTokenBinding("https://b.example.com", key, []), {
    kind: "paired",
    invalidUrl: false,
    unsetBinds: false,
  });
  assertEquals(envServerTokenBinding(key, "not a url", [key]), {
    kind: "paired",
    invalidUrl: true,
    unsetBinds: true,
  });
});

Deno.test("envServerTokenBinding: without SWAMP_SERVER_URL an address the user named binds the token", () => {
  const key = "http://127.0.0.1:9427";
  assertEquals(
    envServerTokenBinding(key, undefined, [undefined, "ws://127.0.0.1:9427/"]),
    { kind: "bound" },
  );
  assertEquals(envServerTokenBinding(key, "", [key]), { kind: "bound" });
  assertEquals(
    envServerTokenBinding(key, undefined, ["http://other:9427", "", "bad"]),
    { kind: "unnamed" },
  );
  assertEquals(envServerTokenBinding(key, undefined, []), { kind: "unnamed" });
});

Deno.test("isRedirectStatus: covers the redirects fetch would follow, not 304", () => {
  for (const status of [301, 302, 303, 307, 308]) {
    assertEquals(isRedirectStatus(status), true);
  }
  for (const status of [200, 300, 304, 400, 404]) {
    assertEquals(isRedirectStatus(status), false);
  }
});

Deno.test("describeRefusedRedirect: an http to https move suggests the https address", () => {
  assertEquals(
    describeRefusedRedirect(
      "ws://serve.test:9000/",
      "",
      308,
      "https://serve.test:9000/",
    ),
    "ws://serve.test:9000 redirected to https://serve.test:9000 (HTTP 308); swamp does not follow redirects, so pass --server https://serve.test:9000",
  );
});

Deno.test("describeRefusedRedirect: a host move under an endpoint suggests the new base", () => {
  assertEquals(
    describeRefusedRedirect(
      "http://old.test/auth/info",
      "/auth/info",
      301,
      "https://new.test/auth/info",
    ),
    "http://old.test redirected to https://new.test/auth/info (HTTP 301); swamp does not follow redirects, so pass --server https://new.test",
  );
});

Deno.test("describeRefusedRedirect: keeps a path-prefixed serve's prefix in the suggestion", () => {
  assertEquals(
    describeRefusedRedirect(
      "http://serve.test/swamp/api/v1/cancel/workflow-run/r1",
      "/api/v1/cancel/workflow-run/r1",
      307,
      "https://serve.test/swamp/api/v1/cancel/workflow-run/r1",
    ),
    "http://serve.test/swamp redirected to https://serve.test/swamp/api/v1/cancel/workflow-run/r1 (HTTP 307); swamp does not follow redirects, so pass --server https://serve.test/swamp",
  );
});

Deno.test("describeRefusedRedirect: trailing slashes do not stop the suggestion", () => {
  assertEquals(
    describeRefusedRedirect(
      "ws://serve.test/swamp",
      "",
      308,
      "https://serve.test/swamp/",
    ),
    "ws://serve.test/swamp redirected to https://serve.test/swamp/ (HTTP 308); swamp does not follow redirects, so pass --server https://serve.test/swamp",
  );
});

Deno.test("describeRefusedRedirect: a redirect that changes the path names the target without a suggestion", () => {
  const text = describeRefusedRedirect(
    "ws://127.0.0.1:9000",
    "",
    302,
    "http://127.0.0.1:9000/dashboard/start",
  );
  assertEquals(
    text,
    "ws://127.0.0.1:9000 redirected to http://127.0.0.1:9000/dashboard/start (HTTP 302); swamp does not follow redirects, so point --server at the address that serves swamp directly",
  );
});

Deno.test("describeRefusedRedirect: resolves a relative Location against the request", () => {
  assertEquals(
    describeRefusedRedirect(
      "http://serve.test:9000/auth/info",
      "/auth/info",
      308,
      "/login",
    ),
    "http://serve.test:9000 redirected to http://serve.test:9000/login (HTTP 308); swamp does not follow redirects, so point --server at the address that serves swamp directly",
  );
});

Deno.test("describeRefusedRedirect: never shows the target's userinfo, query or fragment", () => {
  const text = describeRefusedRedirect(
    "http://serve.test/auth/info",
    "/auth/info",
    301,
    "https://alice:hunter2@other.test/auth/info?token=abc.s3cret#frag",
  );
  assertEquals(
    text,
    "http://serve.test redirected to https://other.test/auth/info (HTTP 301); swamp does not follow redirects, so pass --server https://other.test",
  );
});

Deno.test("describeRefusedRedirect: a missing or unparseable Location names no target", () => {
  const expected =
    "http://serve.test answered with a redirect (HTTP 301) that names no usable target; swamp does not follow redirects, so point --server at the address that serves swamp directly";
  assertEquals(
    describeRefusedRedirect(
      "http://serve.test/auth/info",
      "/auth/info",
      301,
      null,
    ),
    expected,
  );
  assertEquals(
    describeRefusedRedirect(
      "http://serve.test/auth/info",
      "/auth/info",
      301,
      "http://[bad",
    ),
    expected,
  );
});

Deno.test("describeRefusedRedirect: never suggests dropping TLS", () => {
  assertEquals(
    describeRefusedRedirect("wss://serve.test/", "", 301, "http://serve.test/"),
    "wss://serve.test redirected to http://serve.test (HTTP 301); swamp does not follow redirects, so point --server at the address that serves swamp directly",
  );
});

Deno.test("describeRefusedRedirect: never suggests a scheme --server refuses", () => {
  for (const location of ["ftp://other.test/auth/info"]) {
    assertEquals(
      describeRefusedRedirect(
        "http://serve.test/auth/info",
        "/auth/info",
        302,
        location,
      ),
      `http://serve.test redirected to ${location} (HTTP 302); swamp does not follow redirects, so point --server at the address that serves swamp directly`,
    );
  }
});

Deno.test("describeRefusedRedirect: a ws or wss target is suggested as it was given", () => {
  assertEquals(
    describeRefusedRedirect("http://serve.test/", "", 308, "wss://serve.test/"),
    "http://serve.test redirected to wss://serve.test (HTTP 308); swamp does not follow redirects, so pass --server wss://serve.test",
  );
  assertEquals(
    describeRefusedRedirect("wss://serve.test/", "", 301, "ws://serve.test/"),
    "wss://serve.test redirected to ws://serve.test (HTTP 301); swamp does not follow redirects, so point --server at the address that serves swamp directly",
  );
  assertEquals(
    describeRefusedRedirect("http://serve.test/", "", 301, "ws://serve.test/"),
    "http://serve.test redirected to ws://serve.test (HTTP 301); swamp does not follow redirects, so point --server at the address that serves swamp directly",
  );
});
