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
import { join } from "@std/path";
import type { DatastoreConfig } from "../domain/datastore/datastore_config.ts";
import { Workflow, type WorkflowInput } from "../domain/workflows/workflow.ts";
import {
  mergeServeOptions,
  type ServeConfigFile,
} from "../serve/serve_config.ts";
import {
  EngineProfileError,
  validateEngineConfig,
  validateEngineMethodRun,
  validateEngineWorkflow,
} from "./profile.ts";

const local: DatastoreConfig = {
  type: "filesystem",
  path: join(Deno.cwd(), ".swamp"),
};

function validateConfig(
  config: ServeConfigFile = {},
  datastore: DatastoreConfig = local,
  env: Record<string, string> = {},
): void {
  const effective: ServeConfigFile = {
    schedule: false,
    "detach-runs": true,
    "grant-reload": "auto",
    ...config,
    auth: { mode: "token", ...config.auth },
  };
  validateEngineConfig(
    config,
    mergeServeOptions(effective, {}, new Set(), (name) => env[name]),
    datastore,
  );
}

function workflow() {
  return {
    id: crypto.randomUUID(),
    name: "local-example",
    inputs: {},
    trigger: undefined as WorkflowInput["trigger"],
    jobs: [{
      name: "main",
      steps: [{
        name: "execute",
        task: {
          type: "model_method",
          modelIdOrName: "fixture",
          methodName: "run",
        } as unknown,
      }],
    }],
  };
}

Deno.test("validateEngineConfig: local token defaults retain execution and access policy", () => {
  validateConfig();
  validateConfig({
    auth: {
      mode: "token",
      admins: ["user:admin"],
      "restricted-model-types": ["command/shell"],
      "restricted-commands": ["model.delete"],
    },
    "max-concurrent-runs": 4,
    "max-runs-per-principal": 2,
    "max-run-duration": "5m",
    "grants-file": "grants.yaml",
    audit: { stores: [{ target: "local" }], "fail-open": false },
  });
});

Deno.test("validateEngineConfig: unsupported server features fail closed", () => {
  const configs: ServeConfigFile[] = [
    { auth: { mode: "none" } },
    { auth: { mode: "oauth" } },
    { schedule: true },
    { "detach-runs": false },
    { "hot-reload": true },
    { "auto-resume": true },
    { dashboard: true },
    { "remote-only": true },
    { "enable-internal-api": true },
    { "verify-on-enroll": true },
    { "trust-proxy": true },
    { webhooks: [{ route: "/hook", workflow: "fixture", secret: "canary" }] },
    { triggers: { fixture: { schedule: "* * * * *" } } },
    { "queue-timeout": "1m" },
    { "ws-idle-timeout": "1m" },
    { "shutdown-drain-timeout": "1m" },
    { "trusted-hosts": ["example.invalid"] },
    { tls: { "cert-file": "certificate.pem" } },
    { host: "127.0.0.1" },
    { port: 9090 },
    { "grant-reload": "manual" },
    { "dispatch-env-allow": ["EXAMPLE"] },
    { "heartbeat-interval": "1m" },
    { "stale-ttl": "1m" },
    { "reconciliation-interval": "1m" },
    { "max-concurrent-scheduled-runs": 1 },
    { "max-concurrent-webhook-runs": 1 },
    { "hydration-timeout": "1m" },
    { "datastore-poll-interval": "1m" },
    { "continuation-sweep-interval": "1m" },
    { "max-signal-wait-timeout": "1m" },
    { "token-gc-interval": "1m" },
    { "token-gc-grace-period": "1m" },
    { auth: { "group-refresh-interval": "1m" } },
    { auth: { "oauth-provider": "https://example.invalid" } },
    { audit: { sinks: [{ type: "http", url: "https://example.invalid" }] } },
    { audit: { alerts: [{ type: "external" }] } },
    { audit: { hmac: { enabled: true } } },
    { audit: { hmac: { key: "canary" } } },
    { audit: { stores: [{ target: "remote", type: "extension" }] } },
  ];
  for (const config of configs) {
    const error = assertThrows(
      () => validateConfig(config),
      EngineProfileError,
    );
    assertEquals(error.code, "unsupported_profile");
    assertEquals(error.message.includes("canary"), false);
    if (config["ws-idle-timeout"] !== undefined) {
      assertEquals(error.message.includes("WebSocket idle timeout"), true);
      assertEquals(error.message.includes("Use swamp serve"), true);
      assertEquals(error.message.includes("configure the Go listener"), false);
    }
  }
});

Deno.test("validateEngineConfig: environment cannot silently enable excluded services", () => {
  for (
    const variable of [
      "SWAMP_AUTO_RESUME",
      "SWAMP_REMOTE_ONLY",
      "SWAMP_DASHBOARD",
      "SWAMP_ENABLE_INTERNAL_API",
      "SWAMP_VERIFY_ON_ENROLL",
    ]
  ) {
    assertThrows(
      () => validateConfig({}, local, { [variable]: "true" }),
      EngineProfileError,
    );
  }
  assertThrows(
    () => validateConfig({}, local, { SWAMP_TOKEN_GC_INTERVAL: "1m" }),
    EngineProfileError,
  );
  assertThrows(
    () => validateConfig({}, local, { SWAMP_OAUTH_CLIENT_NAME: "canary" }),
    EngineProfileError,
    "OAuth configuration",
  );
});

Deno.test("validateEngineConfig: execution caps reject invalid file and environment values", () => {
  for (
    const [name, env] of [
      ["max-concurrent-runs", "SWAMP_MAX_CONCURRENT_RUNS"],
      ["max-runs-per-principal", "SWAMP_MAX_RUNS_PER_PRINCIPAL"],
    ] as const
  ) {
    for (const value of [0, -1, 1.5, Infinity, -Infinity]) {
      assertThrows(
        () => validateConfig({ [name]: value }),
        EngineProfileError,
        name,
      );
      assertThrows(
        () => validateConfig({}, local, { [env]: String(value) }),
        EngineProfileError,
        name,
      );
    }
    assertThrows(
      () => validateConfig({ [name]: NaN }),
      EngineProfileError,
      name,
    );
    validateConfig({ [name]: 1 });
    validateConfig({}, local, { [env]: "2" });
  }
});

Deno.test("validateEngineConfig: run timers share the CLI grammar and safe timer bounds", () => {
  for (
    const value of [
      "0",
      "0s",
      "25d",
      "1mo",
      "999999999999999999999999999",
      "invalid",
      "1ms",
    ]
  ) {
    assertThrows(
      () => validateConfig({ "max-run-duration": value }),
      EngineProfileError,
      "max-run-duration",
    );
    assertThrows(
      () => validateConfig({}, local, { SWAMP_MAX_RUN_DURATION: value }),
      EngineProfileError,
      "max-run-duration",
    );
  }
  for (const value of ["1", "30s", "5m", "1h", "24d", " 2w "]) {
    validateConfig({ "max-run-duration": value });
    validateConfig({}, local, { SWAMP_MAX_RUN_DURATION: value });
  }
});

Deno.test("validateEngineConfig: remote, namespaced and replication datastores are refused", () => {
  for (
    const datastore of [
      { type: "filesystem", path: local.path, format: 3 },
      { type: "filesystem", path: local.path, namespace: "shared" },
      { type: "@test/remote", config: {}, datastorePath: "remote" },
    ] satisfies DatastoreConfig[]
  ) {
    assertThrows(() => validateConfig({}, datastore), EngineProfileError);
  }
});

Deno.test("validateEngineWorkflow: local methods and assertions can execute manually", () => {
  const input = workflow();
  input.trigger = { schedule: "* * * * *" };
  input.jobs[0].steps.push({
    name: "check",
    task: { type: "assert", expr: "true", message: "pass" },
  });
  validateEngineWorkflow(Workflow.fromData(input));
});

Deno.test("validateEngineWorkflow: every unsupported declarative step is refused", () => {
  const tasks = [
    { type: "workflow", workflowIdOrName: "nested" },
    { type: "manual_approval", prompt: "Continue?" },
    { type: "wait_for_signal", timeout: 30, schema: { properties: {} } },
  ] as const;
  for (const task of tasks) {
    const input = workflow();
    input.jobs[0].steps[0].task = task;
    assertThrows(
      () => validateEngineWorkflow(Workflow.fromData(input)),
      EngineProfileError,
      task.type,
    );
  }
});

Deno.test("validateEngineWorkflow: placement at every inheritance level is refused before execution", () => {
  for (
    const placement of [
      { target: "worker" },
      { platform: "linux" },
      { labels: { pool: "build" } },
      { queueTimeout: 0 },
    ]
  ) {
    for (const level of ["workflow", "job", "step"]) {
      const input = workflow();
      Object.assign(
        level === "workflow"
          ? input
          : level === "job"
          ? input.jobs[0]
          : input.jobs[0].steps[0],
        placement,
      );
      assertThrows(
        () => validateEngineWorkflow(Workflow.fromData(input)),
        EngineProfileError,
        "worker placement",
      );
    }
  }
});

Deno.test("validateEngineWorkflow: automatic continuation is refused", () => {
  assertThrows(
    () =>
      validateEngineWorkflow(
        Workflow.fromData({ ...workflow(), autoResume: true }),
      ),
    EngineProfileError,
    "automatic continuation",
  );
});

Deno.test("validateEngineMethodRun: existing definitions preserve supported payload options", () => {
  validateEngineMethodRun({
    modelIdOrName: "fixture",
    methodName: "run",
    literalInputs: true,
    inputs: { value: "${{ data }}" },
    skipAllReports: true,
  });
  for (
    const extra of [{ typeArg: "command/shell" }, { definitionName: "created" }]
  ) {
    assertThrows(
      () =>
        validateEngineMethodRun({
          modelIdOrName: "fixture",
          methodName: "run",
          ...extra,
        }),
      EngineProfileError,
    );
  }
});
