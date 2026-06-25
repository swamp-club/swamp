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
import { buildServeService } from "./systemd_service_scheduler.ts";
import type { ServiceConfig } from "../../domain/serve/service_config.ts";

const baseConfig: ServiceConfig = {
  binaryPath: "/usr/local/bin/swamp",
  repoDir: "/home/user/myrepo",
  port: 9090,
  host: "127.0.0.1",
};

Deno.test("buildServeService: includes Restart=always", () => {
  const unit = buildServeService(baseConfig);
  assertStringIncludes(unit, "Restart=always");
});

Deno.test("buildServeService: includes RestartSec", () => {
  const unit = buildServeService(baseConfig);
  assertStringIncludes(unit, "RestartSec=10");
});

Deno.test("buildServeService: includes Type=simple", () => {
  const unit = buildServeService(baseConfig);
  assertStringIncludes(unit, "Type=simple");
});

Deno.test("buildServeService: includes working directory", () => {
  const unit = buildServeService(baseConfig);
  assertStringIncludes(unit, "WorkingDirectory=/home/user/myrepo");
});

Deno.test("buildServeService: includes ExecStart with serve args", () => {
  const unit = buildServeService(baseConfig);
  assertStringIncludes(unit, "ExecStart=");
  assertStringIncludes(unit, "serve");
  assertStringIncludes(unit, "--port");
  assertStringIncludes(unit, "9090");
  assertStringIncludes(unit, "--host");
  assertStringIncludes(unit, "127.0.0.1");
});

Deno.test("buildServeService: includes repo-dir arg", () => {
  const unit = buildServeService(baseConfig);
  assertStringIncludes(unit, "--repo-dir");
});

Deno.test("buildServeService: includes cert and key args when provided", () => {
  const config: ServiceConfig = {
    ...baseConfig,
    certFile: "/path/to/cert.pem",
    keyFile: "/path/to/key.pem",
  };
  const unit = buildServeService(config);
  assertStringIncludes(unit, "--cert-file");
  assertStringIncludes(unit, "--key-file");
});

Deno.test("buildServeService: omits cert/key args when not provided", () => {
  const unit = buildServeService(baseConfig);
  assertFalse(unit.includes("--cert-file"));
  assertFalse(unit.includes("--key-file"));
});

Deno.test("buildServeService: includes environment variables when provided", () => {
  const config: ServiceConfig = {
    ...baseConfig,
    env: { MY_VAR: "hello" },
  };
  const unit = buildServeService(config);
  assertStringIncludes(unit, 'Environment="MY_VAR=hello"');
});

Deno.test("buildServeService: omits env block when no env vars", () => {
  const unit = buildServeService(baseConfig);
  assertFalse(unit.includes("Environment="));
});

Deno.test("buildServeService: includes network ordering", () => {
  const unit = buildServeService(baseConfig);
  assertStringIncludes(unit, "After=network-online.target");
  assertStringIncludes(unit, "Wants=network-online.target");
});

Deno.test("buildServeService: agent mode uses default.target", () => {
  const unit = buildServeService(baseConfig, "agent");
  assertStringIncludes(unit, "[Install]");
  assertStringIncludes(unit, "WantedBy=default.target");
});

Deno.test("buildServeService: daemon mode uses multi-user.target", () => {
  const unit = buildServeService(baseConfig, "daemon");
  assertStringIncludes(unit, "WantedBy=multi-user.target");
});

Deno.test("buildServeService: includes extraArgs when provided", () => {
  const config: ServiceConfig = {
    ...baseConfig,
    extraArgs: ["--auth-mode", "token", "--no-schedule"],
  };
  const unit = buildServeService(config);
  assertStringIncludes(unit, '"--auth-mode" "token" "--no-schedule"');
});

Deno.test("buildServeService: escapes percent specifiers in extraArgs", () => {
  const config: ServiceConfig = {
    ...baseConfig,
    extraArgs: ["--webhook", "/hooks/gh:wf:secret%nwith%%percents"],
  };
  const unit = buildServeService(config);
  assertStringIncludes(unit, "secret%%nwith%%%%percents");
});

Deno.test("buildServeService: escapes and quotes host", () => {
  const unit = buildServeService(baseConfig);
  assertStringIncludes(unit, '"127.0.0.1"');
});

Deno.test("buildServeService: omits extraArgs when not provided", () => {
  const unit = buildServeService(baseConfig);
  assertFalse(unit.includes("--auth-mode"));
  assertFalse(unit.includes("--no-schedule"));
});

Deno.test("buildServeService: does not include OnCalendar or timer config", () => {
  const unit = buildServeService(baseConfig);
  assertFalse(unit.includes("OnCalendar"));
  assertFalse(unit.includes("[Timer]"));
});
