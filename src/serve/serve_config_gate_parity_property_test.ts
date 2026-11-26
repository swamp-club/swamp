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

import { assertEquals } from "@std/assert";
import { configure, type LogRecord } from "@logtape/logtape";
import { stringify as stringifyYaml } from "@std/yaml";
import { join } from "@std/path";
import fc from "fast-check";
import { initializeLogging } from "../infrastructure/logging/logger.ts";
import { withMockedEnv } from "../infrastructure/persistence/path_test_helpers.ts";
import { FEDERATION_GATE_VARIABLE } from "../domain/serve/federation_gate.ts";
import { loadServeConfig } from "./serve_config.ts";

await initializeLogging({});

// version 1 files, valid and invalid, covering every key set the loader knows
const FIXTURES: string[] = [
  "",
  "port: 9090\n",
  "version: 1\nport: 9090\n",
  "version: 1\nfederation:\n  role: hub\n",
  "federation:\n  hub: https://hub.example\n  bogus: 1\n",
  "prot: 1\nauth:\n  mod: none\ntls:\n  cert: x\n",
  "auth:\n  mode: token\n  admins: [alice]\n  extra: true\n",
  "token-secrets:\n  vault: v\n  key: k\n  extra: 1\n",
  "audit:\n  storez: []\n  hmac:\n    vault: v\n    key: k\n    enable: true\n",
  "audit:\n  sinks:\n    - type: webhook\n      url: https://a.example\n      ur1: x\n    - type: syslog\n      host: h\n      prot: 1\n",
  "triggers:\n  nightly:\n    schedule: '0 0 * * *'\n    catchup: skip\n",
  "webhooks:\n  - route: /a\n    workflow: w\n    secret: s\n    shceme: github\n",
  "triggers:\n  nightly:\n    inputs:\n      anything: 1\n",
  "port: not-a-number\n",
  "host: 0.0.0.0\nschedule: false\ndashboard: true\nremote-only: true\n",
  "- a list\n",
  "token-gc-grace-period: 0\n",
];

interface Outcome {
  result?: unknown;
  error?: string;
  warnings: string[];
}

async function outcome(
  yaml: string,
  gate: string | undefined,
): Promise<Outcome> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-parity-" });
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
    await Deno.mkdir(join(dir, ".swamp"), { recursive: true });
    await Deno.writeTextFile(join(dir, ".swamp", "serve.yaml"), yaml);
    const out: Outcome = { warnings: [] };
    try {
      out.result = withMockedEnv(
        { [FEDERATION_GATE_VARIABLE]: gate },
        () => loadServeConfig(undefined, dir),
      );
    } catch (error) {
      out.error = error instanceof Error ? error.message : String(error);
    }
    out.warnings = captured.map((r) =>
      `${String(r.rawMessage)} ${JSON.stringify(r.properties)}`
        .replaceAll(dir, "<dir>")
    );
    if (out.error !== undefined) out.error = out.error.replaceAll(dir, "<dir>");
    return out;
  } finally {
    await initializeLogging({ _reset: true });
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("loadServeConfig parity: every version 1 fixture loads the same with the gate off and on", async () => {
  for (const yaml of FIXTURES) {
    assertEquals(
      await outcome(yaml, "1"),
      await outcome(yaml, undefined),
      yaml,
    );
  }
});

const KNOWN_KEYS = [
  "port",
  "host",
  "schedule",
  "dashboard",
  "remote-only",
  "auth",
  "tls",
  "triggers",
  "webhooks",
  "federation",
];

Deno.test("loadServeConfig parity property: generated version 1 files load the same with the gate off and on", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.dictionary(
        fc.oneof(
          fc.constantFrom(...KNOWN_KEYS),
          fc.string({ minLength: 1 }).filter((key) =>
            key !== "version" && key !== "__proto__"
          ),
        ),
        fc.oneof(
          fc.integer(),
          fc.boolean(),
          fc.string(),
          fc.dictionary(fc.string({ minLength: 1 }), fc.string()),
        ),
        { maxKeys: 6 },
      ),
      fc.constantFrom(undefined, 1),
      async (mapping, version) => {
        const config = version === undefined
          ? mapping
          : { ...mapping, version };
        const yaml = stringifyYaml(config);
        assertEquals(await outcome(yaml, "1"), await outcome(yaml, undefined));
      },
    ),
    { numRuns: 50 },
  );
});
