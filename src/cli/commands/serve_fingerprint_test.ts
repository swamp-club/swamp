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

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { Command } from "@cliffy/command";
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { withMockedEnv } from "../../infrastructure/persistence/path_test_helpers.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { RepoService } from "../../domain/repo/repo_service.ts";
import { VERSION } from "../../infrastructure/runtime/build_info.ts";
import { FEDERATION_GATE_VARIABLE } from "../../domain/serve/federation_gate.ts";
import type { DatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import type { DatastoreProvider } from "../../domain/datastore/datastore_provider.ts";
import { fingerprintDatastoreFacts } from "./serve_fingerprint.ts";

import "../../domain/models/models.ts";

await initializeLogging({});

const CUSTOM = {
  type: "@acme/datastore",
  config: {},
  cachePath: "/tmp/cache",
} as unknown as DatastoreConfig;

function fakeProvider(calls: string[], controlPlane: boolean) {
  const sync = new Proxy({}, {
    get: (_target, name) => {
      if (name === "capabilities") {
        return () => {
          calls.push("capabilities");
          return { controlPlane };
        };
      }
      if (name === "then") return undefined;
      return () => {
        calls.push(String(name));
      };
    },
  });
  return new Proxy({}, {
    get: (_target, name) => {
      if (name === "createSyncService") {
        return () => {
          calls.push("createSyncService");
          return sync;
        };
      }
      if (name === "then") return undefined;
      return () => {
        calls.push(String(name));
      };
    },
  }) as unknown as DatastoreProvider;
}

Deno.test("fingerprintDatastoreFacts: the filesystem datastore needs nothing opened", async () => {
  const facts = await fingerprintDatastoreFacts(
    {
      datastoreConfig: { type: "filesystem", path: "/x" } as DatastoreConfig,
      engine: "v2",
    },
    "/repo",
    () => Promise.reject(new Error("must not load")),
  );
  assertEquals(facts, {
    customType: undefined,
    format: "v2",
    hasControlPlane: false,
  });
});

Deno.test("fingerprintDatastoreFacts: a v3 datastore has a control plane without opening anything", async () => {
  const facts = await fingerprintDatastoreFacts(
    { datastoreConfig: CUSTOM, engine: "v3" },
    "/repo",
    () => Promise.reject(new Error("must not load")),
  );
  assertEquals(facts, {
    customType: "@acme/datastore",
    format: "v3",
    hasControlPlane: true,
  });
});

Deno.test("fingerprintDatastoreFacts: an extension datastore is asked for its capabilities only", async () => {
  for (const controlPlane of [true, false]) {
    const calls: string[] = [];
    const facts = await fingerprintDatastoreFacts(
      { datastoreConfig: CUSTOM, engine: "v2" },
      "/repo",
      () => Promise.resolve(fakeProvider(calls, controlPlane)),
    );
    assertEquals(facts.hasControlPlane, controlPlane);
    assertEquals(calls, ["createSyncService", "capabilities"]);
  }
});

Deno.test("fingerprintDatastoreFacts: a provider that cannot load is a named error", async () => {
  await assertRejects(
    () =>
      fingerprintDatastoreFacts(
        { datastoreConfig: CUSTOM, engine: "v2" },
        "/repo",
        () => Promise.reject(new Error("extension not installed")),
      ),
    Error,
    "Cannot read the capabilities of datastore @acme/datastore: extension not installed",
  );
});

async function fingerprintJson(dir: string): Promise<Record<string, unknown>> {
  const { serveFingerprintCommand } = await import("./serve_fingerprint.ts");
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (msg: string) => logs.push(msg);
  try {
    await withMockedEnv(
      { [FEDERATION_GATE_VARIABLE]: "1" },
      () =>
        new Command()
          .throwErrors()
          .globalOption("--json", "JSON output")
          .command("fingerprint", serveFingerprintCommand)
          .parse(["fingerprint", "--json", "--repo-dir", dir]),
    );
  } finally {
    console.log = originalLog;
  }
  return JSON.parse(logs[logs.length - 1]);
}

Deno.test("serveFingerprintCommand: prints a stable fingerprint of a fresh repository", async () => {
  const dir = await Deno.makeTempDir({ prefix: "swamp-fingerprint-" });
  try {
    const homeDir = join(dir, "test-home");
    await new RepoService(VERSION, {
      homeDir,
      configDir: join(homeDir, ".config", "swamp"),
    }).init(RepoPath.create(dir), { tools: [] });
    await Deno.writeTextFile(
      join(dir, ".swamp", "serve.yaml"),
      "version: 2\nhost: 0.0.0.0\nfederation:\n  role: hub\n",
    );

    const first = await fingerprintJson(dir);
    const second = await fingerprintJson(dir);
    assertEquals(second.hash, first.hash);
    const fingerprint = first.fingerprint as Record<string, unknown>;
    assertEquals(fingerprint.serveYamlVersion, 2);
    assertEquals(fingerprint.federationRole, "hub");
    assertEquals(fingerprint.loopbackOnly, false);
    assertEquals(fingerprint.datastoreKind, "filesystem");
    assertEquals(fingerprint.deploymentMode, "local");
    assertEquals(fingerprint.workers, {
      total: 0,
      byVersion: {},
      byLabelKey: {},
    });
    assertEquals(fingerprint.team, null);
    assertEquals(JSON.stringify(first).includes(dir), false);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});
