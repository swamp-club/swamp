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
import { buildWorkerPlist } from "./launchd_worker_scheduler.ts";
import type { WorkerDaemonConfig } from "../../domain/worker/worker_daemon_config.ts";

const baseConfig: WorkerDaemonConfig = {
  binaryPath: "/usr/local/bin/swamp",
};

Deno.test("buildWorkerPlist: includes label club.swamp.worker", () => {
  const plist = buildWorkerPlist(baseConfig);
  assertStringIncludes(plist, "<string>club.swamp.worker</string>");
});

Deno.test("buildWorkerPlist: includes worker connect in ProgramArguments", () => {
  const plist = buildWorkerPlist(baseConfig);
  assertStringIncludes(plist, "<string>worker</string>");
  assertStringIncludes(plist, "<string>connect</string>");
});

Deno.test("buildWorkerPlist: uses KeepAlive conditional dict with SuccessfulExit false", () => {
  const plist = buildWorkerPlist(baseConfig);
  assertStringIncludes(plist, "<key>KeepAlive</key>");
  assertStringIncludes(plist, "<key>SuccessfulExit</key>");
  assertStringIncludes(plist, "<false/>");
});

Deno.test("buildWorkerPlist: does not use simple KeepAlive true", () => {
  const plist = buildWorkerPlist(baseConfig);
  const keepAliveIndex = plist.indexOf("<key>KeepAlive</key>");
  const afterKeepAlive = plist.slice(keepAliveIndex + 20, keepAliveIndex + 60);
  assertFalse(afterKeepAlive.includes("<true/>"));
});

Deno.test("buildWorkerPlist: includes RunAtLoad", () => {
  const plist = buildWorkerPlist(baseConfig);
  assertStringIncludes(plist, "<key>RunAtLoad</key>");
  assertStringIncludes(plist, "<true/>");
});

Deno.test("buildWorkerPlist: includes ThrottleInterval", () => {
  const plist = buildWorkerPlist(baseConfig);
  assertStringIncludes(plist, "<key>ThrottleInterval</key>");
  assertStringIncludes(plist, "<integer>10</integer>");
});

Deno.test("buildWorkerPlist: includes environment variables when provided", () => {
  const config: WorkerDaemonConfig = {
    ...baseConfig,
    env: {
      SWAMP_ORCHESTRATOR_URL: "wss://orch:9090",
      SWAMP_WORKER_TOKEN: "tok.secret",
    },
  };
  const plist = buildWorkerPlist(config);
  assertStringIncludes(plist, "<key>EnvironmentVariables</key>");
  assertStringIncludes(plist, "<key>SWAMP_ORCHESTRATOR_URL</key>");
  assertStringIncludes(plist, "<string>wss://orch:9090</string>");
  assertStringIncludes(plist, "<key>SWAMP_WORKER_TOKEN</key>");
  assertStringIncludes(plist, "<string>tok.secret</string>");
});

Deno.test("buildWorkerPlist: omits env block when no env vars", () => {
  const plist = buildWorkerPlist(baseConfig);
  assertFalse(plist.includes("EnvironmentVariables"));
});

Deno.test("buildWorkerPlist: includes WorkingDirectory when cacheDir provided", () => {
  const config: WorkerDaemonConfig = {
    ...baseConfig,
    cacheDir: "/var/lib/swamp-worker",
  };
  const plist = buildWorkerPlist(config);
  assertStringIncludes(plist, "<key>WorkingDirectory</key>");
  assertStringIncludes(plist, "<string>/var/lib/swamp-worker</string>");
});

Deno.test("buildWorkerPlist: omits WorkingDirectory when no cacheDir", () => {
  const plist = buildWorkerPlist(baseConfig);
  assertFalse(plist.includes("WorkingDirectory"));
});

Deno.test("buildWorkerPlist: daemon mode includes UserName root", () => {
  const plist = buildWorkerPlist(baseConfig, "daemon");
  assertStringIncludes(plist, "<key>UserName</key>");
  assertStringIncludes(plist, "<string>root</string>");
});

Deno.test("buildWorkerPlist: agent mode omits UserName", () => {
  const plist = buildWorkerPlist(baseConfig, "agent");
  assertFalse(plist.includes("UserName"));
});

Deno.test("buildWorkerPlist: includes extraArgs when provided", () => {
  const config: WorkerDaemonConfig = {
    ...baseConfig,
    extraArgs: ["--data-plane-url", "https://dp.internal"],
  };
  const plist = buildWorkerPlist(config);
  assertStringIncludes(plist, "<string>--data-plane-url</string>");
  assertStringIncludes(plist, "<string>https://dp.internal</string>");
});

Deno.test("buildWorkerPlist: omits extraArgs when not provided", () => {
  const plist = buildWorkerPlist(baseConfig);
  assertFalse(plist.includes("--data-plane-url"));
});

Deno.test("buildWorkerPlist: escapes XML special characters", () => {
  const config: WorkerDaemonConfig = {
    ...baseConfig,
    binaryPath: '/path/to/swamp "quoted" & <special>',
  };
  const plist = buildWorkerPlist(config);
  assertStringIncludes(plist, "&amp;");
  assertStringIncludes(plist, "&lt;special&gt;");
  assertStringIncludes(plist, "&quot;quoted&quot;");
});

Deno.test("buildWorkerPlist: does not include serve-specific args", () => {
  const plist = buildWorkerPlist(baseConfig);
  assertFalse(plist.includes("--repo-dir"));
  assertFalse(plist.includes("--port"));
  assertFalse(plist.includes("--host"));
});

Deno.test("buildWorkerPlist: uses worker log filenames", () => {
  const plist = buildWorkerPlist(baseConfig);
  assertStringIncludes(plist, "worker.stdout.log");
  assertStringIncludes(plist, "worker.stderr.log");
});
