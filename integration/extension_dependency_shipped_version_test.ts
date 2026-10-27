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

/**
 * Push audits the dependency version it ships (swamp-club#3352): the real
 * prepare deps read the lockfile the bundler honours from a temp project on
 * disk and hand it to the trust checker. The registries are an injected
 * fetch, so only the lockfile wiring is under test.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createExtensionPushPrepareDeps } from "../src/libswamp/extensions/push.ts";
import type {
  DependencySpecifier,
} from "@swamp-club/extension-scoring/dependency-audit";

const PACKUMENT = {
  "dist-tags": { latest: "2.1.3" },
  versions: {
    "2.0.0": { license: "MIT", maintainers: [{ name: "a" }] },
    "2.1.3": { license: "MIT", maintainers: [{ name: "a" }] },
  },
  time: { "2.1.3": new Date().toISOString() },
};

const LOCK = {
  version: "5",
  specifiers: { "npm:ms@2": "2.0.0" },
  npm: { "ms@2.0.0": { integrity: "x" } },
};

function fakeRegistries(url: string | URL): Promise<Response> {
  const host = new URL(String(url)).host;
  if (host === "registry.npmjs.org") {
    return Promise.resolve(Response.json(PACKUMENT));
  }
  if (host === "api.npmjs.org") {
    return Promise.resolve(Response.json({ downloads: 1_000_000 }));
  }
  if (host === "api.osv.dev") {
    return Promise.resolve(Response.json({ vulns: [] }));
  }
  throw new Error(`unexpected call to ${host}`);
}

const MS_RANGE: DependencySpecifier = {
  name: "ms",
  version: "^2.0.0",
  registry: "npm",
  sourceFile: "models/a.ts",
};

async function withProject(
  files: Record<string, unknown>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-shipped-version-" });
  try {
    for (const [rel, body] of Object.entries(files)) {
      await Deno.writeTextFile(
        join(dir, rel),
        typeof body === "string" ? body : JSON.stringify(body),
      );
    }
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

const deps = createExtensionPushPrepareDeps(undefined, {
  fetch: fakeRegistries,
});

Deno.test("push dependency audit: a deno.json project audits the version its deno.lock pins", async () => {
  await withProject({ "deno.json": "{}", "deno.lock": LOCK }, async (dir) => {
    const result = await deps.checkDependencyTrust([MS_RANGE], {
      denoConfigPath: join(dir, "deno.json"),
    });
    assertEquals(result.audited[0].version, "2.0.0");
    assertEquals(result.audited[0].resolvedFrom, "lockfile");
    // The lock fixed the range's version, so it costs nothing
    // (swamp-club#3970).
    assertEquals(result.warnings.map((w) => w.message), []);
  });
});

Deno.test("push dependency audit: package.json mode reads the deno.lock in that directory", async () => {
  await withProject(
    { "package.json": "{}", "deno.lock": LOCK },
    async (dir) => {
      const result = await deps.checkDependencyTrust([MS_RANGE], {
        packageJsonDir: dir,
      });
      assertEquals(result.audited[0].resolvedFrom, "lockfile");
    },
  );
});

Deno.test("push dependency audit: the import's own lock entry decides, not a higher transitive copy", async () => {
  await withProject({
    "deno.json": "{}",
    "deno.lock": {
      ...LOCK,
      npm: { "ms@2.0.0": { integrity: "x" }, "ms@2.1.3": { integrity: "x" } },
    },
  }, async (dir) => {
    const result = await deps.checkDependencyTrust([MS_RANGE], {
      denoConfigPath: join(dir, "deno.json"),
    });
    assertEquals(result.audited[0].version, "2.0.0");
    assertEquals(result.audited[0].resolvedFrom, "lockfile");
  });
});

Deno.test("push dependency audit: a deno.json with lock false resolves from the registry", async () => {
  await withProject(
    { "deno.json": { lock: false }, "deno.lock": LOCK },
    async (dir) => {
      const result = await deps.checkDependencyTrust([MS_RANGE], {
        denoConfigPath: join(dir, "deno.json"),
      });
      assertEquals(result.audited[0].resolvedFrom, "registry");
    },
  );
});
