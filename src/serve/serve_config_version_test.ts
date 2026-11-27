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
import { configure, type LogRecord } from "@logtape/logtape";
import { stringify as stringifyYaml } from "@std/yaml";
import { join } from "@std/path";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import {
  assertPathEquals,
  withMockedEnv,
} from "../infrastructure/persistence/path_test_helpers.ts";
import { FEDERATION_GATE_VARIABLE } from "../domain/serve/federation_gate.ts";
import {
  DEFAULT_HUB_NAME,
  hubName,
  loadServeConfig,
  type ServeConfigFile,
  validateTriggerOverrideEntry,
  validateWebhookEntries,
} from "./serve_config.ts";

await initializeLogging({});

const GATE_ON = { [FEDERATION_GATE_VARIABLE]: "1" };
const GATE_OFF = { [FEDERATION_GATE_VARIABLE]: undefined };

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = Deno.makeTempDirSync();
  try {
    return fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      try {
        Deno.removeSync(dir, { recursive: true });
      } catch { /* EBUSY until V8 releases native handles */ }
    } else {
      Deno.removeSync(dir, { recursive: true });
    }
  }
}

function load(
  env: Record<string, string | undefined>,
  config: Record<string, unknown>,
): ServeConfigFile | null {
  return withTempDir((dir) => {
    const swampDir = join(dir, ".swamp");
    Deno.mkdirSync(swampDir, { recursive: true });
    Deno.writeTextFileSync(join(swampDir, "serve.yaml"), stringifyYaml(config));
    return withMockedEnv(env, () => loadServeConfig(undefined, dir));
  });
}

function loadYaml(
  env: Record<string, string | undefined>,
  yaml: string,
): ServeConfigFile | null {
  return withTempDir((dir) => {
    const swampDir = join(dir, ".swamp");
    Deno.mkdirSync(swampDir, { recursive: true });
    Deno.writeTextFileSync(join(swampDir, "serve.yaml"), yaml);
    return withMockedEnv(env, () => loadServeConfig(undefined, dir));
  });
}

async function unknownKeyWarnings(fn: () => void): Promise<string[]> {
  const captured: LogRecord[] = [];
  await configure({
    sinks: { capture: (record: LogRecord) => captured.push(record) },
    loggers: [{
      category: ["serve", "config"],
      lowestLevel: "warning",
      sinks: ["capture"],
    }],
    reset: true,
  });
  try {
    fn();
  } finally {
    await initializeLogging({ _reset: true });
  }
  return captured
    .filter((r) => String(r.rawMessage).includes("Unknown key"))
    .map((r) => String(r.properties.key));
}

function v2(extra: Record<string, unknown>): Record<string, unknown> {
  return { version: 2, ...extra };
}

const STORE = { target: "t", retention: { days: 7 } };
const POLICY = {
  "default-level": "metadata",
  rules: [{ category: "auth", level: "request" }],
};
const WAL = { directory: "wal", "max-size": "10MB" };
const ALERT = {
  name: "a",
  match: { category: "auth" },
  threshold: { count: 1, "window-seconds": 60 },
  action: { type: "log" },
};
const WEBHOOK_SINK = {
  type: "webhook",
  url: "https://a.example",
  auth: { type: "bearer", token: "t" },
  batch: { size: 10, "interval-ms": 100 },
  retry: { "max-attempts": 3, "backoff-ms": 10 },
  filter: { tier: "all" },
};
const SYSLOG_SINK = { type: "syslog", host: "h", port: 514 };

const AUDIT_TYPOS: [Record<string, unknown>, string][] = [
  [
    { stores: [STORE, { ...STORE, retension: 1 }] },
    "audit.stores[1].retension",
  ],
  [
    { stores: [{ ...STORE, retention: { days: 7, dayz: 1 } }] },
    "audit.stores[0].retention.dayz",
  ],
  [{ policy: { ...POLICY, rule: [] } }, "audit.policy.rule"],
  [
    { policy: { rules: [{ level: "request", catgory: "auth" }] } },
    "audit.policy.rules[0].catgory",
  ],
  [{ wal: { ...WAL, max_size: "1GB" } }, "audit.wal.max_size"],
  [{ alerts: [ALERT, { ...ALERT, thresold: {} }] }, "audit.alerts[1].thresold"],
  [
    { alerts: [{ ...ALERT, match: { outcom: "failure" } }] },
    "audit.alerts[0].match.outcom",
  ],
  [
    {
      alerts: [{
        ...ALERT,
        threshold: { count: 1, "window-seconds": 60, window: 1 },
      }],
    },
    "audit.alerts[0].threshold.window",
  ],
  [
    { alerts: [{ ...ALERT, action: { type: "log", ulr: "x" } }] },
    "audit.alerts[0].action.ulr",
  ],
  [
    { sinks: [{ ...WEBHOOK_SINK, auth: { type: "bearer", tokne: "t" } }] },
    "audit.sinks[0].auth.tokne",
  ],
  [
    { sinks: [{ ...WEBHOOK_SINK, batch: { size: 10, interval: 100 } }] },
    "audit.sinks[0].batch.interval",
  ],
  [
    { sinks: [{ ...WEBHOOK_SINK, retry: { "max-attempt": 3 } }] },
    "audit.sinks[0].retry.max-attempt",
  ],
  [
    { sinks: [{ ...WEBHOOK_SINK, filter: { tiers: "all" } }] },
    "audit.sinks[0].filter.tiers",
  ],
  [
    { sinks: [{ ...SYSLOG_SINK, filter: { outcome: ["failure"] } }] },
    "audit.sinks[0].filter.outcome",
  ],
];

Deno.test("loadServeConfig: gate off, version and federation are unknown keys that are ignored", async () => {
  const keys = await unknownKeyWarnings(() => {
    const config = load(GATE_OFF, {
      version: 2,
      federation: { role: "hub" },
      port: 9000,
    });
    assertEquals(config?.port, 9000);
  });
  assertEquals(keys, ["version", "federation"]);
});

Deno.test("loadServeConfig: gate off, a version 3 or non-integer version is not read", () => {
  assertEquals(load(GATE_OFF, { version: 3 })?.version, 3 as never);
  assertEquals(load(GATE_OFF, { version: "two" })?.version, "two" as never);
});

Deno.test("loadServeConfig: gate on, a version 1 file keeps version and federation as unknown keys", async () => {
  for (const version of [undefined, 1]) {
    const keys = await unknownKeyWarnings(() => {
      load(GATE_ON, {
        ...(version === undefined ? {} : { version }),
        federation: { bogus: true },
        webhooks: [{
          route: "/x",
          workflow: "w",
          secret: "s",
          shceme: "github",
        }],
      });
    });
    assertEquals(
      keys,
      version === undefined ? ["federation"] : ["version", "federation"],
    );
  }
});

Deno.test("loadServeConfig: gate on, version 2 loads with a federation block", () => {
  const config = load(GATE_ON, v2({ federation: { role: "hub" } }));
  assertEquals(config?.version, 2);
  assertEquals(config?.federation, { role: "hub" });
});

Deno.test("loadServeConfig: gate on, YAML 2.0 reads as version 2 and a quoted 2 is refused", () => {
  assertEquals(loadYaml(GATE_ON, "version: 2.0\n")?.version, 2);
  assertThrows(
    () => loadYaml(GATE_ON, 'version: "2"\n'),
    Error,
    "Invalid version",
  );
});

Deno.test("loadServeConfig: gate on, a newer version needs a newer swamp", () => {
  assertThrows(
    () => load(GATE_ON, { version: 3 }),
    Error,
    "serve.yaml version 3 needs a newer swamp",
  );
});

Deno.test("loadServeConfig: gate on, a non-integer or non-positive version is refused naming version", () => {
  for (const version of [1.5, 0, -1, "two", true, [2]]) {
    assertThrows(
      () => load(GATE_ON, { version }),
      Error,
      "Invalid version",
      JSON.stringify(version),
    );
  }
});

Deno.test("loadServeConfig: version 2 refuses an unknown key at every closed mapping", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ prot: 1 }, "Unknown key prot"],
    [{ auth: { mod: "none" } }, "Unknown key auth.mod"],
    [{ tls: { cert: "x" } }, "Unknown key tls.cert"],
    [
      { "token-secrets": { vault: "v", key: "k", extra: 1 } },
      "Unknown key token-secrets.extra",
    ],
    [{ audit: { storez: [] } }, "Unknown key audit.storez"],
    [
      { audit: { hmac: { vault: "v", key: "k", enable: true } } },
      "Unknown key audit.hmac.enable",
    ],
    [
      { audit: { sinks: [{ type: "webhook", url: "https://a", ur1: "x" }] } },
      "Unknown key audit.sinks[0].ur1",
    ],
    [
      { audit: { sinks: [{ type: "syslog", host: "h", prot: 1 }] } },
      "Unknown key audit.sinks[0].prot",
    ],
    [
      { triggers: { nightly: { schedule: "0 0 * * *", catchup: "skip" } } },
      "Unknown key triggers.nightly.catchup",
    ],
    [
      {
        webhooks: [
          { route: "/a", workflow: "w", secret: "s" },
          { route: "/b", workflow: "w", secret: "s", shceme: "github" },
        ],
      },
      "Unknown key webhooks[1].shceme",
    ],
    [
      { federation: { role: "hub", rol: "hub" } },
      "Unknown key federation.rol",
    ],
  ];
  for (const [extra, message] of cases) {
    assertThrows(() => load(GATE_ON, v2(extra)), Error, message);
  }
  for (const [audit, key] of AUDIT_TYPOS) {
    assertThrows(
      () => load(GATE_ON, v2({ audit })),
      Error,
      `Unknown key ${key} in`,
    );
  }
});

Deno.test("loadServeConfig: version 2 accepts every known key in the audit mappings", () => {
  const config = load(
    GATE_ON,
    v2({
      audit: {
        stores: [STORE],
        policy: {
          ...POLICY,
          rules: [{
            ...POLICY.rules[0],
            tier: "data",
            action: "x",
            hmac: true,
          }],
        },
        wal: WAL,
        alerts: [{
          ...ALERT,
          description: "d",
          match: {
            category: "auth",
            action: "x",
            outcome: "failure",
            principal: "p",
          },
          action: { type: "webhook", url: "https://a.example" },
        }],
        sinks: [
          {
            ...WEBHOOK_SINK,
            auth: { type: "header", value: "v", "header-name": "X-Key" },
            filter: {
              categories: ["auth"],
              tier: "all",
              outcomes: ["failure"],
            },
          },
          { ...WEBHOOK_SINK, auth: { type: "basic", password: "p" } },
          { ...SYSLOG_SINK, filter: { tier: "data" } },
        ],
      },
    }),
  );
  assertEquals(config?.version, 2);
});

Deno.test("loadServeConfig: version 1 adds no unknown-key warnings for the audit mappings", async () => {
  for (const env of [GATE_ON, GATE_OFF]) {
    for (const [audit] of AUDIT_TYPOS) {
      const keys = await unknownKeyWarnings(() => {
        load(env, { audit });
      });
      assertEquals(keys, [], JSON.stringify(audit));
    }
  }
});

Deno.test("loadServeConfig: version 2 leaves free-form maps open", () => {
  const config = load(
    GATE_ON,
    v2({
      triggers: { nightly: { inputs: { anything: 1, else: "x" } } },
      webhooks: [{
        route: "/a",
        workflow: "w",
        secret: "s",
        scheme: "@acme/hook",
        config: { whatever: true },
      }],
      audit: {
        stores: [{
          target: "t",
          type: "@acme/store",
          config: { free: "form" },
        }],
      },
    }),
  );
  assertEquals(config?.triggers?.nightly?.inputs, { anything: 1, else: "x" });
});

Deno.test("validateTriggerOverrideEntry and validateWebhookEntries: other callers keep today's leniency", () => {
  validateTriggerOverrideEntry(
    { schedule: "0 0 * * *", catchup: "skip" },
    "serve.yaml",
    "nightly",
  );
  validateWebhookEntries(
    [{ route: "/a", workflow: "w", secret: "s", shceme: "github" }],
    "serve.yaml",
  );
});

Deno.test("loadServeConfig: federation needs exactly one of role and hub", () => {
  for (const federation of [{}, { role: "hub", hub: "https://hub.example" }]) {
    assertThrows(
      () => load(GATE_ON, v2({ federation })),
      Error,
      "set exactly one of role: hub or hub: <url>",
    );
  }
});

Deno.test("loadServeConfig: federation must be a mapping", () => {
  for (const federation of ["hub", ["hub"], null]) {
    assertThrows(
      () => load(GATE_ON, v2({ federation })),
      Error,
      "Invalid federation",
    );
  }
});

Deno.test("loadServeConfig: federation.role accepts only hub", () => {
  assertThrows(
    () => load(GATE_ON, v2({ federation: { role: "member" } })),
    Error,
    "the only role is hub",
  );
});

Deno.test("loadServeConfig: a hub refuses join-token-file", () => {
  assertThrows(
    () =>
      load(
        GATE_ON,
        v2({ federation: { role: "hub", "join-token-file": "t" } }),
      ),
    Error,
    "a hub joins no hub",
  );
});

Deno.test("loadServeConfig: a hub may name itself", () => {
  const config = load(
    GATE_ON,
    v2({ federation: { role: "hub", name: "core-1" } }),
  );
  assertEquals(config?.federation, { role: "hub", name: "core-1" });
  assertEquals(hubName(config?.federation ?? {}), "core-1");
});

Deno.test("hubName: a hub without a name is called hub", () => {
  const config = load(GATE_ON, v2({ federation: { role: "hub" } }));
  assertEquals(hubName(config?.federation ?? {}), DEFAULT_HUB_NAME);
  assertEquals(DEFAULT_HUB_NAME, "hub");
});

Deno.test("loadServeConfig: federation.name follows the member name rule", () => {
  const cases: Array<[unknown, string]> = [
    ["", "must not be empty"],
    ["a".repeat(65), "at most 64 characters"],
    ["has space", "may contain only"],
    ["dot.ted", "may contain only"],
    [7, "expected a string"],
  ];
  for (const [name, message] of cases) {
    const error = assertThrows(
      () => load(GATE_ON, v2({ federation: { role: "hub", name } })),
      Error,
      message,
    );
    assertEquals(error.message.includes("federation.name"), true);
  }
  assertEquals(
    load(GATE_ON, v2({ federation: { role: "hub", name: "a".repeat(64) } }))
      ?.federation?.name,
    "a".repeat(64),
  );
});

Deno.test("loadServeConfig: a member config refuses federation.name", () => {
  assertThrows(
    () =>
      load(
        GATE_ON,
        v2({ federation: { hub: "https://hub.example", name: "edge" } }),
      ),
    Error,
    "Invalid federation.name",
  );
});

Deno.test("loadServeConfig: join-token-file resolves against the repository", () => {
  withTempDir((dir) => {
    const swampDir = join(dir, ".swamp");
    Deno.mkdirSync(swampDir, { recursive: true });
    Deno.writeTextFileSync(
      join(swampDir, "serve.yaml"),
      stringifyYaml(v2({
        federation: {
          hub: "https://hub.example",
          "join-token-file": "secrets/join",
        },
      })),
    );
    const config = withMockedEnv(
      GATE_ON,
      () => loadServeConfig(undefined, dir),
    );
    assertPathEquals(
      config?.federation?.["join-token-file"] ?? "",
      join(dir, "secrets", "join"),
    );
  });
  assertThrows(
    () =>
      load(
        GATE_ON,
        v2({ federation: { hub: "https://h", "join-token-file": 3 } }),
      ),
    Error,
    "federation.join-token-file",
  );
});

Deno.test("loadServeConfig: the hub URL accepts https, loopback http and a path prefix", () => {
  const cases: [string, string][] = [
    ["https://hub.example", "https://hub.example"],
    ["https://hub.example/", "https://hub.example"],
    ["https://hub.example/swamp/", "https://hub.example/swamp"],
    ["https://hub.example:8443/a/b", "https://hub.example:8443/a/b"],
    ["http://localhost:8080", "http://localhost:8080"],
    ["http://127.0.0.1:9090/", "http://127.0.0.1:9090"],
    ["http://127.255.0.1", "http://127.255.0.1"],
    ["http://[::1]:9090", "http://[::1]:9090"],
  ];
  for (const [hub, normalised] of cases) {
    assertEquals(
      load(GATE_ON, v2({ federation: { hub } }))?.federation?.hub,
      normalised,
      hub,
    );
  }
});

Deno.test("loadServeConfig: the hub URL refuses non-loopback http, other schemes and lookalike names", () => {
  for (
    const hub of [
      "http://hub.example",
      "http://127.0.0.1.example.com",
      "http://localhost.example.com",
      "http://[::2]",
      "http://10.0.0.1",
      "ftp://hub.example",
    ]
  ) {
    assertThrows(
      () => load(GATE_ON, v2({ federation: { hub } })),
      Error,
      "expected https://, or http:// to a loopback host",
      hub,
    );
  }
});

Deno.test("loadServeConfig: the hub URL refuses credentials, a query and a fragment without echoing it", () => {
  const cases: [string, string][] = [
    ["https://user:hunter2@hub.example", "credentials are not allowed"],
    ["https://user@hub.example", "credentials are not allowed"],
    ["https://hub.example/?token=hunter2", "a query string is not allowed"],
    ["https://hub.example/?", "a query string is not allowed"],
    ["https://hub.example/#hunter2", "a fragment is not allowed"],
    ["not a url", "not a URL"],
  ];
  for (const [hub, message] of cases) {
    const error = assertThrows(
      () => load(GATE_ON, v2({ federation: { hub } })),
      Error,
      message,
    );
    assertEquals(error.message.includes("hunter2"), false);
  }
});

Deno.test("loadServeConfig: a non-string hub is refused without echoing it", () => {
  const error = assertThrows(
    () => load(GATE_ON, v2({ federation: { hub: 4815162342 } })),
    Error,
    "expected a URL string, got number",
  );
  assertEquals(error.message.includes("4815162342"), false);
});
