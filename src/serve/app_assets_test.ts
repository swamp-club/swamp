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

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { capabilityKey } from "../domain/apps/app_descriptor.ts";
import type { AppApproval } from "../domain/apps/app_approval.ts";
import type { InstalledApp } from "../domain/apps/app_catalog.ts";
import {
  APP_LAUNCH_TTL_MS,
  appApprovalStamp,
  type AppLaunchKey,
  mintAppLaunchToken,
} from "../domain/apps/app_launch.ts";
import { EphemeralAppLaunchKey } from "./app_launch_key.ts";
import {
  APP_BASE_HEADER,
  cachedAppCatalog,
  isAppPath,
  serveAppRoute,
} from "./app_assets.ts";

const NOW = Date.parse("2026-11-04T01:00:00.000Z");

const firstApproval = {
  capabilityKey: "",
  approvedAt: "2026-11-04T00:00:00.000Z",
};

async function mint(
  key: AppLaunchKey,
  options: {
    readonly name?: string;
    readonly approval?: { capabilityKey: string; approvedAt: string };
    readonly expiresAt?: number;
  } = {},
): Promise<string> {
  return await mintAppLaunchToken(await key.signing(), {
    name: options.name ?? descriptor.name,
    expiresAt: options.expiresAt ?? NOW + APP_LAUNCH_TTL_MS,
    approvalStamp: await appApprovalStamp(
      options.approval ?? {
        ...firstApproval,
        capabilityKey: capabilityKey(descriptor, "local"),
      },
    ),
  });
}

const descriptor = {
  name: "@acme/cost",
  title: "Cost",
  entry: "dist/index.html",
  bridge: 1 as const,
  platform: 1,
  capabilities: ["runs:read" as const],
  run: [],
  methods: [],
};

async function setup(
  body: (ctx: {
    dir: string;
    get(path: string, init?: RequestInit): Promise<Response | null>;
    launchId: string;
    launchKey: AppLaunchKey;
    revoke(): void;
    reapprove(approvedAt: string): void;
    trustBase(value: boolean): void;
  }) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "dist"));
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(join(dir, "dist", "index.html"), "<html>app");
    await Deno.writeTextFile(join(dir, "dist", "main.js"), "1");
    await Deno.writeTextFile(join(dir, "dist", "tool.sh"), "x");
    await Deno.writeTextFile(join(dir, "src", "secret.ts"), "secret");
    await Deno.writeTextFile(join(dir, "app.yaml"), "x");
    const app: InstalledApp = {
      descriptor,
      root: dir,
      origin: "local",
      built: true,
    };
    let approval: AppApproval | null = {
      name: descriptor.name,
      capabilityKey: capabilityKey(descriptor, "local"),
      approvedBy: "user:a",
      approvedAt: firstApproval.approvedAt,
    };
    const launchKey = new EphemeralAppLaunchKey();
    const launchId = await mint(launchKey);
    let trustBaseHeader = false;
    await body({
      dir,
      launchId,
      launchKey,
      revoke: () => {
        approval = null;
      },
      reapprove: (approvedAt) => {
        approval = {
          name: descriptor.name,
          capabilityKey: capabilityKey(descriptor, "local"),
          approvedBy: "user:a",
          approvedAt,
        };
      },
      trustBase: (value) => {
        trustBaseHeader = value;
      },
      get: (path, init) =>
        serveAppRoute(new Request(`http://serve.test${path}`, init), {
          launchKey,
          now: () => new Date(NOW),
          catalog: {
            list: () => Promise.resolve({ apps: [app], problems: [] }),
          },
          approvals: {
            get: () => Promise.resolve(approval),
            save: () => Promise.resolve(),
            delete: () => Promise.resolve(true),
          },
          trustBaseHeader,
        }),
    });
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("serveAppRoute: leaves every other path alone", async () => {
  await setup(async ({ get }) => {
    assertEquals(await get("/dashboard/index.html"), null);
    assertEquals(isAppPath("/app-files/id/index.html"), true);
    assertEquals(isAppPath("/apps/x/index.html"), false);
  });
});

Deno.test("serveAppRoute: serves a file under the sandbox", async () => {
  await setup(async ({ get, launchId }) => {
    const response = await get(`/app-files/${launchId}/index.html`);
    assertEquals(response?.status, 200);
    assertEquals(await response?.text(), "<html>app");
    const policy = response?.headers.get("content-security-policy") ?? "";
    assertStringIncludes(
      policy,
      "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox;",
    );
    assertStringIncludes(policy, "form-action 'none'");
    assertStringIncludes(
      policy,
      `script-src serve.test/app-files/${launchId}/`,
    );
    assertEquals(response?.headers.get("x-content-type-options"), "nosniff");
    // only the dashboard's own documents isolate their opener
    assertEquals(response?.headers.get("cross-origin-opener-policy"), null);
  });
});

Deno.test("serveAppRoute: every refusal also carries the sandbox", async () => {
  await setup(async ({ get, launchId }) => {
    for (
      const path of [
        "/app-files/unknown/index.html",
        `/app-files/${launchId}/missing.js`,
        `/app-files/${launchId}/tool.sh`,
      ]
    ) {
      const response = await get(path);
      assertEquals(response?.status, 404, path);
      assertStringIncludes(
        response?.headers.get("content-security-policy") ?? "",
        "sandbox allow-scripts",
        path,
      );
    }
  });
});

Deno.test("serveAppRoute: a missing file never falls back to another page", async () => {
  await setup(async ({ get, launchId }) => {
    const response = await get(`/app-files/${launchId}/deep/link`);
    assertEquals(response?.status, 404);
    assert(!(await response?.text() ?? "").includes("<html"));
  });
});

Deno.test("serveAppRoute: only the build folder is reachable", async () => {
  await setup(async ({ get, launchId }) => {
    for (
      const path of ["../src/secret.ts", "..%2Fsrc%2Fsecret.ts", "../app.yaml"]
    ) {
      const response = await get(`/app-files/${launchId}/${path}`);
      assert(response?.status !== 200, path);
      assert(!(await response?.text() ?? "").includes("secret"), path);
    }
  });
});

Deno.test("serveAppRoute: a symlink out of the build is refused", async () => {
  await setup(async ({ dir, get, launchId }) => {
    await Deno.symlink(
      join(dir, "src", "secret.ts"),
      join(dir, "dist", "link.js"),
      { type: "file" },
    );
    const response = await get(`/app-files/${launchId}/link.js`);
    assertEquals(response?.status, 403);
  });
});

Deno.test("serveAppRoute: a revoked app stops at its next file", async () => {
  await setup(async ({ get, launchId, revoke }) => {
    assertEquals((await get(`/app-files/${launchId}/main.js`))?.status, 200);
    revoke();
    assertEquals((await get(`/app-files/${launchId}/main.js`))?.status, 404);
  });
});

Deno.test("serveAppRoute: a cookie grants nothing and changes nothing", async () => {
  await setup(async ({ get, launchId }) => {
    const headers = { cookie: "swamp_dashboard_session=abc" };
    assertEquals(
      (await get("/app-files/unknown/index.html", { headers }))?.status,
      404,
    );
    const response = await get(`/app-files/${launchId}/index.html`, {
      headers,
    });
    assertEquals(response?.headers.get("set-cookie"), null);
  });
});

Deno.test("serveAppRoute: only reads are answered", async () => {
  await setup(async ({ get, launchId }) => {
    const response = await get(`/app-files/${launchId}/index.html`, {
      method: "POST",
    });
    assertEquals(response?.status, 405);
  });
});

Deno.test("serveAppRoute: the base header is ignored unless the hub is trusted", async () => {
  await setup(async ({ get, launchId, trustBase }) => {
    const headers = { [APP_BASE_HEADER]: "evil.example/" };
    const untrusted = await get(`/app-files/${launchId}/index.html`, {
      headers,
    });
    assert(
      !(untrusted?.headers.get("content-security-policy") ?? "").includes(
        "evil.example",
      ),
    );
    trustBase(true);
    const trusted = await get(`/app-files/${launchId}/index.html`, { headers });
    assertStringIncludes(
      trusted?.headers.get("content-security-policy") ?? "",
      "evil.example/",
    );
  });
});

Deno.test("serveAppRoute: a build folder that is itself a symlink is refused", async () => {
  await setup(async ({ dir, get, launchId }) => {
    const outside = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(join(outside, "secret.json"), "{}");
      await Deno.remove(join(dir, "dist"), { recursive: true });
      await Deno.symlink(outside, join(dir, "dist"), { type: "dir" });
      const response = await get(`/app-files/${launchId}/secret.json`);
      assertEquals(response?.status, 403);
      await response?.body?.cancel();
    } finally {
      if (Deno.build.os === "windows") {
        await Deno.remove(outside, { recursive: true }).catch(() => {});
      } else {
        await Deno.remove(outside, { recursive: true });
      }
    }
  });
});

Deno.test("serveAppRoute: a failing catalog still answers under the sandbox", async () => {
  const launchKey = new EphemeralAppLaunchKey();
  const id = await mint(launchKey);
  const response = await serveAppRoute(
    new Request(`http://serve.test/app-files/${id}/index.html`),
    {
      launchKey,
      now: () => new Date(NOW),
      catalog: { list: () => Promise.reject(new Error("boom")) },
      approvals: {
        get: () => Promise.resolve(null),
        save: () => Promise.resolve(),
        delete: () => Promise.resolve(false),
      },
    },
  );
  assertEquals(response?.status, 500);
  assertStringIncludes(
    response?.headers.get("content-security-policy") ?? "",
    "sandbox allow-scripts",
  );
  await response?.body?.cancel();
});

Deno.test("cachedAppCatalog: a page's files share one listing", async () => {
  let reads = 0;
  const catalog = cachedAppCatalog({
    list: () => {
      reads++;
      return Promise.resolve({ apps: [], problems: [] });
    },
  });
  await Promise.all([catalog.list(), catalog.list(), catalog.list()]);
  assertEquals(reads, 1);
});

Deno.test("cachedAppCatalog: a failed listing is not kept", async () => {
  let reads = 0;
  const catalog = cachedAppCatalog({
    list: () => {
      reads++;
      return reads === 1
        ? Promise.reject(new Error("boom"))
        : Promise.resolve({ apps: [], problems: [] });
    },
  });
  await catalog.list().catch(() => {});
  await catalog.list();
  assertEquals(reads, 2);
});

Deno.test("serveAppRoute: the forwarded host counts only behind a trusted proxy", async () => {
  const launchKey = new EphemeralAppLaunchKey();
  const id = await mint(launchKey);
  const dir = await Deno.makeTempDir();
  try {
    const policy = async (trustProxy: boolean) => {
      const response = await serveAppRoute(
        new Request(`http://internal:9090/app-files/${id}/missing.js`, {
          headers: { "x-forwarded-host": "public.example" },
        }),
        {
          launchKey,
          now: () => new Date(NOW),
          catalog: {
            list: () =>
              Promise.resolve({
                apps: [{ descriptor, root: dir, origin: "local", built: true }],
                problems: [],
              }),
          },
          approvals: {
            get: () => Promise.resolve(null),
            save: () => Promise.resolve(),
            delete: () => Promise.resolve(false),
          },
          trustProxy,
        },
      );
      await response?.body?.cancel();
      return response?.headers.get("content-security-policy") ?? "";
    };
    assertStringIncludes(await policy(true), "public.example/app-files/");
    assert(!(await policy(false)).includes("public.example"));
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("serveAppRoute: a host that is not host[:port] never reaches the policy", async () => {
  const launchKey = new EphemeralAppLaunchKey();
  const id = await mint(launchKey);
  const policy = async (headers: Record<string, string>) => {
    const response = await serveAppRoute(
      new Request(`http://internal:9090/app-files/${id}/missing.js`, {
        headers,
      }),
      {
        launchKey,
        now: () => new Date(NOW),
        catalog: {
          list: () => Promise.resolve({ apps: [], problems: [] }),
        },
        approvals: {
          get: () => Promise.resolve(null),
          save: () => Promise.resolve(),
          delete: () => Promise.resolve(false),
        },
        trustProxy: true,
      },
    );
    await response?.body?.cancel();
    return response?.headers.get("content-security-policy") ?? "";
  };
  const injected = await policy({
    "x-forwarded-host": "evil.example; script-src *",
  });
  assert(!injected.includes("evil.example"));
  assertStringIncludes(injected, "script-src internal:9090/app-files/");
  assertStringIncludes(
    await policy({ "x-forwarded-host": "[::1]:8080" }),
    "script-src [::1]:8080/app-files/",
  );
});

Deno.test("serveAppRoute: a malformed launch token is refused before any key read or header", async () => {
  let lookups = 0;
  const response = await serveAppRoute(
    new Request(
      "http://serve.test/app-files/x%22%3B%20script-src%20*/index.html",
    ),
    {
      launchKey: {
        signing: () => Promise.reject(new Error("unused")),
        verifying: () => {
          lookups++;
          return Promise.resolve(undefined);
        },
      },
      catalog: { list: () => Promise.resolve({ apps: [], problems: [] }) },
      approvals: {
        get: () => Promise.resolve(null),
        save: () => Promise.resolve(),
        delete: () => Promise.resolve(false),
      },
    },
  );
  assertEquals(response?.status, 404);
  await response?.body?.cancel();
  assertEquals(lookups, 0);
  assert(
    !(response?.headers.get("content-security-policy") ?? "").includes(
      "script-src *",
    ),
  );
});

Deno.test("serveAppRoute: an expired launch is refused as an unknown one", async () => {
  await setup(async ({ get, launchKey }) => {
    const expired = await mint(launchKey, { expiresAt: NOW });
    const response = await get(`/app-files/${expired}/index.html`);
    assertEquals(response?.status, 404);
    assertStringIncludes(
      response?.headers.get("content-security-policy") ?? "",
      "sandbox allow-scripts",
    );
    await response?.body?.cancel();
  });
});

Deno.test("serveAppRoute: a launch signed with another key is refused", async () => {
  await setup(async ({ get }) => {
    const forged = await mint(new EphemeralAppLaunchKey());
    const response = await get(`/app-files/${forged}/index.html`);
    assertEquals(response?.status, 404);
    await response?.body?.cancel();
  });
});

Deno.test("serveAppRoute: a launch made before a revoke stays dead after a new approval", async () => {
  await setup(async ({ get, launchId, launchKey, revoke, reapprove }) => {
    revoke();
    const approvedAt = "2026-11-04T00:30:00.000Z";
    reapprove(approvedAt);
    const old = await get(`/app-files/${launchId}/index.html`);
    assertEquals(old?.status, 404);
    await old?.body?.cancel();
    const fresh = await mint(launchKey, {
      approval: {
        capabilityKey: capabilityKey(descriptor, "local"),
        approvedAt,
      },
    });
    const current = await get(`/app-files/${fresh}/index.html`);
    assertEquals(current?.status, 200);
    await current?.body?.cancel();
  });
});

Deno.test("serveAppRoute: a launch for another app never reaches this one", async () => {
  await setup(async ({ get, launchKey }) => {
    const other = await mint(launchKey, { name: "@acme/other" });
    const response = await get(`/app-files/${other}/index.html`);
    assertEquals(response?.status, 404);
    await response?.body?.cancel();
  });
});
