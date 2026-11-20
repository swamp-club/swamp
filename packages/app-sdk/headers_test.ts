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
import { APP_SANDBOX, appResponseHeaders } from "./headers.ts";

const base = { appBase: "serve.example/apps/id/", contentType: "text/html" };

function directives(headers: Record<string, string>): Map<string, string> {
  return new Map(
    headers["content-security-policy"].split("; ").map((directive) => {
      const space = directive.indexOf(" ");
      return [directive.slice(0, space), directive.slice(space + 1)];
    }),
  );
}

Deno.test("appResponseHeaders: sandboxes without same-origin", () => {
  const policy = appResponseHeaders(base)["content-security-policy"];
  assertStringIncludes(policy, "sandbox allow-scripts ");
  assertEquals(policy.includes("allow-same-origin"), false);
});

Deno.test("appResponseHeaders: the sandbox grants exactly forms and new-tab links", () => {
  const policy = directives(appResponseHeaders(base));
  // never same-origin, top navigation, modals, downloads or pointer lock
  assertEquals(
    policy.get("sandbox")?.split(" ").sort(),
    [
      "allow-forms",
      "allow-popups",
      "allow-popups-to-escape-sandbox",
      "allow-scripts",
    ],
  );
  assertEquals(policy.get("sandbox"), APP_SANDBOX);
  assertEquals(policy.get("form-action"), "'none'");
});

Deno.test("appResponseHeaders: scripts come only from the app and the platform", () => {
  assertEquals(
    directives(appResponseHeaders(base)).get("script-src"),
    "serve.example/apps/id/ serve.example/app-platform/",
  );
});

Deno.test("appResponseHeaders: external sites are open over TLS only", () => {
  assertEquals(
    directives(appResponseHeaders(base)).get("connect-src"),
    "https: wss:",
  );
});

Deno.test("appResponseHeaders: dev differs from production only as pinned", () => {
  const production = directives(appResponseHeaders(base));
  const dev = directives(
    appResponseHeaders({
      ...base,
      dev: {
        hmrSocket: "ws://127.0.0.1:5173",
        platformBase: "serve.example/app-platform/",
      },
    }),
  );
  const changed = [...production.keys()].filter((name) =>
    production.get(name) !== dev.get(name)
  );
  assertEquals(changed, ["script-src", "connect-src", "frame-ancestors"]);
  assertEquals(
    dev.get("script-src"),
    `${base.appBase} serve.example/app-platform/ 'unsafe-inline'`,
  );
  assertEquals(dev.get("connect-src"), "https: wss: ws://127.0.0.1:5173");
  assertEquals(
    dev.get("frame-ancestors"),
    "http://127.0.0.1:* http://localhost:*",
  );
});

Deno.test("appResponseHeaders: the platform loads from the app's own host, nowhere else", () => {
  const policy = directives(appResponseHeaders(base));
  for (const name of ["script-src", "style-src", "font-src"]) {
    assertEquals(
      policy.get(name)?.includes("serve.example/app-platform/"),
      true,
      name,
    );
  }
  assertEquals(policy.get("connect-src")?.includes("app-platform"), false);
});
