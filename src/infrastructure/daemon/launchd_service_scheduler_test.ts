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

import { assertStringIncludes } from "@std/assert";
import { assertFalse } from "@std/assert/false";
import { buildServePlist } from "./launchd_service_scheduler.ts";
import type { ServiceConfig } from "../../domain/serve/service_config.ts";

const baseConfig: ServiceConfig = {
  binaryPath: "/usr/local/bin/swamp",
  repoDir: "/home/user/myrepo",
  port: 9090,
  host: "127.0.0.1",
};

Deno.test("buildServePlist: includes KeepAlive", () => {
  const plist = buildServePlist(baseConfig);
  assertStringIncludes(plist, "<key>KeepAlive</key>");
  assertStringIncludes(plist, "<true/>");
});

Deno.test("buildServePlist: includes RunAtLoad", () => {
  const plist = buildServePlist(baseConfig);
  assertStringIncludes(plist, "<key>RunAtLoad</key>");
});

Deno.test("buildServePlist: includes ThrottleInterval", () => {
  const plist = buildServePlist(baseConfig);
  assertStringIncludes(plist, "<key>ThrottleInterval</key>");
  assertStringIncludes(plist, "<integer>10</integer>");
});

Deno.test("buildServePlist: includes label club.swamp.serve", () => {
  const plist = buildServePlist(baseConfig);
  assertStringIncludes(plist, "<string>club.swamp.serve</string>");
});

Deno.test("buildServePlist: includes working directory", () => {
  const plist = buildServePlist(baseConfig);
  assertStringIncludes(plist, "<key>WorkingDirectory</key>");
  assertStringIncludes(plist, "<string>/home/user/myrepo</string>");
});

Deno.test("buildServePlist: includes port and host args", () => {
  const plist = buildServePlist(baseConfig);
  assertStringIncludes(plist, "<string>--port</string>");
  assertStringIncludes(plist, "<string>9090</string>");
  assertStringIncludes(plist, "<string>--host</string>");
  assertStringIncludes(plist, "<string>127.0.0.1</string>");
});

Deno.test("buildServePlist: includes repo-dir arg", () => {
  const plist = buildServePlist(baseConfig);
  assertStringIncludes(plist, "<string>--repo-dir</string>");
  assertStringIncludes(plist, "<string>/home/user/myrepo</string>");
});

Deno.test("buildServePlist: includes cert and key args when provided", () => {
  const config: ServiceConfig = {
    ...baseConfig,
    certFile: "/path/to/cert.pem",
    keyFile: "/path/to/key.pem",
  };
  const plist = buildServePlist(config);
  assertStringIncludes(plist, "<string>--cert-file</string>");
  assertStringIncludes(plist, "<string>/path/to/cert.pem</string>");
  assertStringIncludes(plist, "<string>--key-file</string>");
  assertStringIncludes(plist, "<string>/path/to/key.pem</string>");
});

Deno.test("buildServePlist: omits cert/key args when not provided", () => {
  const plist = buildServePlist(baseConfig);
  assertFalse(plist.includes("--cert-file"));
  assertFalse(plist.includes("--key-file"));
});

Deno.test("buildServePlist: includes environment variables when provided", () => {
  const config: ServiceConfig = {
    ...baseConfig,
    env: { MY_VAR: "hello" },
  };
  const plist = buildServePlist(config);
  assertStringIncludes(plist, "<key>EnvironmentVariables</key>");
  assertStringIncludes(plist, "<key>MY_VAR</key>");
  assertStringIncludes(plist, "<string>hello</string>");
});

Deno.test("buildServePlist: omits env block when no env vars", () => {
  const plist = buildServePlist(baseConfig);
  assertFalse(plist.includes("EnvironmentVariables"));
});

Deno.test("buildServePlist: daemon mode includes UserName root", () => {
  const plist = buildServePlist(baseConfig, "daemon");
  assertStringIncludes(plist, "<key>UserName</key>");
  assertStringIncludes(plist, "<string>root</string>");
});

Deno.test("buildServePlist: agent mode omits UserName", () => {
  const plist = buildServePlist(baseConfig, "agent");
  assertFalse(plist.includes("UserName"));
});

Deno.test("buildServePlist: escapes XML special characters", () => {
  const config: ServiceConfig = {
    ...baseConfig,
    binaryPath: '/path/to/swamp "quoted" & <special>',
  };
  const plist = buildServePlist(config);
  assertStringIncludes(plist, "&amp;");
  assertStringIncludes(plist, "&lt;special&gt;");
  assertStringIncludes(plist, "&quot;quoted&quot;");
});

Deno.test("buildServePlist: includes extraArgs when provided", () => {
  const config: ServiceConfig = {
    ...baseConfig,
    extraArgs: ["--auth-mode", "token", "--no-schedule"],
  };
  const plist = buildServePlist(config);
  assertStringIncludes(plist, "<string>--auth-mode</string>");
  assertStringIncludes(plist, "<string>token</string>");
  assertStringIncludes(plist, "<string>--no-schedule</string>");
});

Deno.test("buildServePlist: omits extraArgs when not provided", () => {
  const plist = buildServePlist(baseConfig);
  assertFalse(plist.includes("--auth-mode"));
  assertFalse(plist.includes("--no-schedule"));
});

Deno.test("buildServePlist: does not include StartInterval", () => {
  const plist = buildServePlist(baseConfig);
  assertFalse(plist.includes("StartInterval"));
});
