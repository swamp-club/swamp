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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { isAbsolute, join, resolve } from "@std/path";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import {
  assertOffLoopbackSecurity,
  authorizeCancelRequest,
  type CancelAuthorizationRequest,
  cancelExecution,
  cancelSuccessBody,
  collectServeExtraArgs,
  MAX_CANCEL_BODY_BYTES,
  parseDatastorePollInterval,
  parseShutdownDrainTimeout,
  parseTokenGcSettings,
  readCancelRequestReason,
  readTlsFile,
  resolveServeStartupSettings,
  shouldWarnGroupRefreshIgnored,
  validateDashboardSessionOrigin,
  validateWebSocketOrigin,
} from "./serve.ts";
import {
  type ActiveRun,
  ActiveRunRegistry,
} from "../../serve/active_run_registry.ts";
import { RunCancelRegistry } from "../../serve/run_cancel_registry.ts";
import { RunEventBuffer } from "../../serve/run_event_buffer.ts";
import { UserError } from "../../domain/errors.ts";
import { mergeServeOptions } from "../../serve/serve_config.ts";
import type { AuditEvent } from "../../domain/serve_audit/audit_event.ts";
import type {
  AccessDecision,
  AccessDecisionService,
} from "../../domain/access/access_decision_service.ts";
import type { PolicySnapshotLoader } from "../../domain/access/policy_snapshot_loader.ts";

// Initialize logging for tests
await initializeLogging({});

Deno.test("serveCommand module loads", async () => {
  const { serveCommand } = await import("./serve.ts");
  assertEquals(serveCommand.getName(), "serve");
});

Deno.test("serveCommand has correct description", async () => {
  const { serveCommand } = await import("./serve.ts");
  const description = serveCommand.getDescription();
  assertStringIncludes(
    description,
    "Start a WebSocket API server for workflow and model execution",
  );
  // Service deployments need HOME set; the description documents this so the
  // guidance is discoverable via `swamp serve --help` (see swamp-club#463).
  assertStringIncludes(description, "HOME");
});

Deno.test("serveCommand has --port option", async () => {
  const { serveCommand } = await import("./serve.ts");
  const options = serveCommand.getOptions();
  const portOpt = options.find((o) => o.name === "port");
  assertEquals(portOpt !== undefined, true);
});

Deno.test("serveCommand has --host option", async () => {
  const { serveCommand } = await import("./serve.ts");
  const options = serveCommand.getOptions();
  const hostOpt = options.find((o) => o.name === "host");
  assertEquals(hostOpt !== undefined, true);
});

Deno.test("serveCommand has --repo-dir option", async () => {
  const { serveCommand } = await import("./serve.ts");
  const options = serveCommand.getOptions();
  const repoDirOpt = options.find((o) => o.name === "repo-dir");
  assertEquals(repoDirOpt !== undefined, true);
});

Deno.test("serveCommand has --cert-file option", async () => {
  const { serveCommand } = await import("./serve.ts");
  const options = serveCommand.getOptions();
  const certOpt = options.find((o) => o.name === "cert-file");
  assertEquals(certOpt !== undefined, true);
});

Deno.test("serveCommand has --key-file option", async () => {
  const { serveCommand } = await import("./serve.ts");
  const options = serveCommand.getOptions();
  const keyOpt = options.find((o) => o.name === "key-file");
  assertEquals(keyOpt !== undefined, true);
});

Deno.test("serveCommand has --datastore-poll-interval option", async () => {
  const { serveCommand } = await import("./serve.ts");
  const options = serveCommand.getOptions();
  const pollOpt = options.find((o) => o.name === "datastore-poll-interval");
  assertEquals(pollOpt !== undefined, true);
  assertStringIncludes(
    pollOpt!.description,
    "SWAMP_DATASTORE_POLL_INTERVAL",
  );
});

for (const name of ["token-gc-interval", "token-gc-grace-period"]) {
  Deno.test(`serveCommand and serve daemon enable have --${name}`, async () => {
    const { serveCommand } = await import("./serve.ts");
    const envVar = `SWAMP_${name.toUpperCase().replaceAll("-", "_")}`;
    const daemonEnable = serveCommand.getCommand("daemon")!.getCommand(
      "enable",
    )!;
    for (const command of [serveCommand, daemonEnable]) {
      const opt = command.getOptions().find((o) => o.name === name);
      assertEquals(opt !== undefined, true);
      assertStringIncludes(opt!.description, envVar);
    }
  });
}

// --- --token-gc-interval / --token-gc-grace-period parsing ---

Deno.test("parseTokenGcSettings: unset gives the 1h defaults", () => {
  assertEquals(parseTokenGcSettings(undefined, undefined), {
    intervalMs: 3_600_000,
    gracePeriodMs: 3_600_000,
  });
});

Deno.test("parseTokenGcSettings: accepts seconds and larger units", () => {
  assertEquals(parseTokenGcSettings("30", "2m"), {
    intervalMs: 30_000,
    gracePeriodMs: 120_000,
  });
  assertEquals(parseTokenGcSettings("6h", "1d"), {
    intervalMs: 21_600_000,
    gracePeriodMs: 86_400_000,
  });
});

Deno.test("parseTokenGcSettings: zero disables the GC or removes the grace period", () => {
  for (
    const zero of ["0", "0s", "0ms", "0m", "0h", "0d", "0w", "0mo", "0y", " 0 "]
  ) {
    assertEquals(parseTokenGcSettings(zero, zero), {
      intervalMs: 0,
      gracePeriodMs: 0,
    });
  }
});

Deno.test("parseTokenGcSettings: rejects milliseconds, naming the flag", () => {
  assertThrows(
    () => parseTokenGcSettings("500ms", undefined),
    UserError,
    "--token-gc-interval must be in whole seconds or larger units",
  );
  assertThrows(
    () => parseTokenGcSettings(undefined, "500ms"),
    UserError,
    "--token-gc-grace-period must be in whole seconds or larger units",
  );
});

Deno.test("parseTokenGcSettings: rejects invalid values", () => {
  assertThrows(
    () => parseTokenGcSettings("abc", undefined),
    Error,
    "Invalid duration format",
  );
  assertThrows(
    () => parseTokenGcSettings(undefined, "abc"),
    Error,
    "Invalid duration format",
  );
});

Deno.test("parseTokenGcSettings: caps the interval at the timer ceiling but not the grace period", () => {
  assertThrows(
    () => parseTokenGcSettings("1mo", undefined),
    UserError,
    "--token-gc-interval (1mo) exceeds the maximum safe timer duration",
  );
  assertEquals(
    parseTokenGcSettings(undefined, "60d").gracePeriodMs,
    60 * 86_400_000,
  );
});

// --- --datastore-poll-interval parsing ---

Deno.test("parseShutdownDrainTimeout: unset keeps the 30s default", () => {
  assertEquals(parseShutdownDrainTimeout(undefined), 30_000);
});

Deno.test("parseShutdownDrainTimeout: zero with or without a unit disables the drain", () => {
  for (const raw of ["0", "0s", "0ms", " 0m ", "00"]) {
    assertEquals(parseShutdownDrainTimeout(raw), 0);
  }
});

Deno.test("parseShutdownDrainTimeout: accepts seconds and larger units", () => {
  assertEquals(parseShutdownDrainTimeout("90"), 90_000);
  assertEquals(parseShutdownDrainTimeout("90s"), 90_000);
  assertEquals(parseShutdownDrainTimeout("5m"), 300_000);
});

Deno.test("parseShutdownDrainTimeout: rejects malformed and oversized values", () => {
  assertThrows(
    () => parseShutdownDrainTimeout("soon"),
    UserError,
  );
  assertThrows(
    () => parseShutdownDrainTimeout("1mo"),
    UserError,
    "--shutdown-drain-timeout (1mo) exceeds the maximum safe timer duration",
  );
});

Deno.test("parseDatastorePollInterval: unset returns undefined", () => {
  assertEquals(parseDatastorePollInterval(undefined), undefined);
});

Deno.test("parseDatastorePollInterval: accepts seconds and larger units", () => {
  assertEquals(parseDatastorePollInterval("2s"), 2_000);
  assertEquals(parseDatastorePollInterval("2"), 2_000);
  assertEquals(parseDatastorePollInterval("1m"), 60_000);
});

Deno.test("parseDatastorePollInterval: rejects milliseconds with the 1s floor", () => {
  for (const raw of ["500ms", "500MS", "1500ms"]) {
    assertThrows(
      () => parseDatastorePollInterval(raw),
      UserError,
      "--datastore-poll-interval must be in whole seconds or larger units (minimum 1s",
    );
  }
});

Deno.test("parseDatastorePollInterval: rejects values above the timer ceiling", () => {
  assertThrows(
    () => parseDatastorePollInterval("1mo"),
    UserError,
    "--datastore-poll-interval (1mo) exceeds the maximum safe timer duration",
  );
});

Deno.test("parseDatastorePollInterval: rejects zero and bad formats", () => {
  assertThrows(
    () => parseDatastorePollInterval("0"),
    UserError,
    "must be positive",
  );
  assertThrows(
    () => parseDatastorePollInterval("abc"),
    UserError,
    "Invalid duration format",
  );
});

// --- --group-refresh-interval warning ---

const DEFAULT_GROUP_REFRESH_MS = 4 * 60 * 60 * 1000;

Deno.test("shouldWarnGroupRefreshIgnored: unset interval never warns", () => {
  assertEquals(
    shouldWarnGroupRefreshIgnored(undefined, DEFAULT_GROUP_REFRESH_MS, false),
    false,
  );
  assertEquals(
    shouldWarnGroupRefreshIgnored(undefined, DEFAULT_GROUP_REFRESH_MS, true),
    false,
  );
});

Deno.test("shouldWarnGroupRefreshIgnored: explicit interval warns without OAuth", () => {
  assertEquals(shouldWarnGroupRefreshIgnored("2h", 7_200_000, false), true);
});

Deno.test("shouldWarnGroupRefreshIgnored: explicit zero never warns", () => {
  assertEquals(shouldWarnGroupRefreshIgnored("0", 0, false), false);
});

Deno.test("shouldWarnGroupRefreshIgnored: explicit interval with OAuth ready does not warn", () => {
  assertEquals(shouldWarnGroupRefreshIgnored("2h", 7_200_000, true), false);
});

// --- Off-loopback security validation ---

Deno.test("assertOffLoopbackSecurity: off-loopback without TLS refuses", () => {
  assertThrows(
    () => assertOffLoopbackSecurity("0.0.0.0", false, "none"),
    UserError,
    "Off-loopback binding requires TLS",
  );
});

Deno.test("assertOffLoopbackSecurity: off-loopback with TLS but no auth refuses", () => {
  assertThrows(
    () => assertOffLoopbackSecurity("0.0.0.0", true, "none"),
    UserError,
    "Off-loopback binding requires authentication",
  );
});

Deno.test("assertOffLoopbackSecurity: off-loopback without TLS but with auth refuses", () => {
  assertThrows(
    () => assertOffLoopbackSecurity("0.0.0.0", false, "token"),
    UserError,
    "Off-loopback binding requires TLS",
  );
});

Deno.test("assertOffLoopbackSecurity: off-loopback with TLS and auth passes", () => {
  assertOffLoopbackSecurity("0.0.0.0", true, "token");
});

Deno.test("assertOffLoopbackSecurity: loopback 127.0.0.1 with no TLS and no auth passes", () => {
  assertOffLoopbackSecurity("127.0.0.1", false, "none");
});

Deno.test("assertOffLoopbackSecurity: loopback localhost with no TLS and no auth passes", () => {
  assertOffLoopbackSecurity("localhost", false, "none");
});

Deno.test("assertOffLoopbackSecurity: IPv6 loopback ::1 with no TLS and no auth passes", () => {
  assertOffLoopbackSecurity("::1", false, "none");
});

// --- WebSocket origin/host validation ---

Deno.test("validateDashboardSessionOrigin: requires the exact browser origin including port", () => {
  const request = new Request("http://localhost:9090/auth/dashboard/session", {
    headers: {
      host: "localhost:9090",
      origin: "http://localhost:3000",
    },
  });
  const result = validateDashboardSessionOrigin(request, false, false);
  assertEquals(result.allowed, false);
});

Deno.test("validateDashboardSessionOrigin: honors public HTTPS proxy headers", () => {
  const request = new Request("http://127.0.0.1:9090/auth/dashboard/session", {
    headers: {
      host: "127.0.0.1:9090",
      origin: "https://swamp.example.test",
      "x-forwarded-host": "swamp.example.test",
      "x-forwarded-proto": "https",
    },
  });
  const result = validateDashboardSessionOrigin(request, false, true);
  assertEquals(result, {
    allowed: true,
    origin: "https://swamp.example.test",
    secure: true,
  });
});

Deno.test("validateDashboardSessionOrigin: accepts direct request authority when a proxy omits its protocol header", () => {
  const request = new Request("http://localhost:9090/auth/dashboard/session", {
    headers: {
      host: "localhost:9090",
      origin: "http://localhost:9090",
    },
  });

  assertEquals(validateDashboardSessionOrigin(request, false, true), {
    allowed: true,
    origin: "http://localhost:9090",
    secure: false,
  });
});

Deno.test("validateDashboardSessionOrigin: honors a configured public host without proxy headers", () => {
  const request = new Request("http://127.0.0.1:9090/auth/dashboard/session", {
    headers: {
      host: "127.0.0.1:9090",
      origin: "https://swamp.example.test",
    },
  });
  const result = validateDashboardSessionOrigin(request, false, true, [
    "swamp.example.test",
  ]);
  assertEquals(result, {
    allowed: true,
    origin: "https://swamp.example.test",
    secure: true,
  });
});

Deno.test("validateDashboardSessionOrigin: requires the exact configured trusted origin", () => {
  const trustedHosts = ["swamp.example.test"];
  for (
    const origin of [
      "http://swamp.example.test",
      "https://swamp.example.test:3000",
    ]
  ) {
    const request = new Request(
      "http://127.0.0.1:9090/auth/dashboard/session",
      { headers: { host: "127.0.0.1:9090", origin } },
    );
    assertEquals(
      validateDashboardSessionOrigin(request, false, false, trustedHosts)
        .allowed,
      false,
    );
  }
});

Deno.test("validateWebSocketOrigin: rejects cross-origin http://evil.com", () => {
  const result = validateWebSocketOrigin(
    "http://evil.com",
    "127.0.0.1:9090",
    "127.0.0.1",
    false,
  );
  assertEquals(result.allowed, false);
  assertStringIncludes(result.reason!, "untrusted origin");
});

Deno.test("validateWebSocketOrigin: rejects attacker-controlled origin", () => {
  const result = validateWebSocketOrigin(
    "http://attacker.example.com",
    "127.0.0.1:9090",
    "127.0.0.1",
    false,
  );
  assertEquals(result.allowed, false);
  assertStringIncludes(result.reason!, "untrusted origin");
});

Deno.test("validateWebSocketOrigin: accepts http://127.0.0.1", () => {
  const result = validateWebSocketOrigin(
    "http://127.0.0.1",
    "127.0.0.1:9090",
    "127.0.0.1",
    false,
  );
  assertEquals(result.allowed, true);
});

Deno.test("validateWebSocketOrigin: accepts http://127.0.0.1 with port", () => {
  const result = validateWebSocketOrigin(
    "http://127.0.0.1:9090",
    "127.0.0.1:9090",
    "127.0.0.1",
    false,
  );
  assertEquals(result.allowed, true);
});

Deno.test("validateWebSocketOrigin: accepts http://localhost", () => {
  const result = validateWebSocketOrigin(
    "http://localhost",
    "localhost:9090",
    "127.0.0.1",
    false,
  );
  assertEquals(result.allowed, true);
});

Deno.test("validateWebSocketOrigin: accepts absent origin (non-browser client)", () => {
  const result = validateWebSocketOrigin(
    null,
    "127.0.0.1:9090",
    "127.0.0.1",
    false,
  );
  assertEquals(result.allowed, true);
});

Deno.test("validateWebSocketOrigin: accepts proxy host on loopback bind", () => {
  const result = validateWebSocketOrigin(
    null,
    "demo.swamp-club.ai",
    "127.0.0.1",
    false,
  );
  assertEquals(result.allowed, true);
});

Deno.test("validateWebSocketOrigin: rejects untrusted host on off-loopback bind", () => {
  const result = validateWebSocketOrigin(
    null,
    "evil.com:9090",
    "0.0.0.0",
    true,
  );
  assertEquals(result.allowed, false);
  assertStringIncludes(result.reason!, "untrusted host");
});

Deno.test("validateWebSocketOrigin: accepts host 127.0.0.1", () => {
  const result = validateWebSocketOrigin(
    null,
    "127.0.0.1:9090",
    "127.0.0.1",
    false,
  );
  assertEquals(result.allowed, true);
});

Deno.test("validateWebSocketOrigin: accepts host localhost", () => {
  const result = validateWebSocketOrigin(
    null,
    "localhost:9090",
    "127.0.0.1",
    false,
  );
  assertEquals(result.allowed, true);
});

Deno.test("validateWebSocketOrigin: accepts host matching --host flag", () => {
  const result = validateWebSocketOrigin(
    null,
    "myhost.local:9090",
    "myhost.local",
    false,
  );
  assertEquals(result.allowed, true);
});

Deno.test("validateWebSocketOrigin: TLS adds server domain to trusted origins", () => {
  const result = validateWebSocketOrigin(
    "https://myserver.example.com",
    "myserver.example.com:443",
    "myserver.example.com",
    true,
  );
  assertEquals(result.allowed, true);
});

Deno.test("validateWebSocketOrigin: TLS server domain rejected without TLS", () => {
  const result = validateWebSocketOrigin(
    "https://myserver.example.com",
    "myserver.example.com:443",
    "myserver.example.com",
    false,
  );
  assertEquals(result.allowed, false);
  assertStringIncludes(result.reason!, "untrusted origin");
});

Deno.test("validateWebSocketOrigin: absent host header passes", () => {
  const result = validateWebSocketOrigin(null, null, "127.0.0.1", false);
  assertEquals(result.allowed, true);
});

Deno.test("validateWebSocketOrigin: accepts IPv6 loopback host [::1]:9090", () => {
  const result = validateWebSocketOrigin(
    null,
    "[::1]:9090",
    "127.0.0.1",
    false,
  );
  assertEquals(result.allowed, true);
});

Deno.test("validateWebSocketOrigin: rejects malformed origin", () => {
  const result = validateWebSocketOrigin(
    "not-a-url",
    "127.0.0.1:9090",
    "127.0.0.1",
    false,
  );
  assertEquals(result.allowed, false);
  assertStringIncludes(result.reason!, "malformed origin");
});

// --- Trusted hosts ---

Deno.test("validateWebSocketOrigin: accepts trusted host on off-loopback bind", () => {
  const result = validateWebSocketOrigin(
    null,
    "host.docker.internal:9090",
    "0.0.0.0",
    true,
    ["host.docker.internal"],
  );
  assertEquals(result.allowed, true);
});

Deno.test("validateWebSocketOrigin: rejects untrusted host even with other trusted hosts", () => {
  const result = validateWebSocketOrigin(
    null,
    "evil.com:9090",
    "0.0.0.0",
    true,
    ["host.docker.internal"],
  );
  assertEquals(result.allowed, false);
  assertStringIncludes(result.reason!, "untrusted host");
});

Deno.test("validateWebSocketOrigin: trusted hosts are case-insensitive", () => {
  const result = validateWebSocketOrigin(
    null,
    "Host.Docker.Internal:9090",
    "0.0.0.0",
    true,
    ["host.docker.internal"],
  );
  assertEquals(result.allowed, true);
});

Deno.test("validateWebSocketOrigin: multiple trusted hosts", () => {
  const result1 = validateWebSocketOrigin(
    null,
    "host.docker.internal:9090",
    "0.0.0.0",
    true,
    ["host.docker.internal", "host.minikube.internal"],
  );
  assertEquals(result1.allowed, true);

  const result2 = validateWebSocketOrigin(
    null,
    "host.minikube.internal:9090",
    "0.0.0.0",
    true,
    ["host.docker.internal", "host.minikube.internal"],
  );
  assertEquals(result2.allowed, true);
});

Deno.test("validateWebSocketOrigin: trusted hosts seed origin allowlist with https", () => {
  const result = validateWebSocketOrigin(
    "https://swamp.k3s-dev.example.com",
    "swamp.k3s-dev.example.com:9090",
    "0.0.0.0",
    true,
    ["swamp.k3s-dev.example.com"],
  );
  assertEquals(result.allowed, true);
});

Deno.test("validateWebSocketOrigin: trusted hosts seed origin allowlist with http", () => {
  const result = validateWebSocketOrigin(
    "http://swamp.k3s-dev.example.com",
    "swamp.k3s-dev.example.com:9090",
    "0.0.0.0",
    false,
    ["swamp.k3s-dev.example.com"],
  );
  assertEquals(result.allowed, true);
});

Deno.test("validateWebSocketOrigin: untrusted origin still rejected with trusted hosts set", () => {
  const result = validateWebSocketOrigin(
    "https://evil.com",
    "swamp.k3s-dev.example.com:9090",
    "0.0.0.0",
    true,
    ["swamp.k3s-dev.example.com"],
  );
  assertEquals(result.allowed, false);
  assertStringIncludes(result.reason!, "untrusted origin");
});

Deno.test("validateWebSocketOrigin: multiple trusted hosts seed origin allowlist", () => {
  const result1 = validateWebSocketOrigin(
    "https://host-a.example.com",
    "host-a.example.com:9090",
    "0.0.0.0",
    true,
    ["host-a.example.com", "host-b.example.com"],
  );
  assertEquals(result1.allowed, true);

  const result2 = validateWebSocketOrigin(
    "https://host-b.example.com",
    "host-b.example.com:9090",
    "0.0.0.0",
    true,
    ["host-a.example.com", "host-b.example.com"],
  );
  assertEquals(result2.allowed, true);
});

Deno.test("validateWebSocketOrigin: trusted hosts origin check is case-insensitive", () => {
  const result = validateWebSocketOrigin(
    "https://Swamp.K3S-Dev.Example.Com",
    "swamp.k3s-dev.example.com:9090",
    "0.0.0.0",
    true,
    ["swamp.k3s-dev.example.com"],
  );
  assertEquals(result.allowed, true);
});

Deno.test("validateWebSocketOrigin: empty trusted hosts array has no effect", () => {
  const result = validateWebSocketOrigin(
    null,
    "evil.com:9090",
    "0.0.0.0",
    true,
    [],
  );
  assertEquals(result.allowed, false);
  assertStringIncludes(result.reason!, "untrusted host");
});

// --- collectServeExtraArgs ---

Deno.test("collectServeExtraArgs: forwards --trusted-hosts", () => {
  const args = collectServeExtraArgs({
    trustedHosts: "host.docker.internal,host.minikube.internal",
  });
  assertEquals(args, [
    "--trusted-hosts",
    "host.docker.internal,host.minikube.internal",
  ]);
});

Deno.test("collectServeExtraArgs: forwards --club-api-key-file as an absolute path", () => {
  const args = collectServeExtraArgs({ clubApiKeyFile: "secrets/key" });
  assertEquals(args, [
    "--club-api-key-file",
    resolve("secrets/key"),
  ]);
  assert(isAbsolute(args[1]));
});

Deno.test("collectServeExtraArgs: forwards --dispatch-env-allow names", () => {
  assertEquals(collectServeExtraArgs({ dispatchEnvAllow: "DEPLOY_ENV,A" }), [
    "--dispatch-env-allow",
    "DEPLOY_ENV,A",
  ]);
});

Deno.test("collectServeExtraArgs: never forwards an empty --dispatch-env-allow", () => {
  // The flag needs a value; an empty one would stop the daemon starting.
  assertEquals(collectServeExtraArgs({ dispatchEnvAllow: "" }), []);
});

Deno.test("collectServeExtraArgs: omits --trusted-hosts when not set", () => {
  const args = collectServeExtraArgs({});
  assertEquals(args, []);
});

Deno.test("collectServeExtraArgs: forwards --shutdown-drain-timeout, including 0", () => {
  assertEquals(collectServeExtraArgs({ shutdownDrainTimeout: "2m" }), [
    "--shutdown-drain-timeout",
    "2m",
  ]);
  assertEquals(collectServeExtraArgs({ shutdownDrainTimeout: "0" }), [
    "--shutdown-drain-timeout",
    "0",
  ]);
});

Deno.test("collectServeExtraArgs: forwards --hot-reload", () => {
  const args = collectServeExtraArgs({ hotReload: true });
  assertEquals(args, ["--hot-reload"]);
});

Deno.test("collectServeExtraArgs: omits --hot-reload when false", () => {
  const args = collectServeExtraArgs({ hotReload: false });
  assertEquals(args, []);
});

Deno.test("collectServeExtraArgs: forwards --auto-resume", () => {
  const args = collectServeExtraArgs({ autoResume: true });
  assertEquals(args, ["--auto-resume"]);
});

Deno.test("collectServeExtraArgs: forwards --approve-requires-explicit-grant", () => {
  const args = collectServeExtraArgs({ approveRequiresExplicitGrant: true });
  assertEquals(args, ["--approve-requires-explicit-grant"]);
});

Deno.test("collectServeExtraArgs: omits --approve-requires-explicit-grant when not set", () => {
  const args = collectServeExtraArgs({});
  assertEquals(args.includes("--approve-requires-explicit-grant"), false);
});

Deno.test("collectServeExtraArgs: forwards --signal-requires-explicit-grant", () => {
  const args = collectServeExtraArgs({ signalRequiresExplicitGrant: true });
  assertEquals(args, ["--signal-requires-explicit-grant"]);
});

Deno.test("collectServeExtraArgs: omits --signal-requires-explicit-grant when not set", () => {
  const args = collectServeExtraArgs({});
  assertEquals(args.includes("--signal-requires-explicit-grant"), false);
});

Deno.test("collectServeExtraArgs: forwards --enable-internal-api", () => {
  const args = collectServeExtraArgs({ enableInternalApi: true });
  assertEquals(args, ["--enable-internal-api"]);
});

Deno.test("collectServeExtraArgs: forwards --max-concurrent-runs", () => {
  const args = collectServeExtraArgs({ maxConcurrentRuns: 50 });
  assertEquals(args, ["--max-concurrent-runs", "50"]);
});

Deno.test("collectServeExtraArgs: forwards --max-runs-per-principal", () => {
  const args = collectServeExtraArgs({ maxRunsPerPrincipal: 10 });
  assertEquals(args, ["--max-runs-per-principal", "10"]);
});

Deno.test("collectServeExtraArgs: forwards --max-run-duration", () => {
  const args = collectServeExtraArgs({ maxRunDuration: "1h" });
  assertEquals(args, ["--max-run-duration", "1h"]);
});

// --- cancelExecution ---

function makeActiveRun(
  runId: string,
  completion: Promise<void>,
): ActiveRun {
  return {
    runId,
    kind: "workflow-run",
    resourceName: "test-workflow",
    buffer: new RunEventBuffer(100),
    controller: new AbortController(),
    startedAt: new Date(),
    completion,
    principalId: null,
  };
}

Deno.test("cancelExecution: returns not_found when run is absent from all registries", async () => {
  const cancelRegistry = new RunCancelRegistry();
  const activeRunRegistry = new ActiveRunRegistry();
  const result = await cancelExecution(
    "workflow-run",
    "missing-run",
    { cancelRegistry, activeRunRegistry },
  );
  assertEquals(result.status, "not_found");
  assertEquals(result.executionId, "missing-run");
});

Deno.test("cancelExecution: returns cancelled when run deregisters within grace period", async () => {
  const cancelRegistry = new RunCancelRegistry();
  const activeRunRegistry = new ActiveRunRegistry();
  const controller = new AbortController();
  let resolveCompletion!: () => void;
  const completion = new Promise<void>((r) => {
    resolveCompletion = r;
  });
  const run = makeActiveRun("run-1", completion);
  Object.assign(run, { controller });

  cancelRegistry.register("workflow-run", "run-1", controller);
  activeRunRegistry.register(run);

  const resultPromise = cancelExecution(
    "workflow-run",
    "run-1",
    { cancelRegistry, activeRunRegistry },
    100,
  );

  // Simulate the run stopping: deregister and resolve completion
  activeRunRegistry.deregister("run-1");
  resolveCompletion();

  const result = await resultPromise;
  assertEquals(result.status, "cancelled");
  assertEquals(result.executionType, "workflow-run");
  assertEquals(result.executionId, "run-1");
});

Deno.test("cancelExecution: returns cancellation_requested when run stays active past grace period", async () => {
  const cancelRegistry = new RunCancelRegistry();
  const activeRunRegistry = new ActiveRunRegistry();
  const controller = new AbortController();
  // Completion never resolves — simulates a stuck run
  const completion = new Promise<void>(() => {});
  const run = makeActiveRun("run-stuck", completion);
  Object.assign(run, { controller });

  cancelRegistry.register("workflow-run", "run-stuck", controller);
  activeRunRegistry.register(run);

  const result = await cancelExecution(
    "workflow-run",
    "run-stuck",
    { cancelRegistry, activeRunRegistry },
    50,
  );
  assertEquals(result.status, "cancellation_requested");
  assertEquals(result.executionId, "run-stuck");

  // Clean up: deregister to avoid dangling state
  activeRunRegistry.deregister("run-stuck");
});

Deno.test("cancelExecution: returns cancellation_requested for scheduled runs", async () => {
  const cancelRegistry = new RunCancelRegistry();
  const activeRunRegistry = new ActiveRunRegistry();

  const result = await cancelExecution(
    "workflow-run",
    "sched-1",
    {
      cancelRegistry,
      activeRunRegistry,
      scheduledCancelByRunId: (id) => id === "sched-1",
    },
  );
  assertEquals(result.status, "cancellation_requested");
  assertEquals(result.executionId, "sched-1");
});

Deno.test("cancelExecution: returns cancelled when run already left active registry", async () => {
  const cancelRegistry = new RunCancelRegistry();
  const activeRunRegistry = new ActiveRunRegistry();
  const controller = new AbortController();
  cancelRegistry.register("method-run", "run-done", controller);
  // Run is in cancel registry but not in active registry (already completed)

  const result = await cancelExecution(
    "method-run",
    "run-done",
    { cancelRegistry, activeRunRegistry },
  );
  assertEquals(result.status, "cancelled");
  assertEquals(result.executionType, "method-run");
  assertEquals(result.executionId, "run-done");
});

Deno.test("cancelExecution: scheduled fallback not checked for method-run type", async () => {
  const cancelRegistry = new RunCancelRegistry();
  let scheduledCalled = false;

  const result = await cancelExecution(
    "method-run",
    "run-x",
    {
      cancelRegistry,
      scheduledCancelByRunId: (_id) => {
        scheduledCalled = true;
        return true;
      },
    },
  );
  assertEquals(result.status, "not_found");
  assertEquals(scheduledCalled, false);
});

Deno.test("cancelExecution: falls back to cancelling a persisted suspended run", async () => {
  const calls: string[] = [];
  const result = await cancelExecution("workflow-run", "suspended-run", {
    cancelRegistry: new RunCancelRegistry(),
    activeRunRegistry: new ActiveRunRegistry(),
    cancelSuspended: (id) => {
      calls.push(id);
      return Promise.resolve({
        status: "cancelled",
        runId: id,
        workflowName: "wf",
      });
    },
  });
  assertEquals(result.status, "cancelled");
  assertEquals(calls, ["suspended-run"]);
});

Deno.test("cancelExecution: tries the suspended fallback only after every registry misses", async () => {
  const activeRunRegistry = new ActiveRunRegistry();
  activeRunRegistry.register(makeActiveRun("live", Promise.resolve()));
  let fallbackCalls = 0;
  await cancelExecution("workflow-run", "live", {
    cancelRegistry: new RunCancelRegistry(),
    activeRunRegistry,
    cancelSuspended: () => {
      fallbackCalls++;
      return Promise.resolve({ status: "not_found", message: "x" });
    },
  }, 10);
  await cancelExecution("workflow-run", "scheduled", {
    cancelRegistry: new RunCancelRegistry(),
    scheduledCancelByRunId: () => true,
    cancelSuspended: () => {
      fallbackCalls++;
      return Promise.resolve({ status: "not_found", message: "x" });
    },
  });
  assertEquals(fallbackCalls, 0);
});

Deno.test("cancelExecution: never tries the suspended fallback for a method-run", async () => {
  let fallbackCalls = 0;
  const result = await cancelExecution("method-run", "m1", {
    cancelRegistry: new RunCancelRegistry(),
    cancelSuspended: () => {
      fallbackCalls++;
      return Promise.resolve({ status: "not_found", message: "x" });
    },
  });
  assertEquals(result.status, "not_found");
  assertEquals(fallbackCalls, 0);
});

Deno.test("cancelExecution: keeps not_found when the fallback finds nothing", async () => {
  const result = await cancelExecution("workflow-run", "gone", {
    cancelRegistry: new RunCancelRegistry(),
    cancelSuspended: () =>
      Promise.resolve({ status: "not_found", message: "hidden" }),
  });
  assertEquals(result.status, "not_found");
  assertEquals(result.message, "No cancellable workflow-run with id gone");
});

Deno.test("cancelExecution: the not_found message names a method-run", async () => {
  const result = await cancelExecution("method-run", "gone", {
    cancelRegistry: new RunCancelRegistry(),
  });
  assertEquals(result.status, "not_found");
  assertEquals(result.message, "No cancellable method-run with id gone");
});

// --- readCancelRequestReason ---

function cancelRequest(body?: string): Request {
  return new Request("http://localhost/api/v1/cancel/workflow-run/r1", {
    method: "POST",
    body,
  });
}

Deno.test("readCancelRequestReason: an empty or missing body gives no reason", async () => {
  assertEquals(await readCancelRequestReason(cancelRequest()), { ok: true });
  assertEquals(await readCancelRequestReason(cancelRequest("")), { ok: true });
  assertEquals(await readCancelRequestReason(cancelRequest("  \n")), {
    ok: true,
  });
});

Deno.test("readCancelRequestReason: returns the reason from a JSON object", async () => {
  assertEquals(
    await readCancelRequestReason(
      cancelRequest(JSON.stringify({ reason: "deploy window closed" })),
    ),
    { ok: true, reason: "deploy window closed" },
  );
});

Deno.test("readCancelRequestReason: an object without a reason, or an empty one, gives no reason", async () => {
  assertEquals(await readCancelRequestReason(cancelRequest("{}")), {
    ok: true,
  });
  assertEquals(
    await readCancelRequestReason(
      cancelRequest(JSON.stringify({ reason: "" })),
    ),
    { ok: true },
  );
});

Deno.test("readCancelRequestReason: refuses a body that is not a JSON object with 400", async () => {
  for (const body of ["not json", "[]", "null", '"text"', "42"]) {
    const result = await readCancelRequestReason(cancelRequest(body));
    assertEquals(result.ok, false, body);
    if (!result.ok) assertEquals(result.status, 400, body);
  }
});

Deno.test("readCancelRequestReason: refuses a non-string reason with 400", async () => {
  const result = await readCancelRequestReason(
    cancelRequest(JSON.stringify({ reason: 7 })),
  );
  assertEquals(result, {
    ok: false,
    status: 400,
    message: "reason must be a string",
  });
});

Deno.test("readCancelRequestReason: accepts 1024 characters and refuses 1025 with 400", async () => {
  assertEquals(
    await readCancelRequestReason(
      cancelRequest(JSON.stringify({ reason: "x".repeat(1024) })),
    ),
    { ok: true, reason: "x".repeat(1024) },
  );
  const result = await readCancelRequestReason(
    cancelRequest(JSON.stringify({ reason: "x".repeat(1025) })),
  );
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.status, 400);
    assertStringIncludes(result.message, "1024");
  }
});

Deno.test("readCancelRequestReason: refuses an oversized body with 413", async () => {
  const result = await readCancelRequestReason(
    cancelRequest("x".repeat(MAX_CANCEL_BODY_BYTES + 1)),
  );
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.status, 413);
});

// --- cancelSuccessBody ---

Deno.test("cancelSuccessBody: a workflow run reports the reason serve applied", () => {
  for (const status of ["cancelled", "cancellation_requested"] as const) {
    assertEquals(
      cancelSuccessBody(
        { status, executionType: "workflow-run", executionId: "r1" },
        "x (cancelled by user:alice)",
      ),
      {
        status,
        executionType: "workflow-run",
        executionId: "r1",
        reason: "x (cancelled by user:alice)",
      },
    );
  }
});

Deno.test("cancelSuccessBody: a method run reports no reason, since it records none", () => {
  assertEquals(
    cancelSuccessBody(
      { status: "cancelled", executionType: "method-run", executionId: "m1" },
      "x (cancelled by user:alice)",
    ),
    { status: "cancelled", executionType: "method-run", executionId: "m1" },
  );
});

Deno.test("cancelExecution: reports conflict for a busy or no-longer-suspended run", async () => {
  for (const status of ["busy", "not_suspended"] as const) {
    const result = await cancelExecution("workflow-run", "r1", {
      cancelRegistry: new RunCancelRegistry(),
      cancelSuspended: () => Promise.resolve({ status, message: "why" }),
    });
    assertEquals(result.status, "conflict");
    assertEquals(result.message, "why");
  }
});

Deno.test("cancelExecution: cancels a resume that registered after the registry miss", async () => {
  const activeRunRegistry = new ActiveRunRegistry();
  const run = makeActiveRun("r1", new Promise<void>(() => {}));
  const result = await cancelExecution("workflow-run", "r1", {
    cancelRegistry: new RunCancelRegistry(),
    activeRunRegistry,
    cancelSuspended: () => {
      activeRunRegistry.register(run);
      return Promise.resolve({ status: "active" });
    },
  }, 10);
  assertEquals(run.controller.signal.aborted, true);
  assertEquals(result.status, "cancellation_requested");
});

Deno.test("cancelExecution: passes its reason to the registry that aborts the run", async () => {
  const activeRunRegistry = new ActiveRunRegistry();
  const run = makeActiveRun("r1", Promise.resolve());
  activeRunRegistry.register(run);

  await cancelExecution("workflow-run", "r1", {
    cancelRegistry: new RunCancelRegistry(),
    activeRunRegistry,
    reason: "cancelled by user:alice",
  }, 10);

  const reason = run.controller.signal.reason;
  assertEquals(
    reason instanceof Error ? reason.message : reason,
    "cancelled by user:alice",
  );
});

/** A registered run that leaves the registry as soon as it is aborted. */
function exitingRun(registry: ActiveRunRegistry, runId: string): ActiveRun {
  let resolve!: () => void;
  const run = makeActiveRun(
    runId,
    new Promise<void>((r) => {
      resolve = r;
    }),
  );
  run.controller.signal.addEventListener("abort", () => {
    registry.deregister(runId);
    resolve();
  });
  registry.register(run);
  return run;
}

Deno.test("cancelExecution: cancels the persisted run when an aborted resume left it suspended", async () => {
  const activeRunRegistry = new ActiveRunRegistry();
  exitingRun(activeRunRegistry, "r1");
  const calls: string[] = [];

  const result = await cancelExecution("workflow-run", "r1", {
    cancelRegistry: new RunCancelRegistry(),
    activeRunRegistry,
    cancelSuspended: (id) => {
      calls.push(id);
      return Promise.resolve({
        status: "cancelled",
        runId: id,
        workflowName: "wf",
      });
    },
  }, 1_000);

  assertEquals(result.status, "cancelled");
  assertEquals(calls, ["r1"]);
});

Deno.test("cancelExecution: an aborted run that left nothing suspended is cancelled", async () => {
  const activeRunRegistry = new ActiveRunRegistry();
  exitingRun(activeRunRegistry, "r1");

  const result = await cancelExecution("workflow-run", "r1", {
    cancelRegistry: new RunCancelRegistry(),
    activeRunRegistry,
    cancelSuspended: () =>
      Promise.resolve({ status: "not_found", message: "none" }),
  }, 1_000);

  assertEquals(result.status, "cancelled");
});

Deno.test("cancelExecution: reports conflict when another operation holds the run after the abort", async () => {
  const activeRunRegistry = new ActiveRunRegistry();
  exitingRun(activeRunRegistry, "r1");

  const result = await cancelExecution("workflow-run", "r1", {
    cancelRegistry: new RunCancelRegistry(),
    activeRunRegistry,
    cancelSuspended: () => Promise.resolve({ status: "busy", message: "busy" }),
  }, 1_000);

  assertEquals(result.status, "conflict");
  assertEquals(result.message, "busy");
});

Deno.test("cancelExecution: does not re-check a run still registered after the grace period", async () => {
  const activeRunRegistry = new ActiveRunRegistry();
  activeRunRegistry.register(
    makeActiveRun("r1", new Promise<void>(() => {})),
  );
  let calls = 0;

  const result = await cancelExecution("workflow-run", "r1", {
    cancelRegistry: new RunCancelRegistry(),
    activeRunRegistry,
    cancelSuspended: () => {
      calls++;
      return Promise.resolve({ status: "not_found", message: "none" });
    },
  }, 10);

  assertEquals(result.status, "cancellation_requested");
  assertEquals(calls, 0);
});

// ── HTTP cancel authorization (swamp-club#2651) ──────────────────────

interface CancelAuthHarness {
  events: AuditEvent[];
  asked: Parameters<AccessDecisionService["decide"]>[];
  loader: Pick<PolicySnapshotLoader, "decisionService">;
}

/** A policy whose admin decision is `effect`, or no match for null. */
function cancelAuthHarness(
  effect: AccessDecision["effect"] | null,
): CancelAuthHarness {
  const events: AuditEvent[] = [];
  const asked: CancelAuthHarness["asked"] = [];
  const decisionService = {
    decide: (...args: Parameters<AccessDecisionService["decide"]>) => {
      asked.push(args);
      return effect === null ? null : { effect } as AccessDecision;
    },
  };
  return {
    events,
    asked,
    loader: { decisionService } as unknown as CancelAuthHarness["loader"],
  };
}

function cancelAuthCtx(events: AuditEvent[]) {
  return {
    instanceId: "inst-1",
    resolvedUserNames: { "u-1": "alice" },
    auditEmitter: { emit: (e: AuditEvent) => events.push(e) },
  } as unknown as Parameters<typeof authorizeCancelRequest>[0];
}

const cancelAuthRequest: CancelAuthorizationRequest = {
  principal: { kind: "user", id: "u-1" },
  collectives: ["acme"],
  groups: ["ops"],
  sourceIp: "10.0.0.1",
  execution: { type: "workflow-run", id: "run-1" },
};

Deno.test("authorizeCancelRequest: refuses without a policy snapshot and audits the refusal", async () => {
  const events: AuditEvent[] = [];

  const response = authorizeCancelRequest(
    cancelAuthCtx(events),
    undefined,
    cancelAuthRequest,
  );

  assertEquals(response?.status, 403);
  assertEquals(await response?.json(), {
    status: "error",
    message:
      "Authorization enforcement is enabled but no policy snapshot is available",
  });
  assertEquals(events.length, 1);
  assertEquals(events[0].outcome, "denied");
  assertEquals(events[0].detail, "access_not_configured");
  assertEquals(events[0].initiatedBy, "user:alice");
});

Deno.test("authorizeCancelRequest: the refusal records the caller's login identity (swamp-club#3076)", () => {
  const events: AuditEvent[] = [];

  authorizeCancelRequest(cancelAuthCtx(events), undefined, {
    ...cancelAuthRequest,
    loginIdentity: { email: "alice@example.com", username: "alice-login" },
  });

  assertEquals(events[0].principalUsername, "alice-login");
  assertEquals(events[0].principalEmail, "alice@example.com");
});

for (const effect of ["deny", null] as const) {
  Deno.test(`authorizeCancelRequest: refuses a caller without admin (decision ${effect}) and audits the refusal`, async () => {
    const h = cancelAuthHarness(effect);

    const response = authorizeCancelRequest(
      cancelAuthCtx(h.events),
      h.loader,
      cancelAuthRequest,
    );

    assertEquals(response?.status, 403);
    assertEquals(await response?.json(), {
      status: "error",
      message: "Access denied: cancel requires admin permission",
    });
    assertEquals(h.asked, [[
      {
        principal: { kind: "user", id: "u-1" },
        collectives: ["acme"],
        groups: ["ops"],
      },
      "admin",
      { kind: "access", name: "*", fields: {} },
    ]]);
    assertEquals(refusalFields(h), [{
      action: "cancel",
      resourceKind: "workflow",
      resourceName: "run-1",
      outcome: "denied",
      detail: "admin required",
      principalId: "u-1",
      initiatedBy: "user:alice",
      sourceIp: "10.0.0.1",
    }]);
  });
}

Deno.test("authorizeCancelRequest: audits a refused method-run and bulk cancel against their own targets", () => {
  const h = cancelAuthHarness("deny");

  authorizeCancelRequest(cancelAuthCtx(h.events), h.loader, {
    ...cancelAuthRequest,
    execution: { type: "method-run", id: "run-2" },
  });
  authorizeCancelRequest(cancelAuthCtx(h.events), h.loader, {
    ...cancelAuthRequest,
    execution: undefined,
  });

  assertEquals(
    refusalFields(h).map(({ action, resourceKind, resourceName }) => ({
      action,
      resourceKind,
      resourceName,
    })),
    [
      { action: "cancel", resourceKind: "model", resourceName: "run-2" },
      { action: "cancel.all", resourceKind: "execution", resourceName: "*" },
    ],
  );
});

Deno.test("authorizeCancelRequest: lets an admin through without auditing", () => {
  const h = cancelAuthHarness("allow");

  const response = authorizeCancelRequest(
    cancelAuthCtx(h.events),
    h.loader,
    cancelAuthRequest,
  );

  assertEquals(response, undefined);
  assertEquals(h.asked.length, 1);
  assertEquals(h.asked[0][1], "admin");
  assertEquals(h.events, []);
});

/** The audited fields a cancel refusal sets. */
function refusalFields(h: CancelAuthHarness) {
  return h.events.map((e) => ({
    action: e.action,
    resourceKind: e.resourceKind,
    resourceName: e.resourceName,
    outcome: e.outcome,
    detail: e.detail,
    principalId: e.principalId,
    initiatedBy: e.initiatedBy,
    sourceIp: e.sourceIp,
  }));
}

/** Merged serve options with Cliffy's defaults and the given flags set. */
function mergedServeOptions(flags: Record<string, unknown> = {}) {
  return mergeServeOptions(
    null,
    {
      port: 9090,
      host: "127.0.0.1",
      schedule: true,
      grantReload: "manual",
      authMode: "none",
      ...flags,
    },
    new Set(
      Object.keys(flags).map((k) =>
        k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
      ),
    ),
    () => undefined,
  );
}

Deno.test("resolveServeStartupSettings: applies the startup defaults", () => {
  const settings = resolveServeStartupSettings(mergedServeOptions());
  assertEquals(settings.authConfig.mode, "none");
  assertEquals(settings.tlsEnabled, false);
  assertEquals(settings.hydrationTimeoutMs, 60_000);
  assertEquals(settings.shutdownDrainTimeoutMs, 30_000);
  assertEquals(settings.wsIdleTimeoutSeconds, undefined);
  assertEquals(settings.queueTimeoutMs, undefined);
  assertEquals(settings.grantReloadMode, "manual");
});

Deno.test("resolveServeStartupSettings: 0 disables the ws idle and queue timeouts", () => {
  const settings = resolveServeStartupSettings(
    mergedServeOptions({ wsIdleTimeout: "0", queueTimeout: "0s" }),
  );
  assertEquals(settings.wsIdleTimeoutSeconds, 0);
  assertEquals(settings.queueTimeoutMs, 0);
});

Deno.test("resolveServeStartupSettings: TLS is enabled when both cert and key are set", () => {
  const settings = resolveServeStartupSettings(
    mergedServeOptions({ certFile: "cert.pem", keyFile: "key.pem" }),
  );
  assertEquals(settings.tlsEnabled, true);
});

Deno.test("readTlsFile: returns the file content", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "server.pem");
    await Deno.writeTextFile(path, "PEM");
    assertEquals(await readTlsFile("certificate", path), "PEM");
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("readTlsFile: a missing file is a UserError naming the path", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = join(dir, "missing.pem");
    await assertRejects(
      () => readTlsFile("certificate", path),
      UserError,
      `TLS certificate file not found: ${path}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("readTlsFile: an unreadable path is a UserError naming the path", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await assertRejects(
      () => readTlsFile("private key", dir),
      UserError,
      `Failed to read TLS private key file ${dir}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("resolveServeStartupSettings: rejects --key-file without --cert-file", () => {
  assertThrows(
    () =>
      resolveServeStartupSettings(mergedServeOptions({ keyFile: "key.pem" })),
    UserError,
    "Both --cert-file and --key-file must be provided together for TLS",
  );
});

Deno.test("resolveServeStartupSettings: rejects an invalid --grant-reload value", () => {
  assertThrows(
    () =>
      resolveServeStartupSettings(
        mergedServeOptions({ grantReload: "sometimes" }),
      ),
    UserError,
    'Invalid --grant-reload value "sometimes"',
  );
});

Deno.test("resolveServeStartupSettings: refuses an off-loopback bind without TLS", () => {
  assertThrows(
    () =>
      resolveServeStartupSettings(
        mergedServeOptions({
          host: "0.0.0.0",
          authMode: "token",
          admins: "user:alice",
        }),
      ),
    UserError,
    "Off-loopback binding requires TLS",
  );
});
