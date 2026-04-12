// Swamp, an Automation Framework Copyright (C) 2026 System Initiative, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify it under the terms
// of the GNU Affero General Public License version 3 as published by the Free
// Software Foundation, with the Swamp Extension and Definition Exception (found in
// the "COPYING-EXCEPTION" file).
//
// Swamp is distributed in the hope that it will be useful, but WITHOUT ANY
// WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
// PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License along
// with Swamp. If not, see <https://www.gnu.org/licenses/>.

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { model } from "./issue_lifecycle.ts";
import { PR_COOLDOWN_MS } from "./_lib/schemas.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface RecordedWrite {
  specName: string;
  instanceName: string;
  data: Record<string, unknown>;
}

/**
 * Build a fake method execution context that records writes and short-circuits
 * the swamp-club client by pointing HOME/XDG_CONFIG_HOME at an empty temp dir
 * and clearing credential env vars.
 *
 * Callers must `restore()` in a finally block to put env vars back.
 */
async function buildTestContext(
  issueNumber: number,
  opts?: { resources?: Record<string, Record<string, unknown>> },
): Promise<{
  context: Parameters<typeof model.methods.pr_merged.execute>[1];
  writes: RecordedWrite[];
  restore: () => Promise<void>;
}> {
  const writes: RecordedWrite[] = [];
  const resources: Record<string, Record<string, unknown>> = {
    ...opts?.resources,
  };
  const tempDir = await Deno.makeTempDir({ prefix: "issue_lifecycle_test_" });

  const original = {
    SWAMP_API_KEY: Deno.env.get("SWAMP_API_KEY"),
    SWAMP_CLUB_URL: Deno.env.get("SWAMP_CLUB_URL"),
    HOME: Deno.env.get("HOME"),
    XDG_CONFIG_HOME: Deno.env.get("XDG_CONFIG_HOME"),
  };

  Deno.env.delete("SWAMP_API_KEY");
  Deno.env.delete("SWAMP_CLUB_URL");
  Deno.env.set("HOME", tempDir);
  Deno.env.set("XDG_CONFIG_HOME", tempDir);

  const restore = async () => {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) {
        Deno.env.delete(k);
      } else {
        Deno.env.set(k, v);
      }
    }
    await Deno.remove(tempDir, { recursive: true });
  };

  const context = {
    globalArgs: { issueNumber },
    logger: {
      info: () => {},
      warning: () => {},
    },
    writeResource: (
      specName: string,
      instanceName: string,
      data: Record<string, unknown>,
    ) => {
      writes.push({ specName, instanceName, data });
      resources[instanceName] = data;
      return Promise.resolve({ name: instanceName });
    },
    readResource: (
      instanceName: string,
      _version?: number,
    ) => {
      return Promise.resolve(resources[instanceName] ?? null);
    },
  };

  return { context, writes, restore };
}

// ---------------------------------------------------------------------------
// link_pr
// ---------------------------------------------------------------------------

Deno.test("link_pr: writes pullRequest-main resource with url, attempt, and linkedAt", async () => {
  const { context, writes, restore } = await buildTestContext(42);
  try {
    await model.methods.link_pr.execute(
      { url: "https://github.com/systeminit/swamp/pull/1141" },
      context,
    );

    const prWrite = writes.find((w) => w.specName === "pullRequest");
    assertEquals(prWrite !== undefined, true);
    assertEquals(
      prWrite!.instanceName,
      "pullRequest-main",
      "pullRequest resource must use the single-instance '-main' naming",
    );
    assertEquals(
      prWrite!.data.url,
      "https://github.com/systeminit/swamp/pull/1141",
    );
    assertEquals(prWrite!.data.attempt, 1);
    assertEquals(typeof prWrite!.data.linkedAt, "string");
  } finally {
    await restore();
  }
});

Deno.test("link_pr: transitions state to pr_open", async () => {
  const { context, writes, restore } = await buildTestContext(42);
  try {
    await model.methods.link_pr.execute(
      { url: "https://github.com/systeminit/swamp/pull/1141" },
      context,
    );

    const stateWrite = writes.find((w) => w.specName === "state");
    assertEquals(stateWrite !== undefined, true);
    assertEquals(stateWrite!.instanceName, "state-main");
    assertEquals(stateWrite!.data.phase, "pr_open");
    assertEquals(stateWrite!.data.issueNumber, 42);
  } finally {
    await restore();
  }
});

Deno.test("link_pr: is idempotent — second call increments attempt", async () => {
  const { context, writes, restore } = await buildTestContext(42);
  try {
    await model.methods.link_pr.execute(
      { url: "https://github.com/systeminit/swamp/pull/1141" },
      context,
    );
    await model.methods.link_pr.execute(
      { url: "https://github.com/systeminit/swamp/pull/1142" },
      context,
    );

    const prWrites = writes.filter((w) => w.specName === "pullRequest");
    assertEquals(prWrites.length, 2);
    assertEquals(
      prWrites[0].instanceName,
      prWrites[1].instanceName,
      "both writes target the same instance so the second overwrites the first",
    );
    assertEquals(
      prWrites[1].data.url,
      "https://github.com/systeminit/swamp/pull/1142",
    );
    assertEquals(prWrites[0].data.attempt, 1);
    assertEquals(prWrites[1].data.attempt, 2);
  } finally {
    await restore();
  }
});

Deno.test("link_pr: rejects empty url via zod schema", async () => {
  await assertRejects(
    () => model.methods.link_pr.arguments.parseAsync({ url: "" }),
  );
});

Deno.test("link_pr: from pr_failed clears failure fields and increments attempt", async () => {
  const { context, writes, restore } = await buildTestContext(42, {
    resources: {
      "pullRequest-main": {
        url: "https://github.com/systeminit/swamp/pull/1141",
        attempt: 1,
        linkedAt: "2026-04-09T10:00:00.000Z",
        failedAt: "2026-04-09T10:05:00.000Z",
        failureReason: "CI failed",
      },
    },
  });
  try {
    await model.methods.link_pr.execute(
      { url: "https://github.com/systeminit/swamp/pull/1142" },
      context,
    );

    const prWrite = writes.find((w) => w.specName === "pullRequest");
    assertEquals(prWrite !== undefined, true);
    assertEquals(
      prWrite!.data.url,
      "https://github.com/systeminit/swamp/pull/1142",
    );
    assertEquals(prWrite!.data.attempt, 2);
    // link_pr overwrites the entire resource — failure fields are absent
    assertEquals(prWrite!.data.failedAt, undefined);
    assertEquals(prWrite!.data.failureReason, undefined);
  } finally {
    await restore();
  }
});

// ---------------------------------------------------------------------------
// pr-cooldown check
// ---------------------------------------------------------------------------

Deno.test("pr-cooldown: rejects when PR was linked too recently", async () => {
  const recentLinkedAt = new Date().toISOString();
  const checkContext = {
    methodName: "pr_merged",
    dataRepository: {
      getContent: (
        _type: string,
        _modelId: string,
        dataName: string,
      ) => {
        if (dataName === "pullRequest-main") {
          return Promise.resolve(
            new TextEncoder().encode(
              JSON.stringify({
                url: "https://github.com/systeminit/swamp/pull/1",
                linkedAt: recentLinkedAt,
              }),
            ),
          );
        }
        return Promise.resolve(null);
      },
    },
    modelType: "@swamp/issue-lifecycle",
    modelId: "issue-42",
  };

  const result = await model.checks["pr-cooldown"].execute(checkContext);
  assertEquals(result.pass, false);
  assertStringIncludes(result.errors![0], "Wait");
});

Deno.test("pr-cooldown: passes when enough time has elapsed", async () => {
  const oldLinkedAt = new Date(
    Date.now() - PR_COOLDOWN_MS - 1000,
  ).toISOString();
  const checkContext = {
    methodName: "pr_merged",
    dataRepository: {
      getContent: (
        _type: string,
        _modelId: string,
        dataName: string,
      ) => {
        if (dataName === "pullRequest-main") {
          return Promise.resolve(
            new TextEncoder().encode(
              JSON.stringify({
                url: "https://github.com/systeminit/swamp/pull/1",
                linkedAt: oldLinkedAt,
              }),
            ),
          );
        }
        return Promise.resolve(null);
      },
    },
    modelType: "@swamp/issue-lifecycle",
    modelId: "issue-42",
  };

  const result = await model.checks["pr-cooldown"].execute(checkContext);
  assertEquals(result.pass, true);
});

Deno.test("pr-cooldown: rejects when no pullRequest is linked", async () => {
  const checkContext = {
    methodName: "pr_merged",
    dataRepository: {
      getContent: () => Promise.resolve(null),
    },
    modelType: "@swamp/issue-lifecycle",
    modelId: "issue-42",
  };

  const result = await model.checks["pr-cooldown"].execute(checkContext);
  assertEquals(result.pass, false);
  assertStringIncludes(result.errors![0], "No pull request linked");
});

// ---------------------------------------------------------------------------
// Model registration smoke tests
// ---------------------------------------------------------------------------

Deno.test("model: exposes the new pullRequest resource definition", () => {
  assertEquals(
    "pullRequest" in model.resources,
    true,
    "pullRequest resource must be registered in model.resources",
  );
});

Deno.test("model: exposes the new link_pr method definition", () => {
  assertEquals(
    "link_pr" in model.methods,
    true,
    "link_pr method must be registered in model.methods",
  );
});

Deno.test("model: version bumped to 2026.04.12.1", () => {
  assertEquals(model.version, "2026.04.12.1");
});

// ---------------------------------------------------------------------------
// pr_merged
// ---------------------------------------------------------------------------

Deno.test("pr_merged: transitions state to releasing and writes mergedAt with attempt", async () => {
  const { context, writes, restore } = await buildTestContext(42, {
    resources: {
      "pullRequest-main": {
        url: "https://github.com/systeminit/swamp/pull/1141",
        attempt: 2,
        linkedAt: "2026-04-09T10:00:00.000Z",
      },
    },
  });
  try {
    await model.methods.pr_merged.execute({}, context);

    const stateWrite = writes.find((w) => w.specName === "state");
    assertEquals(stateWrite !== undefined, true);
    assertEquals(stateWrite!.data.phase, "releasing");
    assertEquals(stateWrite!.data.issueNumber, 42);

    const prWrite = writes.find((w) => w.specName === "pullRequest");
    assertEquals(prWrite !== undefined, true);
    assertEquals(
      prWrite!.data.url,
      "https://github.com/systeminit/swamp/pull/1141",
    );
    assertEquals(prWrite!.data.attempt, 2);
    assertEquals(typeof prWrite!.data.mergedAt, "string");
  } finally {
    await restore();
  }
});

Deno.test("pr_merged: uses provided mergedAt when given", async () => {
  const { context, writes, restore } = await buildTestContext(42, {
    resources: {
      "pullRequest-main": {
        url: "https://github.com/systeminit/swamp/pull/1141",
        attempt: 1,
        linkedAt: "2026-04-09T10:00:00.000Z",
      },
    },
  });
  try {
    await model.methods.pr_merged.execute(
      { mergedAt: "2026-04-09T12:00:00.000Z" },
      context,
    );

    const prWrite = writes.find((w) => w.specName === "pullRequest");
    assertEquals(prWrite!.data.mergedAt, "2026-04-09T12:00:00.000Z");
  } finally {
    await restore();
  }
});

Deno.test("pr_merged: throws if no pullRequest linked", async () => {
  const { context, restore } = await buildTestContext(42);
  try {
    await assertRejects(
      () => model.methods.pr_merged.execute({}, context),
      Error,
      "No pull request linked",
    );
  } finally {
    await restore();
  }
});

// ---------------------------------------------------------------------------
// pr_failed
// ---------------------------------------------------------------------------

Deno.test("pr_failed: transitions state to pr_failed and writes failure info with attempt", async () => {
  const { context, writes, restore } = await buildTestContext(42, {
    resources: {
      "pullRequest-main": {
        url: "https://github.com/systeminit/swamp/pull/1141",
        attempt: 1,
        linkedAt: "2026-04-09T10:00:00.000Z",
      },
    },
  });
  try {
    await model.methods.pr_failed.execute(
      { reason: "CI failed: type check errors" },
      context,
    );

    const stateWrite = writes.find((w) => w.specName === "state");
    assertEquals(stateWrite !== undefined, true);
    assertEquals(stateWrite!.data.phase, "pr_failed");
    assertEquals(stateWrite!.data.issueNumber, 42);

    const prWrite = writes.find((w) => w.specName === "pullRequest");
    assertEquals(prWrite !== undefined, true);
    assertEquals(prWrite!.data.attempt, 1);
    assertEquals(prWrite!.data.failureReason, "CI failed: type check errors");
    assertEquals(typeof prWrite!.data.failedAt, "string");
  } finally {
    await restore();
  }
});

Deno.test("pr_failed: throws if no pullRequest linked", async () => {
  const { context, restore } = await buildTestContext(42);
  try {
    await assertRejects(
      () =>
        model.methods.pr_failed.execute(
          { reason: "CI failed" },
          context,
        ),
      Error,
      "No pull request linked",
    );
  } finally {
    await restore();
  }
});

Deno.test("pr_failed: rejects empty reason via zod schema", async () => {
  await assertRejects(
    () => model.methods.pr_failed.arguments.parseAsync({ reason: "" }),
  );
});

// ---------------------------------------------------------------------------
// ship
// ---------------------------------------------------------------------------

Deno.test("ship: transitions state to done", async () => {
  const { context, writes, restore } = await buildTestContext(42);
  try {
    await model.methods.ship.execute({}, context);

    const stateWrite = writes.find((w) => w.specName === "state");
    assertEquals(stateWrite !== undefined, true);
    assertEquals(stateWrite!.data.phase, "done");
    assertEquals(stateWrite!.data.issueNumber, 42);
  } finally {
    await restore();
  }
});

Deno.test("ship: accepts optional releaseUrl and releaseNotes", async () => {
  const { context, restore } = await buildTestContext(42);
  try {
    // Should not throw
    await model.methods.ship.execute(
      {
        releaseUrl: "https://github.com/systeminit/swamp/releases/tag/v1.0.0",
        releaseNotes: "Bug fix release",
      },
      context,
    );
  } finally {
    await restore();
  }
});

// ---------------------------------------------------------------------------
// Model registration smoke tests (new methods)
// ---------------------------------------------------------------------------

Deno.test("model: exposes pr_merged method definition", () => {
  assertEquals("pr_merged" in model.methods, true);
});

Deno.test("model: exposes pr_failed method definition", () => {
  assertEquals("pr_failed" in model.methods, true);
});

Deno.test("model: exposes ship method definition", () => {
  assertEquals("ship" in model.methods, true);
});

// ---------------------------------------------------------------------------
// start() auto-assignment tests
// ---------------------------------------------------------------------------

interface FetchStubRoute {
  urlIncludes: string;
  method?: string;
  response: { status: number; body: unknown };
}

/**
 * Build a test context for start() with a fetch stub and optional fake auth.json.
 * The fetch stub intercepts all HTTP calls (health check, issue GET, assignees
 * GET, issue PATCH). The fake auth.json provides a username for loadAuthFile().
 */
async function buildStartTestContext(
  issueNumber: number,
  opts: {
    routes: FetchStubRoute[];
    authUsername?: string;
    /** If provided, written to auth.json alongside the username */
    authApiKey?: string;
  },
): Promise<{
  context: Parameters<typeof model.methods.start.execute>[1];
  writes: RecordedWrite[];
  warnings: string[];
  patchBodies: unknown[];
  restore: () => Promise<void>;
}> {
  const writes: RecordedWrite[] = [];
  const warnings: string[] = [];
  const patchBodies: unknown[] = [];
  const tempDir = await Deno.makeTempDir({ prefix: "issue_lifecycle_test_" });

  const original = {
    SWAMP_API_KEY: Deno.env.get("SWAMP_API_KEY"),
    SWAMP_CLUB_URL: Deno.env.get("SWAMP_CLUB_URL"),
    HOME: Deno.env.get("HOME"),
    XDG_CONFIG_HOME: Deno.env.get("XDG_CONFIG_HOME"),
  };
  const originalFetch = globalThis.fetch;

  // Write fake auth.json if credentials are provided
  if (opts.authUsername || opts.authApiKey) {
    const configDir = `${tempDir}/swamp`;
    await Deno.mkdir(configDir, { recursive: true });
    const authData: Record<string, string> = {
      serverUrl: "https://fake.swamp.club",
      apiKey: opts.authApiKey ?? "swamp_fake_key",
      apiKeyId: "fake-key-id",
    };
    if (opts.authUsername) {
      authData.username = opts.authUsername;
    }
    await Deno.writeTextFile(
      `${configDir}/auth.json`,
      JSON.stringify(authData),
    );
  }

  // Set env so createSwampClubClient uses auth.json (not SWAMP_API_KEY)
  Deno.env.delete("SWAMP_API_KEY");
  Deno.env.delete("SWAMP_CLUB_URL");
  Deno.env.set("HOME", tempDir);
  Deno.env.set("XDG_CONFIG_HOME", tempDir);

  // Install fetch stub
  globalThis.fetch = ((
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const method = init?.method ?? "GET";

    // Capture PATCH bodies for assertion
    if (method === "PATCH" && init?.body) {
      patchBodies.push(JSON.parse(init.body as string));
    }

    for (const route of opts.routes) {
      if (
        url.includes(route.urlIncludes) &&
        (route.method === undefined || route.method === method)
      ) {
        return Promise.resolve(
          new Response(JSON.stringify(route.response.body), {
            status: route.response.status,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
    }
    // Default: 404
    return Promise.resolve(new Response("Not Found", { status: 404 }));
  }) as typeof fetch;

  const restore = async () => {
    globalThis.fetch = originalFetch;
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) {
        Deno.env.delete(k);
      } else {
        Deno.env.set(k, v);
      }
    }
    await Deno.remove(tempDir, { recursive: true });
  };

  const context = {
    globalArgs: { issueNumber },
    logger: {
      info: () => {},
      warning: (msg: string, _props: Record<string, unknown>) => {
        warnings.push(msg);
      },
    },
    writeResource: (
      specName: string,
      instanceName: string,
      data: Record<string, unknown>,
    ) => {
      writes.push({ specName, instanceName, data });
      return Promise.resolve({ name: instanceName });
    },
  };

  return { context, writes, warnings, patchBodies, restore };
}

/** Standard routes for a successful start() + assignment flow. */
function happyRoutes(opts: {
  issueNumber: number;
  issueAssignees?: { userId: string; username: string }[];
  eligibleAssignees: { userId: string; username: string }[];
}): FetchStubRoute[] {
  return [
    {
      urlIncludes: "/api/health",
      response: { status: 200, body: { ok: true } },
    },
    {
      urlIncludes: `/api/v1/lab/issues/${opts.issueNumber}`,
      method: "GET",
      response: {
        status: 200,
        body: {
          issue: {
            number: opts.issueNumber,
            type: "feature",
            status: "open",
            title: "Test issue",
            body: "Test body",
            comments: [],
            assignees: opts.issueAssignees ?? [],
          },
        },
      },
    },
    {
      urlIncludes: `/api/v1/lab/issues/${opts.issueNumber}`,
      method: "PATCH",
      response: { status: 200, body: { issue: {} } },
    },
    {
      urlIncludes: "/api/v1/lab/assignees",
      method: "GET",
      response: {
        status: 200,
        body: { assignees: opts.eligibleAssignees },
      },
    },
    {
      urlIncludes: `/api/v1/lab/issues/${opts.issueNumber}/lifecycle`,
      method: "POST",
      response: { status: 200, body: {} },
    },
  ];
}

Deno.test("start: auto-assigns the current user on happy path", async () => {
  const { context, writes, patchBodies, restore } = await buildStartTestContext(
    99,
    {
      authUsername: "alice",
      routes: happyRoutes({
        issueNumber: 99,
        eligibleAssignees: [
          { userId: "user-alice-id", username: "alice" },
          { userId: "user-bob-id", username: "bob" },
        ],
      }),
    },
  );
  try {
    await model.methods.start.execute({}, context);

    // Core start behavior: writes context + state
    const contextWrite = writes.find((w) => w.specName === "context");
    assertEquals(contextWrite !== undefined, true);
    const stateWrite = writes.find((w) => w.specName === "state");
    assertEquals(stateWrite !== undefined, true);
    assertEquals(stateWrite!.data.phase, "triaging");

    // Assignment: PATCH with alice's userId
    assertEquals(patchBodies.length >= 1, true);
    const assignPatch = patchBodies.find(
      (b: unknown) => typeof b === "object" && b !== null && "assignees" in b,
    ) as { assignees: string[] } | undefined;
    assertEquals(assignPatch !== undefined, true);
    assertEquals(assignPatch!.assignees, ["user-alice-id"]);
  } finally {
    await restore();
  }
});

Deno.test("start: preserves pre-existing assignees (additive merge)", async () => {
  const { context, patchBodies, restore } = await buildStartTestContext(99, {
    authUsername: "charlie",
    routes: happyRoutes({
      issueNumber: 99,
      issueAssignees: [
        { userId: "user-alice-id", username: "alice" },
        { userId: "user-bob-id", username: "bob" },
      ],
      eligibleAssignees: [
        { userId: "user-alice-id", username: "alice" },
        { userId: "user-bob-id", username: "bob" },
        { userId: "user-charlie-id", username: "charlie" },
      ],
    }),
  });
  try {
    await model.methods.start.execute({}, context);

    const assignPatch = patchBodies.find(
      (b: unknown) => typeof b === "object" && b !== null && "assignees" in b,
    ) as { assignees: string[] } | undefined;
    assertEquals(assignPatch !== undefined, true);
    assertEquals(assignPatch!.assignees, [
      "user-alice-id",
      "user-bob-id",
      "user-charlie-id",
    ]);
  } finally {
    await restore();
  }
});

Deno.test("start: skips PATCH when already assigned (idempotent)", async () => {
  const { context, patchBodies, restore } = await buildStartTestContext(99, {
    authUsername: "alice",
    routes: happyRoutes({
      issueNumber: 99,
      issueAssignees: [{ userId: "user-alice-id", username: "alice" }],
      eligibleAssignees: [{ userId: "user-alice-id", username: "alice" }],
    }),
  });
  try {
    await model.methods.start.execute({}, context);

    // No assignees PATCH should have been made
    const assignPatch = patchBodies.find(
      (b: unknown) => typeof b === "object" && b !== null && "assignees" in b,
    );
    assertEquals(assignPatch, undefined);
  } finally {
    await restore();
  }
});

Deno.test("start: warns and skips assignment when no username in auth", async () => {
  // Provide an auth.json with apiKey but no username — simulates older auth
  // files or env-var-only auth where username was never stored.
  const routes = happyRoutes({
    issueNumber: 99,
    eligibleAssignees: [],
  });
  const { context, writes, warnings, patchBodies, restore } =
    await buildStartTestContext(99, {
      // authUsername is deliberately omitted — no username in auth.json
      authApiKey: "swamp_fake_no_username",
      routes,
    });
  try {
    // start() should still succeed (not throw)
    await model.methods.start.execute({}, context);

    // Core behavior still works
    const stateWrite = writes.find((w) => w.specName === "state");
    assertEquals(stateWrite !== undefined, true);
    assertEquals(stateWrite!.data.phase, "triaging");

    // No assignees PATCH
    const assignPatch = patchBodies.find(
      (b: unknown) => typeof b === "object" && b !== null && "assignees" in b,
    );
    assertEquals(assignPatch, undefined);

    // Warning was logged
    assertEquals(warnings.length >= 1, true);
  } finally {
    await restore();
  }
});

Deno.test("start: warns and skips assignment when assignees endpoint returns 403", async () => {
  const routes = happyRoutes({
    issueNumber: 99,
    eligibleAssignees: [],
  });
  // Override the assignees route to return 403
  const assigneesIdx = routes.findIndex((r) =>
    r.urlIncludes.includes("assignees")
  );
  routes[assigneesIdx] = {
    urlIncludes: "/api/v1/lab/assignees",
    method: "GET",
    response: { status: 403, body: { error: "Forbidden" } },
  };

  const { context, writes, patchBodies, restore } = await buildStartTestContext(
    99,
    {
      authUsername: "alice",
      routes,
    },
  );
  try {
    await model.methods.start.execute({}, context);

    // Core behavior still works
    const stateWrite = writes.find((w) => w.specName === "state");
    assertEquals(stateWrite !== undefined, true);

    // No assignees PATCH
    const assignPatch = patchBodies.find(
      (b: unknown) => typeof b === "object" && b !== null && "assignees" in b,
    );
    assertEquals(assignPatch, undefined);
  } finally {
    await restore();
  }
});

Deno.test("start: succeeds even when PATCH fails", async () => {
  const routes = happyRoutes({
    issueNumber: 99,
    eligibleAssignees: [{ userId: "user-alice-id", username: "alice" }],
  });
  // Override the PATCH route to return 500
  const patchIdx = routes.findIndex(
    (r) =>
      r.urlIncludes.includes("/api/v1/lab/issues/99") && r.method === "PATCH",
  );
  routes[patchIdx] = {
    urlIncludes: "/api/v1/lab/issues/99",
    method: "PATCH",
    response: { status: 500, body: { error: "Internal Server Error" } },
  };

  const { context, writes, restore } = await buildStartTestContext(99, {
    authUsername: "alice",
    routes,
  });
  try {
    // start() should still succeed — assignment is best-effort
    await model.methods.start.execute({}, context);

    // Core behavior still works
    const stateWrite = writes.find((w) => w.specName === "state");
    assertEquals(stateWrite !== undefined, true);
    assertEquals(stateWrite!.data.phase, "triaging");
  } finally {
    await restore();
  }
});
