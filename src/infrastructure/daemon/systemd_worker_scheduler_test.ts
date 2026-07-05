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
import { buildWorkerService } from "./systemd_worker_scheduler.ts";
import type { WorkerDaemonConfig } from "../../domain/worker/worker_daemon_config.ts";

const baseConfig: WorkerDaemonConfig = {
  binaryPath: "/usr/local/bin/swamp",
};

Deno.test("buildWorkerService: includes Restart=on-failure", () => {
  const unit = buildWorkerService(baseConfig);
  assertStringIncludes(unit, "Restart=on-failure");
});

Deno.test("buildWorkerService: does not use Restart=always", () => {
  const unit = buildWorkerService(baseConfig);
  assertFalse(unit.includes("Restart=always"));
});

Deno.test("buildWorkerService: includes KillSignal=SIGTERM", () => {
  const unit = buildWorkerService(baseConfig);
  assertStringIncludes(unit, "KillSignal=SIGTERM");
});

Deno.test("buildWorkerService: includes TimeoutStopSec=300", () => {
  const unit = buildWorkerService(baseConfig);
  assertStringIncludes(unit, "TimeoutStopSec=300");
});

Deno.test("buildWorkerService: includes RestartSec", () => {
  const unit = buildWorkerService(baseConfig);
  assertStringIncludes(unit, "RestartSec=10");
});

Deno.test("buildWorkerService: includes Type=simple", () => {
  const unit = buildWorkerService(baseConfig);
  assertStringIncludes(unit, "Type=simple");
});

Deno.test("buildWorkerService: includes ExecStart with worker connect", () => {
  const unit = buildWorkerService(baseConfig);
  assertStringIncludes(unit, "ExecStart=");
  assertStringIncludes(unit, "worker");
  assertStringIncludes(unit, "connect");
});

Deno.test("buildWorkerService: includes environment variables when provided", () => {
  const config: WorkerDaemonConfig = {
    ...baseConfig,
    env: {
      SWAMP_ORCHESTRATOR_URL: "wss://orch:9090",
      SWAMP_WORKER_TOKEN: "tok.secret",
    },
  };
  const unit = buildWorkerService(config);
  assertStringIncludes(
    unit,
    'Environment="SWAMP_ORCHESTRATOR_URL=wss://orch:9090"',
  );
  assertStringIncludes(unit, 'Environment="SWAMP_WORKER_TOKEN=tok.secret"');
});

Deno.test("buildWorkerService: omits env block when no env vars", () => {
  const unit = buildWorkerService(baseConfig);
  assertFalse(unit.includes("Environment="));
});

Deno.test("buildWorkerService: includes WorkingDirectory when cacheDir provided", () => {
  const config: WorkerDaemonConfig = {
    ...baseConfig,
    cacheDir: "/var/lib/swamp-worker",
  };
  const unit = buildWorkerService(config);
  assertStringIncludes(unit, "WorkingDirectory=/var/lib/swamp-worker");
});

Deno.test("buildWorkerService: omits WorkingDirectory when no cacheDir", () => {
  const unit = buildWorkerService(baseConfig);
  assertFalse(unit.includes("WorkingDirectory="));
});

Deno.test("buildWorkerService: includes network ordering", () => {
  const unit = buildWorkerService(baseConfig);
  assertStringIncludes(unit, "After=network-online.target");
  assertStringIncludes(unit, "Wants=network-online.target");
});

Deno.test("buildWorkerService: agent mode uses default.target", () => {
  const unit = buildWorkerService(baseConfig, "agent");
  assertStringIncludes(unit, "[Install]");
  assertStringIncludes(unit, "WantedBy=default.target");
});

Deno.test("buildWorkerService: daemon mode uses multi-user.target", () => {
  const unit = buildWorkerService(baseConfig, "daemon");
  assertStringIncludes(unit, "WantedBy=multi-user.target");
});

Deno.test("buildWorkerService: includes extraArgs when provided", () => {
  const config: WorkerDaemonConfig = {
    ...baseConfig,
    extraArgs: ["--data-plane-url", "https://dp.internal"],
  };
  const unit = buildWorkerService(config);
  assertStringIncludes(unit, '"--data-plane-url" "https://dp.internal"');
});

Deno.test("buildWorkerService: omits extraArgs when not provided", () => {
  const unit = buildWorkerService(baseConfig);
  assertFalse(unit.includes("--data-plane-url"));
});

Deno.test("buildWorkerService: does not include serve-specific args", () => {
  const unit = buildWorkerService(baseConfig);
  assertFalse(unit.includes("--repo-dir"));
  assertFalse(unit.includes("--port"));
  assertFalse(unit.includes("--host"));
});

Deno.test("buildWorkerService: description mentions worker", () => {
  const unit = buildWorkerService(baseConfig);
  assertStringIncludes(unit, "Description=Swamp worker daemon");
});

Deno.test("buildWorkerService: escapes percent specifiers in env values", () => {
  const config: WorkerDaemonConfig = {
    ...baseConfig,
    env: { MY_VAR: "value%nwith%%percents" },
  };
  const unit = buildWorkerService(config);
  assertStringIncludes(unit, "value%%nwith%%%%percents");
});
