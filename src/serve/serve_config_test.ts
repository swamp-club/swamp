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

import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { stringify as stringifyYaml } from "@std/yaml";
import { join } from "@std/path";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import {
  loadServeConfig,
  mergeServeOptions,
  parseExplicitFlags,
  parseWebhookConfig,
  readServeConfigFile,
  type ServeConfigFile,
  type TriggerOverrideEntry,
  type WebhookConfigEntry,
  writeServeConfigFile,
} from "./serve_config.ts";

await initializeLogging({});

function withTempDir(fn: (dir: string) => void): void {
  const dir = Deno.makeTempDirSync();
  try {
    fn(dir);
  } finally {
    try {
      Deno.removeSync(dir, { recursive: true });
    } catch { /* Windows EBUSY */ }
  }
}

function writeConfig(dir: string, config: Record<string, unknown>): string {
  const swampDir = join(dir, ".swamp");
  Deno.mkdirSync(swampDir, { recursive: true });
  const path = join(swampDir, "serve.yaml");
  Deno.writeTextFileSync(path, stringifyYaml(config));
  return path;
}

Deno.test("loadServeConfig: parses valid full config with all fields", () => {
  withTempDir((dir) => {
    writeConfig(dir, {
      port: 8080,
      host: "0.0.0.0",
      auth: {
        mode: "token",
        admins: ["user:admin-1"],
        "allowed-collectives": ["engineering"],
        "allowed-users": ["alice"],
        "restricted-model-types": ["command/shell"],
        "group-refresh-interval": "2h",
      },
      tls: {
        "cert-file": "/etc/swamp/server.crt",
        "key-file": "/etc/swamp/server.key",
      },
      webhooks: [
        {
          route: "/hooks/ci",
          workflow: "deploy",
          secret: "my-secret",
          scheme: "github",
        },
      ],
      schedule: true,
      "hot-reload": false,
      "detach-runs": true,
      "trust-proxy": true,
      "trusted-hosts": ["host.docker.internal"],
      "grant-reload": "auto",
      "ws-idle-timeout": "2m",
      "queue-timeout": "5m",
      "verify-on-enroll": true,
      "heartbeat-interval": "30s",
      "stale-ttl": "90s",
      "reconciliation-interval": "60s",
    });

    const config = loadServeConfig(undefined, dir);
    assertNotEquals(config, null);
    assertEquals(config!.port, 8080);
    assertEquals(config!.host, "0.0.0.0");
    assertEquals(config!.auth?.mode, "token");
    assertEquals(config!.auth?.admins, ["user:admin-1"]);
    assertEquals(config!.tls?.["cert-file"], "/etc/swamp/server.crt");
    assertEquals(config!.webhooks?.length, 1);
    assertEquals(config!.webhooks?.[0].route, "/hooks/ci");
    assertEquals(config!["detach-runs"], true);
    assertEquals(config!["trust-proxy"], true);
    assertEquals(config!["trusted-hosts"], ["host.docker.internal"]);
  });
});

Deno.test("loadServeConfig: parses minimal config (just port)", () => {
  withTempDir((dir) => {
    writeConfig(dir, { port: 3000 });
    const config = loadServeConfig(undefined, dir);
    assertNotEquals(config, null);
    assertEquals(config!.port, 3000);
    assertEquals(config!.host, undefined);
    assertEquals(config!.auth, undefined);
  });
});

Deno.test("loadServeConfig: missing config at default location returns null", () => {
  withTempDir((dir) => {
    const config = loadServeConfig(undefined, dir);
    assertEquals(config, null);
  });
});

Deno.test("loadServeConfig: missing config with explicit --config is an error", () => {
  assertThrows(
    () => loadServeConfig("/nonexistent/path.yaml", "/tmp"),
    Error,
    "Serve config file not found",
  );
});

Deno.test("loadServeConfig: invalid YAML produces clear error", () => {
  withTempDir((dir) => {
    const swampDir = join(dir, ".swamp");
    Deno.mkdirSync(swampDir, { recursive: true });
    Deno.writeTextFileSync(
      join(swampDir, "serve.yaml"),
      "port: [invalid: yaml: {",
    );
    assertThrows(
      () => loadServeConfig(undefined, dir),
      Error,
      "Invalid YAML",
    );
  });
});

Deno.test("loadServeConfig: unknown keys produce warning but parsing succeeds", () => {
  withTempDir((dir) => {
    writeConfig(dir, {
      port: 9090,
      "unknown-key": "value",
      "another-unknown": 42,
    });
    const config = loadServeConfig(undefined, dir);
    assertNotEquals(config, null);
    assertEquals(config!.port, 9090);
  });
});

Deno.test("loadServeConfig: invalid port produces error", () => {
  withTempDir((dir) => {
    writeConfig(dir, { port: 99999 });
    assertThrows(
      () => loadServeConfig(undefined, dir),
      Error,
      "must be between 1 and 65535",
    );
  });
});

Deno.test("loadServeConfig: non-integer port produces error", () => {
  withTempDir((dir) => {
    writeConfig(dir, { port: "not-a-number" });
    assertThrows(
      () => loadServeConfig(undefined, dir),
      Error,
      "expected integer",
    );
  });
});

Deno.test("loadServeConfig: array config file produces error", () => {
  withTempDir((dir) => {
    const swampDir = join(dir, ".swamp");
    Deno.mkdirSync(swampDir, { recursive: true });
    Deno.writeTextFileSync(join(swampDir, "serve.yaml"), "- item1\n- item2\n");
    assertThrows(
      () => loadServeConfig(undefined, dir),
      Error,
      "must be a YAML mapping",
    );
  });
});

Deno.test("loadServeConfig: non-string grant-reload produces error", () => {
  withTempDir((dir) => {
    writeConfig(dir, { "grant-reload": 42 });
    assertThrows(
      () => loadServeConfig(undefined, dir),
      Error,
      "Invalid grant-reload",
    );
  });
});

Deno.test("loadServeConfig: non-string auth.mode produces error", () => {
  withTempDir((dir) => {
    writeConfig(dir, { auth: { mode: true } });
    assertThrows(
      () => loadServeConfig(undefined, dir),
      Error,
      "Invalid auth.mode",
    );
  });
});

Deno.test("loadServeConfig: non-string tls.cert-file produces error", () => {
  withTempDir((dir) => {
    writeConfig(dir, { tls: { "cert-file": 123 } });
    assertThrows(
      () => loadServeConfig(undefined, dir),
      Error,
      "Invalid tls.cert-file",
    );
  });
});

Deno.test("loadServeConfig: webhook missing route produces error", () => {
  withTempDir((dir) => {
    writeConfig(dir, {
      webhooks: [{ workflow: "deploy", secret: "s" }],
    });
    assertThrows(
      () => loadServeConfig(undefined, dir),
      Error,
      "route is required",
    );
  });
});

Deno.test("loadServeConfig: webhook route not starting with / produces error", () => {
  withTempDir((dir) => {
    writeConfig(dir, {
      webhooks: [{
        route: "hooks/ci",
        workflow: "deploy",
        secret: "s",
      }],
    });
    assertThrows(
      () => loadServeConfig(undefined, dir),
      Error,
      "must start with '/'",
    );
  });
});

Deno.test("loadServeConfig: webhook with invalid scheme produces error", () => {
  withTempDir((dir) => {
    writeConfig(dir, {
      webhooks: [{
        route: "/hooks/ci",
        workflow: "deploy",
        secret: "s",
        scheme: "invalid",
      }],
    });
    assertThrows(
      () => loadServeConfig(undefined, dir),
      Error,
      "scheme must be one of",
    );
  });
});

Deno.test("loadServeConfig: webhook generic scheme without header produces error", () => {
  withTempDir((dir) => {
    writeConfig(dir, {
      webhooks: [{
        route: "/hooks/ci",
        workflow: "deploy",
        secret: "s",
        scheme: "generic",
      }],
    });
    assertThrows(
      () => loadServeConfig(undefined, dir),
      Error,
      "generic scheme requires a header name",
    );
  });
});

Deno.test("loadServeConfig: empty file returns null", () => {
  withTempDir((dir) => {
    const swampDir = join(dir, ".swamp");
    Deno.mkdirSync(swampDir, { recursive: true });
    Deno.writeTextFileSync(join(swampDir, "serve.yaml"), "");
    const config = loadServeConfig(undefined, dir);
    assertEquals(config, null);
  });
});

Deno.test("parseWebhookConfig: parses github scheme webhook", async () => {
  const entry: WebhookConfigEntry = {
    route: "/hooks/ci",
    workflow: "deploy-pipeline",
    secret: "my-secret",
  };
  const endpoint = await parseWebhookConfig(entry);
  assertEquals(endpoint.route, "/hooks/ci");
  assertEquals(endpoint.workflowIdOrName, "deploy-pipeline");
  assertEquals(endpoint.secret, "my-secret");
  assertEquals(endpoint.verifier, { scheme: "github" });
});

Deno.test("parseWebhookConfig: parses linear scheme webhook", async () => {
  const entry: WebhookConfigEntry = {
    route: "/hooks/linear",
    workflow: "triage",
    secret: "linear-secret",
    scheme: "linear",
  };
  const endpoint = await parseWebhookConfig(entry);
  assertEquals(endpoint.verifier, { scheme: "linear" });
});

Deno.test("parseWebhookConfig: parses generic scheme with header and prefix", async () => {
  const entry: WebhookConfigEntry = {
    route: "/hooks/custom",
    workflow: "process",
    secret: "generic-secret",
    scheme: "generic",
    header: "X-Signature",
    prefix: "sha256=",
  };
  const endpoint = await parseWebhookConfig(entry);
  assertEquals(endpoint.verifier, {
    scheme: "generic",
    header: "X-Signature",
    prefix: "sha256=",
  });
});

// ── parseExplicitFlags ────────────────────────────────────────────────

Deno.test("parseExplicitFlags: detects simple flags", () => {
  const flags = parseExplicitFlags(["--port", "9090", "--host", "0.0.0.0"]);
  assertEquals(flags.has("port"), true);
  assertEquals(flags.has("host"), true);
  assertEquals(flags.has("auth-mode"), false);
});

Deno.test("parseExplicitFlags: handles --flag=value form", () => {
  const flags = parseExplicitFlags(["--port=9090"]);
  assertEquals(flags.has("port"), true);
});

Deno.test("parseExplicitFlags: handles --no-flag negation", () => {
  const flags = parseExplicitFlags(["--no-schedule"]);
  assertEquals(flags.has("schedule"), true);
  assertEquals(flags.has("no-schedule"), true);
});

Deno.test("parseExplicitFlags: ignores non-flag args", () => {
  const flags = parseExplicitFlags(["serve", "9090", "-v"]);
  assertEquals(flags.size, 0);
});

// ── mergeServeOptions ─────────────────────────────────────────────────

Deno.test("mergeServeOptions: CLI flag wins over env var and config file", () => {
  const config: ServeConfigFile = { port: 3000 };
  const cliOptions = { port: 8080 };
  const explicitFlags = new Set(["port"]);
  const envLookup = () => undefined;

  const merged = mergeServeOptions(
    config,
    cliOptions,
    explicitFlags,
    envLookup,
  );
  assertEquals(merged.port, 8080);
});

Deno.test("mergeServeOptions: env var wins over config file when CLI not explicit", () => {
  const config: ServeConfigFile = {
    tls: { "cert-file": "/from/config.crt" },
  };
  const cliOptions = {};
  const explicitFlags = new Set<string>();
  const envLookup = (name: string) =>
    name === "SWAMP_SERVE_CERT_FILE" ? "/from/env.crt" : undefined;

  const merged = mergeServeOptions(
    config,
    cliOptions,
    explicitFlags,
    envLookup,
  );
  assertEquals(merged.certFile, "/from/env.crt");
});

Deno.test("mergeServeOptions: config file wins over default when neither CLI nor env var set", () => {
  const config: ServeConfigFile = { port: 3000, host: "0.0.0.0" };
  const cliOptions = { port: 9090, host: "127.0.0.1" };
  const explicitFlags = new Set<string>();
  const envLookup = () => undefined;

  const merged = mergeServeOptions(
    config,
    cliOptions,
    explicitFlags,
    envLookup,
  );
  assertEquals(merged.port, 3000);
  assertEquals(merged.host, "0.0.0.0");
});

Deno.test("mergeServeOptions: defaults used when no config and no explicit flags", () => {
  const cliOptions = { port: 9090, host: "127.0.0.1" };
  const explicitFlags = new Set<string>();
  const envLookup = () => undefined;

  const merged = mergeServeOptions(null, cliOptions, explicitFlags, envLookup);
  assertEquals(merged.port, 9090);
  assertEquals(merged.host, "127.0.0.1");
  assertEquals(merged.schedule, true);
  assertEquals(merged.trustProxy, false);
  assertEquals(merged.detachRuns, false);
  assertEquals(merged.hotReload, false);
});

Deno.test("mergeServeOptions: auth config arrays converted to comma-separated strings", () => {
  const config: ServeConfigFile = {
    auth: {
      mode: "oauth",
      admins: ["alice", "bob"],
      "allowed-collectives": ["eng", "ops"],
      "allowed-users": ["carol"],
      "restricted-model-types": ["command/shell", "command/exec"],
      "restricted-commands": ["extension.install", "vault.put"],
    },
  };
  const cliOptions = {};
  const explicitFlags = new Set<string>();
  const envLookup = () => undefined;

  const merged = mergeServeOptions(
    config,
    cliOptions,
    explicitFlags,
    envLookup,
  );
  assertEquals(merged.authMode, "oauth");
  assertEquals(merged.admins, "alice,bob");
  assertEquals(merged.allowedCollectives, "eng,ops");
  assertEquals(merged.allowedUsers, "carol");
  assertEquals(merged.restrictedModelTypes, "command/shell,command/exec");
  assertEquals(merged.restrictedCommands, "extension.install,vault.put");
});

Deno.test("mergeServeOptions: CLI webhooks replace config webhooks", () => {
  const config: ServeConfigFile = {
    webhooks: [{
      route: "/hooks/config",
      workflow: "config-wf",
      secret: "config-secret",
    }],
  };
  const cliOptions = { webhook: ["/hooks/cli:cli-wf:cli-secret"] };
  const explicitFlags = new Set(["webhook"]);
  const envLookup = () => undefined;

  const merged = mergeServeOptions(
    config,
    cliOptions,
    explicitFlags,
    envLookup,
  );
  assertEquals(merged.webhook, ["/hooks/cli:cli-wf:cli-secret"]);
  assertEquals(merged.webhookConfigs, undefined);
});

Deno.test("mergeServeOptions: config webhooks passed as raw entries for deferred resolution", () => {
  const config: ServeConfigFile = {
    webhooks: [{
      route: "/hooks/config",
      workflow: "config-wf",
      secret: "config-secret",
    }],
  };
  const cliOptions = {};
  const explicitFlags = new Set<string>();
  const envLookup = () => undefined;

  const merged = mergeServeOptions(
    config,
    cliOptions,
    explicitFlags,
    envLookup,
  );
  assertEquals(merged.webhook, undefined);
  assertNotEquals(merged.webhookConfigs, undefined);
  assertEquals(merged.webhookConfigs!.length, 1);
  assertEquals(merged.webhookConfigs![0].route, "/hooks/config");
  assertEquals(merged.webhookConfigs![0].workflow, "config-wf");
});

Deno.test("mergeServeOptions: env var fallback works with no config file (backwards compat)", () => {
  const cliOptions = {};
  const explicitFlags = new Set<string>();
  const envLookup = (name: string) => {
    if (name === "SWAMP_SERVE_CERT_FILE") return "/env/cert.pem";
    if (name === "SWAMP_SERVE_KEY_FILE") return "/env/key.pem";
    if (name === "SWAMP_WS_IDLE_TIMEOUT") return "60";
    return undefined;
  };

  const merged = mergeServeOptions(null, cliOptions, explicitFlags, envLookup);
  assertEquals(merged.certFile, "/env/cert.pem");
  assertEquals(merged.keyFile, "/env/key.pem");
  assertEquals(merged.wsIdleTimeout, "60");
});

Deno.test("mergeServeOptions: boolean env var handling for verify-on-enroll", () => {
  const cliOptions = {};
  const explicitFlags = new Set<string>();
  const envLookup = (name: string) =>
    name === "SWAMP_VERIFY_ON_ENROLL" ? "true" : undefined;

  const merged = mergeServeOptions(null, cliOptions, explicitFlags, envLookup);
  assertEquals(merged.verifyOnEnroll, true);
});

Deno.test("mergeServeOptions: trusted-hosts config array joined to comma string", () => {
  const config: ServeConfigFile = {
    "trusted-hosts": ["host.docker.internal", "host.minikube.internal"],
  };
  const cliOptions = {};
  const explicitFlags = new Set<string>();
  const envLookup = () => undefined;

  const merged = mergeServeOptions(
    config,
    cliOptions,
    explicitFlags,
    envLookup,
  );
  assertEquals(
    merged.trustedHosts,
    "host.docker.internal,host.minikube.internal",
  );
});

// ── grants-file merge ─────────────────────────────────────────────────

Deno.test("mergeServeOptions: grants-file CLI flag wins over config and env", () => {
  const config: ServeConfigFile = { "grants-file": "/from/config.yaml" };
  const cliOptions = { grantsFile: "/from/cli.yaml" };
  const explicitFlags = new Set(["grants-file"]);
  const envLookup = () => undefined;

  const merged = mergeServeOptions(
    config,
    cliOptions,
    explicitFlags,
    envLookup,
  );
  assertEquals(merged.grantsFile, "/from/cli.yaml");
});

Deno.test("mergeServeOptions: grants-file env var wins over config when CLI not explicit", () => {
  const config: ServeConfigFile = { "grants-file": "/from/config.yaml" };
  const cliOptions = {};
  const explicitFlags = new Set<string>();
  const envLookup = (name: string) =>
    name === "SWAMP_GRANTS_FILE" ? "/from/env.yaml" : undefined;

  const merged = mergeServeOptions(
    config,
    cliOptions,
    explicitFlags,
    envLookup,
  );
  assertEquals(merged.grantsFile, "/from/env.yaml");
});

Deno.test("mergeServeOptions: grants-file from config when no CLI or env", () => {
  const config: ServeConfigFile = { "grants-file": "/from/config.yaml" };
  const cliOptions = {};
  const explicitFlags = new Set<string>();
  const envLookup = () => undefined;

  const merged = mergeServeOptions(
    config,
    cliOptions,
    explicitFlags,
    envLookup,
  );
  assertEquals(merged.grantsFile, "/from/config.yaml");
});

Deno.test("mergeServeOptions: grants-file undefined when not specified anywhere", () => {
  const cliOptions = {};
  const explicitFlags = new Set<string>();
  const envLookup = () => undefined;

  const merged = mergeServeOptions(null, cliOptions, explicitFlags, envLookup);
  assertEquals(merged.grantsFile, undefined);
});

Deno.test("loadServeConfig: grants-file field is parsed", () => {
  withTempDir((dir) => {
    writeConfig(dir, { "grants-file": "/etc/swamp/grants.yaml" });
    const config = loadServeConfig(undefined, dir);
    assertNotEquals(config, null);
    assertEquals(config!["grants-file"], "/etc/swamp/grants.yaml");
  });
});

Deno.test("loadServeConfig: non-string grants-file produces error", () => {
  withTempDir((dir) => {
    writeConfig(dir, { "grants-file": 42 });
    assertThrows(
      () => loadServeConfig(undefined, dir),
      Error,
      "expected string",
    );
  });
});

// ── grants-dir merge ──────────────────────────────────────────────────

Deno.test("mergeServeOptions: grants-dir CLI flag wins over config and env", () => {
  const config: ServeConfigFile = { "grants-dir": "/from/config" };
  const cliOptions = { grantsDir: "/from/cli" };
  const explicitFlags = new Set(["grants-dir"]);
  const envLookup = () => undefined;

  const merged = mergeServeOptions(
    config,
    cliOptions,
    explicitFlags,
    envLookup,
  );
  assertEquals(merged.grantsDir, "/from/cli");
});

Deno.test("mergeServeOptions: grants-dir env var wins over config when CLI not explicit", () => {
  const config: ServeConfigFile = { "grants-dir": "/from/config" };
  const cliOptions = {};
  const explicitFlags = new Set<string>();
  const envLookup = (name: string) =>
    name === "SWAMP_GRANTS_DIR" ? "/from/env" : undefined;

  const merged = mergeServeOptions(
    config,
    cliOptions,
    explicitFlags,
    envLookup,
  );
  assertEquals(merged.grantsDir, "/from/env");
});

Deno.test("mergeServeOptions: grants-dir from config when no CLI or env", () => {
  const config: ServeConfigFile = { "grants-dir": "/from/config" };
  const cliOptions = {};
  const explicitFlags = new Set<string>();
  const envLookup = () => undefined;

  const merged = mergeServeOptions(
    config,
    cliOptions,
    explicitFlags,
    envLookup,
  );
  assertEquals(merged.grantsDir, "/from/config");
});

Deno.test("mergeServeOptions: grants-dir undefined when not specified anywhere", () => {
  const cliOptions = {};
  const explicitFlags = new Set<string>();
  const envLookup = () => undefined;

  const merged = mergeServeOptions(null, cliOptions, explicitFlags, envLookup);
  assertEquals(merged.grantsDir, undefined);
});

Deno.test("loadServeConfig: grants-dir field is parsed", () => {
  withTempDir((dir) => {
    writeConfig(dir, { "grants-dir": "/etc/swamp/grants/" });
    const config = loadServeConfig(undefined, dir);
    assertNotEquals(config, null);
    assertEquals(config!["grants-dir"], "/etc/swamp/grants/");
  });
});

Deno.test("loadServeConfig: non-string grants-dir produces error", () => {
  withTempDir((dir) => {
    writeConfig(dir, { "grants-dir": 42 });
    assertThrows(
      () => loadServeConfig(undefined, dir),
      Error,
      "expected string",
    );
  });
});

// ── mergeServeOptions: new concurrency/duration fields ────────────────

Deno.test("mergeServeOptions: max-concurrent-runs from CLI flag", () => {
  const cliOptions = { maxConcurrentRuns: 50 };
  const explicitFlags = new Set(["max-concurrent-runs"]);
  const merged = mergeServeOptions(
    null,
    cliOptions,
    explicitFlags,
    () => undefined,
  );
  assertEquals(merged.maxConcurrentRuns, 50);
});

Deno.test("mergeServeOptions: max-concurrent-runs from env var", () => {
  const merged = mergeServeOptions(
    null,
    {},
    new Set<string>(),
    (name) => name === "SWAMP_MAX_CONCURRENT_RUNS" ? "25" : undefined,
  );
  assertEquals(merged.maxConcurrentRuns, 25);
});

Deno.test("mergeServeOptions: max-concurrent-runs from config file", () => {
  const config: ServeConfigFile = { "max-concurrent-runs": 75 };
  const merged = mergeServeOptions(
    config,
    {},
    new Set<string>(),
    () => undefined,
  );
  assertEquals(merged.maxConcurrentRuns, 75);
});

Deno.test("mergeServeOptions: max-concurrent-runs defaults to undefined", () => {
  const merged = mergeServeOptions(
    null,
    {},
    new Set<string>(),
    () => undefined,
  );
  assertEquals(merged.maxConcurrentRuns, undefined);
});

Deno.test("mergeServeOptions: max-runs-per-principal from CLI flag", () => {
  const cliOptions = { maxRunsPerPrincipal: 5 };
  const explicitFlags = new Set(["max-runs-per-principal"]);
  const merged = mergeServeOptions(
    null,
    cliOptions,
    explicitFlags,
    () => undefined,
  );
  assertEquals(merged.maxRunsPerPrincipal, 5);
});

Deno.test("mergeServeOptions: max-run-duration from CLI flag", () => {
  const cliOptions = { maxRunDuration: "1h" };
  const explicitFlags = new Set(["max-run-duration"]);
  const merged = mergeServeOptions(
    null,
    cliOptions,
    explicitFlags,
    () => undefined,
  );
  assertEquals(merged.maxRunDuration, "1h");
});

Deno.test("mergeServeOptions: max-run-duration from config file", () => {
  const config: ServeConfigFile = { "max-run-duration": "30m" };
  const merged = mergeServeOptions(
    config,
    {},
    new Set<string>(),
    () => undefined,
  );
  assertEquals(merged.maxRunDuration, "30m");
});

Deno.test("mergeServeOptions: non-numeric env var for max-concurrent-runs is ignored", () => {
  const merged = mergeServeOptions(
    null,
    {},
    new Set<string>(),
    (name) => name === "SWAMP_MAX_CONCURRENT_RUNS" ? "abc" : undefined,
  );
  assertEquals(merged.maxConcurrentRuns, undefined);
});

Deno.test("mergeServeOptions: CLI flag zero for max-concurrent-runs passes through", () => {
  const cliOptions = { maxConcurrentRuns: 0 };
  const explicitFlags = new Set(["max-concurrent-runs"]);
  const merged = mergeServeOptions(
    null,
    cliOptions,
    explicitFlags,
    () => undefined,
  );
  assertEquals(merged.maxConcurrentRuns, 0);
});

Deno.test("mergeServeOptions: empty env var for max-concurrent-runs is ignored", () => {
  const merged = mergeServeOptions(
    null,
    {},
    new Set<string>(),
    (name) => name === "SWAMP_MAX_CONCURRENT_RUNS" ? "" : undefined,
  );
  assertEquals(merged.maxConcurrentRuns, undefined);
});

Deno.test("mergeServeOptions: whitespace-only env var for max-concurrent-runs is ignored", () => {
  const merged = mergeServeOptions(
    null,
    {},
    new Set<string>(),
    (name) => name === "SWAMP_MAX_CONCURRENT_RUNS" ? "   " : undefined,
  );
  assertEquals(merged.maxConcurrentRuns, undefined);
});

Deno.test("mergeServeOptions: hydration-timeout from CLI flag", () => {
  const merged = mergeServeOptions(
    null,
    { hydrationTimeout: "5m" },
    new Set(["hydration-timeout"]),
    () => undefined,
  );
  assertEquals(merged.hydrationTimeout, "5m");
});

Deno.test("mergeServeOptions: hydration-timeout from config file", () => {
  const config: ServeConfigFile = { "hydration-timeout": "10m" };
  const merged = mergeServeOptions(
    config,
    {},
    new Set<string>(),
    () => undefined,
  );
  assertEquals(merged.hydrationTimeout, "10m");
});

Deno.test("mergeServeOptions: hydration-timeout from env var", () => {
  const merged = mergeServeOptions(
    null,
    {},
    new Set<string>(),
    (name) => name === "SWAMP_HYDRATION_TIMEOUT" ? "3m" : undefined,
  );
  assertEquals(merged.hydrationTimeout, "3m");
});

Deno.test("mergeServeOptions: hydration-timeout defaults to undefined", () => {
  const merged = mergeServeOptions(
    null,
    {},
    new Set<string>(),
    () => undefined,
  );
  assertEquals(merged.hydrationTimeout, undefined);
});

// ── Trigger Overrides ────────────────────────────────────────────────

Deno.test("loadServeConfig: parses valid triggers section", () => {
  withTempDir((dir) => {
    writeConfig(dir, {
      triggers: {
        "scan-cves": { schedule: "0 3 * * *" },
        "@swamp/cve/researcher/scan": {
          schedule: "0 12 * * 1",
          inputs: { channel: "#security" },
        },
      },
    });
    const config = loadServeConfig(undefined, dir)!;
    assertEquals(Object.keys(config.triggers!).length, 2);
    assertEquals(config.triggers!["scan-cves"].schedule, "0 3 * * *");
    assertEquals(
      config.triggers!["@swamp/cve/researcher/scan"].inputs?.channel,
      "#security",
    );
  });
});

Deno.test("loadServeConfig: rejects triggers with invalid cron expression", () => {
  withTempDir((dir) => {
    writeConfig(dir, {
      triggers: {
        "my-workflow": { schedule: "not-a-cron" },
      },
    });
    assertThrows(
      () => loadServeConfig(undefined, dir),
      Error,
      "invalid cron expression",
    );
  });
});

Deno.test("loadServeConfig: rejects trigger override that is not an object", () => {
  withTempDir((dir) => {
    writeConfig(dir, {
      triggers: {
        "my-workflow": "0 3 * * *",
      },
    });
    assertThrows(
      () => loadServeConfig(undefined, dir),
      Error,
      "expected object",
    );
  });
});

Deno.test("loadServeConfig: rejects trigger override with neither schedule nor inputs", () => {
  withTempDir((dir) => {
    writeConfig(dir, {
      triggers: {
        "my-workflow": {},
      },
    });
    assertThrows(
      () => loadServeConfig(undefined, dir),
      Error,
      "must specify at least",
    );
  });
});

Deno.test("loadServeConfig: rejects triggers that is an array", () => {
  withTempDir((dir) => {
    writeConfig(dir, {
      triggers: [{ schedule: "0 3 * * *" }],
    });
    assertThrows(
      () => loadServeConfig(undefined, dir),
      Error,
      "expected mapping",
    );
  });
});

Deno.test("loadServeConfig: accepts trigger override with inputs only", () => {
  withTempDir((dir) => {
    writeConfig(dir, {
      triggers: {
        "my-workflow": { inputs: { count: 5 } },
      },
    });
    const config = loadServeConfig(undefined, dir)!;
    assertEquals(config.triggers!["my-workflow"].inputs, { count: 5 });
    assertEquals(config.triggers!["my-workflow"].schedule, undefined);
  });
});

Deno.test("mergeServeOptions: triggerOverrides from config", () => {
  const triggers: Record<string, TriggerOverrideEntry> = {
    "scan-cves": { schedule: "0 3 * * *" },
  };
  const config: ServeConfigFile = { triggers };
  const merged = mergeServeOptions(
    config,
    {},
    new Set<string>(),
    () => undefined,
  );
  assertEquals(merged.triggerOverrides, triggers);
});

Deno.test("mergeServeOptions: triggerOverrides undefined when not configured", () => {
  const merged = mergeServeOptions(
    null,
    {},
    new Set<string>(),
    () => undefined,
  );
  assertEquals(merged.triggerOverrides, undefined);
});

Deno.test("mergeServeOptions: triggerOverrides undefined when empty", () => {
  const config: ServeConfigFile = { triggers: {} };
  const merged = mergeServeOptions(
    config,
    {},
    new Set<string>(),
    () => undefined,
  );
  assertEquals(merged.triggerOverrides, undefined);
});

// ── readServeConfigFile / writeServeConfigFile ──────────────────────

Deno.test("writeServeConfigFile: creates file when it does not exist", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeServeConfigFile(dir, {
      triggers: { "my-workflow": { schedule: "0 3 * * *" } },
    });
    const result = await readServeConfigFile(dir);
    assertEquals(result?.triggers?.["my-workflow"]?.schedule, "0 3 * * *");
  } finally {
    try {
      await Deno.remove(dir, { recursive: true });
    } catch { /* Windows EBUSY */ }
  }
});

Deno.test("writeServeConfigFile: preserves other config sections", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeServeConfigFile(dir, {
      port: 9090,
      host: "0.0.0.0",
      triggers: { "scan-cves": { schedule: "0 3 * * *" } },
    });
    const result = await readServeConfigFile(dir);
    assertEquals(result?.port, 9090);
    assertEquals(result?.host, "0.0.0.0");
    assertEquals(result?.triggers?.["scan-cves"]?.schedule, "0 3 * * *");
  } finally {
    try {
      await Deno.remove(dir, { recursive: true });
    } catch { /* Windows EBUSY */ }
  }
});

Deno.test("writeServeConfigFile: replace semantics for trigger entries", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeServeConfigFile(dir, {
      triggers: {
        "my-workflow": { schedule: "0 3 * * *", inputs: { channel: "#ops" } },
      },
    });

    const config = await readServeConfigFile(dir);
    config!.triggers!["my-workflow"] = { schedule: "0 6 * * *" };
    await writeServeConfigFile(dir, config!);

    const result = await readServeConfigFile(dir);
    assertEquals(result?.triggers?.["my-workflow"]?.schedule, "0 6 * * *");
    assertEquals(result?.triggers?.["my-workflow"]?.inputs, undefined);
  } finally {
    try {
      await Deno.remove(dir, { recursive: true });
    } catch { /* Windows EBUSY */ }
  }
});

// ── remote-only merge ─────────────────────────────────────────────────

Deno.test("mergeServeOptions: remote-only defaults to false", () => {
  const merged = mergeServeOptions(
    null,
    {},
    new Set<string>(),
    () => undefined,
  );
  assertEquals(merged.remoteOnly, false);
});

Deno.test("mergeServeOptions: remote-only CLI flag wins over config and env", () => {
  const config: ServeConfigFile = { "remote-only": false };
  const cliOptions = { remoteOnly: true };
  const explicitFlags = new Set(["remote-only"]);
  const envLookup = () => undefined;

  const merged = mergeServeOptions(
    config,
    cliOptions,
    explicitFlags,
    envLookup,
  );
  assertEquals(merged.remoteOnly, true);
});

Deno.test("mergeServeOptions: remote-only env var wins over config when CLI not explicit", () => {
  const config: ServeConfigFile = { "remote-only": false };
  const cliOptions = {};
  const explicitFlags = new Set<string>();
  const envLookup = (name: string) =>
    name === "SWAMP_REMOTE_ONLY" ? "true" : undefined;

  const merged = mergeServeOptions(
    config,
    cliOptions,
    explicitFlags,
    envLookup,
  );
  assertEquals(merged.remoteOnly, true);
});

Deno.test("mergeServeOptions: remote-only from config when no CLI or env", () => {
  const config: ServeConfigFile = { "remote-only": true };
  const cliOptions = {};
  const explicitFlags = new Set<string>();
  const envLookup = () => undefined;

  const merged = mergeServeOptions(
    config,
    cliOptions,
    explicitFlags,
    envLookup,
  );
  assertEquals(merged.remoteOnly, true);
});

Deno.test("loadServeConfig: non-boolean remote-only produces error", () => {
  withTempDir((dir) => {
    writeConfig(dir, { "remote-only": "yes" });
    assertThrows(
      () => loadServeConfig(undefined, dir),
      Error,
      "Invalid remote-only",
    );
  });
});

Deno.test("loadServeConfig: boolean remote-only is accepted", () => {
  withTempDir((dir) => {
    writeConfig(dir, { "remote-only": true });
    const config = loadServeConfig(undefined, dir);
    assertEquals(config?.["remote-only"], true);
  });
});

Deno.test("readServeConfigFile: returns null when file does not exist", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const result = await readServeConfigFile(dir);
    assertEquals(result, null);
  } finally {
    try {
      await Deno.remove(dir, { recursive: true });
    } catch { /* Windows EBUSY */ }
  }
});
