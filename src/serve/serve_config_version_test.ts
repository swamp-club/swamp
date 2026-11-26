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
    try {
      Deno.removeSync(dir, { recursive: true });
    } catch { /* Windows EBUSY */ }
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
