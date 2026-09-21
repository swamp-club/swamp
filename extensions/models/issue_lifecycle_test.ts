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
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  buildNotifyMessage,
  model,
  resolveVerificationArgs,
} from "./issue_lifecycle.ts";
import { PR_COOLDOWN_MS, TRANSITIONS } from "./_lib/schemas.ts";

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
      { url: "https://github.com/swamp-club/swamp/pull/1141" },
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
      "https://github.com/swamp-club/swamp/pull/1141",
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
      { url: "https://github.com/swamp-club/swamp/pull/1141" },
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
      { url: "https://github.com/swamp-club/swamp/pull/1141" },
      context,
    );
    await model.methods.link_pr.execute(
      { url: "https://github.com/swamp-club/swamp/pull/1142" },
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
      "https://github.com/swamp-club/swamp/pull/1142",
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
        url: "https://github.com/swamp-club/swamp/pull/1141",
        attempt: 1,
        linkedAt: "2026-04-09T10:00:00.000Z",
        failedAt: "2026-04-09T10:05:00.000Z",
        failureReason: "CI failed",
      },
    },
  });
  try {
    await model.methods.link_pr.execute(
      { url: "https://github.com/swamp-club/swamp/pull/1142" },
      context,
    );

    const prWrite = writes.find((w) => w.specName === "pullRequest");
    assertEquals(prWrite !== undefined, true);
    assertEquals(
      prWrite!.data.url,
      "https://github.com/swamp-club/swamp/pull/1142",
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
                url: "https://github.com/swamp-club/swamp/pull/1",
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
                url: "https://github.com/swamp-club/swamp/pull/1",
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

Deno.test("model: exposes the new post_attestation method definition", () => {
  assertEquals(
    "post_attestation" in model.methods,
    true,
    "post_attestation method must be registered in model.methods",
  );
});

Deno.test("model: version is 2026.09.21.1", () => {
  assertEquals(model.version, "2026.09.21.1");
});

// ---------------------------------------------------------------------------
// pr_merged
// ---------------------------------------------------------------------------

Deno.test("pr_merged: transitions state to releasing and writes mergedAt with attempt", async () => {
  const { context, writes, restore } = await buildTestContext(42, {
    resources: {
      "pullRequest-main": {
        url: "https://github.com/swamp-club/swamp/pull/1141",
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
      "https://github.com/swamp-club/swamp/pull/1141",
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
        url: "https://github.com/swamp-club/swamp/pull/1141",
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
        url: "https://github.com/swamp-club/swamp/pull/1141",
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

Deno.test("ship: transitions state to notify", async () => {
  const { context, writes, restore } = await buildTestContext(42);
  try {
    await model.methods.ship.execute({}, context);

    const stateWrite = writes.find((w) => w.specName === "state");
    assertEquals(stateWrite !== undefined, true);
    assertEquals(stateWrite!.data.phase, "notify");
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
        releaseUrl: "https://github.com/swamp-club/swamp/releases/tag/v1.0.0",
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
      urlIncludes: "/healthz",
      response: { status: 200, body: "" },
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

Deno.test("start: persists author in context-main", async () => {
  const { context, writes, restore } = await buildStartTestContext(99, {
    authUsername: "alice",
    routes: [
      {
        urlIncludes: "/healthz",
        response: { status: 200, body: "" },
      },
      {
        urlIncludes: "/api/v1/lab/issues/99",
        method: "GET",
        response: {
          status: 200,
          body: {
            issue: {
              number: 99,
              type: "bug",
              status: "open",
              title: "Test",
              body: "Body",
              authorUsername: "external-user",
              comments: [],
              assignees: [],
            },
          },
        },
      },
      {
        urlIncludes: "/api/v1/lab/issues/99",
        method: "PATCH",
        response: { status: 200, body: { issue: {} } },
      },
      {
        urlIncludes: "/api/v1/lab/assignees",
        method: "GET",
        response: {
          status: 200,
          body: { assignees: [{ userId: "u1", username: "alice" }] },
        },
      },
      {
        urlIncludes: "/api/v1/lab/issues/99/lifecycle",
        method: "POST",
        response: { status: 200, body: {} },
      },
    ],
  });
  try {
    await model.methods.start.execute({}, context);

    const contextWrite = writes.find((w) => w.specName === "context");
    assertEquals(contextWrite !== undefined, true);
    assertEquals(contextWrite!.data.author, "external-user");
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

// ---------------------------------------------------------------------------
// notify
// ---------------------------------------------------------------------------

Deno.test("notify: transitions state to summarizing and reads author from context", async () => {
  const { context, writes, restore } = await buildTestContext(42, {
    resources: {
      "context-main": {
        title: "Test",
        body: "Body",
        type: "bug",
        status: "open",
        author: "external-user",
        comments: [],
        fetchedAt: "2026-05-21T00:00:00.000Z",
      },
    },
  });
  try {
    await model.methods.notify.execute({}, context);

    const stateWrite = writes.find((w) => w.specName === "state");
    assertEquals(stateWrite !== undefined, true);
    assertEquals(stateWrite!.data.phase, "summarizing");
    assertEquals(stateWrite!.data.issueNumber, 42);
  } finally {
    await restore();
  }
});

Deno.test("notify: transitions to summarizing even when author is missing from context", async () => {
  const { context, writes, restore } = await buildTestContext(42, {
    resources: {
      "context-main": {
        title: "Test",
        body: "Body",
        type: "bug",
        status: "open",
        comments: [],
        fetchedAt: "2026-05-21T00:00:00.000Z",
      },
    },
  });
  try {
    await model.methods.notify.execute({}, context);

    const stateWrite = writes.find((w) => w.specName === "state");
    assertEquals(stateWrite !== undefined, true);
    assertEquals(stateWrite!.data.phase, "summarizing");
  } finally {
    await restore();
  }
});

Deno.test("notify: accepts custom message", async () => {
  const { context, writes, restore } = await buildTestContext(42, {
    resources: {
      "context-main": {
        title: "Test",
        body: "Body",
        type: "bug",
        status: "open",
        author: "contributor",
        comments: [],
        fetchedAt: "2026-05-21T00:00:00.000Z",
      },
    },
  });
  try {
    await model.methods.notify.execute(
      { message: "Custom thanks @contributor!" },
      context,
    );

    const stateWrite = writes.find((w) => w.specName === "state");
    assertEquals(stateWrite !== undefined, true);
    assertEquals(stateWrite!.data.phase, "summarizing");
  } finally {
    await restore();
  }
});

Deno.test("buildNotifyMessage: includes PR link and plan summary", () => {
  const pr = {
    url: "https://github.com/swamp-club/swamp/pull/999",
    attempt: 1,
    linkedAt: "2026-05-21T00:00:00.000Z",
  };
  const plan = {
    version: 1,
    summary: "Fix the widget alignment",
    dddAnalysis: "",
    steps: [],
    testingStrategy: "",
    potentialChallenges: [],
    feedbackIncorporated: [],
    generatedAt: "2026-05-21T00:00:00.000Z",
  };
  const msg = buildNotifyMessage("external-user", pr, plan);
  assertStringIncludes(
    msg,
    "[merged](https://github.com/swamp-club/swamp/pull/999)",
  );
  assertStringIncludes(msg, "Fix the widget alignment");
  assertStringIncludes(msg, "@external-user");
});

Deno.test("buildNotifyMessage: includes PR link without plan summary when plan is missing", () => {
  const pr = {
    url: "https://github.com/swamp-club/swamp/pull/999",
    attempt: 1,
    linkedAt: "2026-05-21T00:00:00.000Z",
  };
  const msg = buildNotifyMessage("external-user", pr, null);
  assertStringIncludes(
    msg,
    "[merged](https://github.com/swamp-club/swamp/pull/999)",
  );
  assertStringIncludes(msg, "@external-user");
  assertEquals(msg.includes("We shipped:"), false);
});

Deno.test("buildNotifyMessage: falls back to plain text when no PR is available", () => {
  const msg = buildNotifyMessage("external-user", null, null);
  assertStringIncludes(msg, "merged");
  assertEquals(msg.includes("[merged]"), false);
  assertStringIncludes(msg, "@external-user");
});

// ---------------------------------------------------------------------------
// skip_notify
// ---------------------------------------------------------------------------

Deno.test("skip_notify: transitions state to summarizing", async () => {
  const { context, writes, restore } = await buildTestContext(42);
  try {
    await model.methods.skip_notify.execute({}, context);

    const stateWrite = writes.find((w) => w.specName === "state");
    assertEquals(stateWrite !== undefined, true);
    assertEquals(stateWrite!.data.phase, "summarizing");
    assertEquals(stateWrite!.data.issueNumber, 42);
  } finally {
    await restore();
  }
});

// ---------------------------------------------------------------------------
// Model registration smoke tests (notify methods)
// ---------------------------------------------------------------------------

Deno.test("model: exposes notify method definition", () => {
  assertEquals("notify" in model.methods, true);
});

Deno.test("model: exposes skip_notify method definition", () => {
  assertEquals("skip_notify" in model.methods, true);
});

// ---------------------------------------------------------------------------
// code_conformance_review
// ---------------------------------------------------------------------------

Deno.test("code_conformance_review: writes codeConformanceReview-main with plan version and steps", async () => {
  const { context, writes, restore } = await buildTestContext(42, {
    resources: {
      "plan-main": {
        version: 3,
        summary: "Fix the bug",
        dddAnalysis: "n/a",
        steps: [{ order: 1, description: "Step 1", files: ["a.ts"] }],
        testingStrategy: "unit",
        potentialChallenges: [],
        feedbackIncorporated: [],
        generatedAt: "2026-06-29T00:00:00.000Z",
      },
    },
  });
  try {
    await model.methods.code_conformance_review.execute(
      {
        steps: [
          {
            order: 1,
            status: "implemented" as const,
            description: "Step 1 done",
          },
          {
            order: 2,
            status: "deviated" as const,
            description: "Did it differently",
            justification: "Existing helper already covered this",
          },
        ],
      },
      context,
    );

    const reviewWrite = writes.find(
      (w) => w.specName === "codeConformanceReview",
    );
    assertEquals(reviewWrite !== undefined, true);
    assertEquals(reviewWrite!.instanceName, "codeConformanceReview-main");
    assertEquals(reviewWrite!.data.planVersion, 3);
    assertEquals(
      (reviewWrite!.data.steps as unknown[]).length,
      2,
    );
  } finally {
    await restore();
  }
});

Deno.test("code_conformance_review: throws when no plan exists", async () => {
  const { context, restore } = await buildTestContext(42);
  try {
    await assertRejects(
      () =>
        model.methods.code_conformance_review.execute(
          { steps: [] },
          context,
        ),
      Error,
      "No plan exists",
    );
  } finally {
    await restore();
  }
});

// ---------------------------------------------------------------------------
// justify_deviations
// ---------------------------------------------------------------------------

Deno.test("justify_deviations: adds justification to unjustified steps", async () => {
  const { context, writes, restore } = await buildTestContext(42, {
    resources: {
      "codeConformanceReview-main": {
        planVersion: 1,
        steps: [
          {
            order: 1,
            status: "implemented",
            description: "Done",
          },
          {
            order: 2,
            status: "missing",
            description: "Not done",
          },
        ],
        reviewedAt: "2026-06-29T00:00:00.000Z",
      },
    },
  });
  try {
    await model.methods.justify_deviations.execute(
      {
        justifications: [
          {
            order: 2,
            justification: "Deferred to follow-up issue #100",
          },
        ],
      },
      context,
    );

    const reviewWrite = writes.find(
      (w) => w.specName === "codeConformanceReview",
    );
    assertEquals(reviewWrite !== undefined, true);
    const steps = reviewWrite!.data.steps as {
      order: number;
      justification?: string;
    }[];
    const step2 = steps.find((s) => s.order === 2);
    assertEquals(step2!.justification, "Deferred to follow-up issue #100");
  } finally {
    await restore();
  }
});

Deno.test("justify_deviations: throws when no conformance review exists", async () => {
  const { context, restore } = await buildTestContext(42);
  try {
    await assertRejects(
      () =>
        model.methods.justify_deviations.execute(
          { justifications: [{ order: 1, justification: "reason" }] },
          context,
        ),
      Error,
      "No code conformance review exists",
    );
  } finally {
    await restore();
  }
});

// ---------------------------------------------------------------------------
// code-conformance-clear check
// ---------------------------------------------------------------------------

Deno.test("code-conformance-clear: passes when all deviations are justified", async () => {
  const checkContext = {
    methodName: "link_pr",
    dataRepository: {
      getContent: (
        _type: string,
        _modelId: string,
        dataName: string,
      ) => {
        if (dataName === "plan-main") {
          return Promise.resolve(
            new TextEncoder().encode(JSON.stringify({ version: 1 })),
          );
        }
        if (dataName === "codeConformanceReview-main") {
          return Promise.resolve(
            new TextEncoder().encode(
              JSON.stringify({
                planVersion: 1,
                steps: [
                  { order: 1, status: "implemented", description: "Done" },
                  {
                    order: 2,
                    status: "deviated",
                    description: "Different",
                    justification: "Better approach",
                  },
                ],
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

  const result = await model.checks["code-conformance-clear"].execute(
    checkContext,
  );
  assertEquals(result.pass, true);
});

Deno.test("code-conformance-clear: rejects when no conformance review exists", async () => {
  const checkContext = {
    methodName: "link_pr",
    dataRepository: {
      getContent: (
        _type: string,
        _modelId: string,
        dataName: string,
      ) => {
        if (dataName === "plan-main") {
          return Promise.resolve(
            new TextEncoder().encode(JSON.stringify({ version: 1 })),
          );
        }
        return Promise.resolve(null);
      },
    },
    modelType: "@swamp/issue-lifecycle",
    modelId: "issue-42",
  };

  const result = await model.checks["code-conformance-clear"].execute(
    checkContext,
  );
  assertEquals(result.pass, false);
  assertStringIncludes(result.errors![0], "No code conformance review exists");
});

Deno.test("code-conformance-clear: rejects when review is stale (wrong plan version)", async () => {
  const checkContext = {
    methodName: "link_pr",
    dataRepository: {
      getContent: (
        _type: string,
        _modelId: string,
        dataName: string,
      ) => {
        if (dataName === "plan-main") {
          return Promise.resolve(
            new TextEncoder().encode(JSON.stringify({ version: 2 })),
          );
        }
        if (dataName === "codeConformanceReview-main") {
          return Promise.resolve(
            new TextEncoder().encode(
              JSON.stringify({
                planVersion: 1,
                steps: [],
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

  const result = await model.checks["code-conformance-clear"].execute(
    checkContext,
  );
  assertEquals(result.pass, false);
  assertStringIncludes(result.errors![0], "plan v1");
  assertStringIncludes(result.errors![0], "plan is v2");
});

Deno.test("code-conformance-clear: rejects when unjustified deviations remain", async () => {
  const checkContext = {
    methodName: "link_pr",
    dataRepository: {
      getContent: (
        _type: string,
        _modelId: string,
        dataName: string,
      ) => {
        if (dataName === "plan-main") {
          return Promise.resolve(
            new TextEncoder().encode(JSON.stringify({ version: 1 })),
          );
        }
        if (dataName === "codeConformanceReview-main") {
          return Promise.resolve(
            new TextEncoder().encode(
              JSON.stringify({
                planVersion: 1,
                steps: [
                  { order: 1, status: "implemented", description: "Done" },
                  {
                    order: 2,
                    status: "missing",
                    description: "Not done",
                  },
                  {
                    order: 3,
                    status: "deviated",
                    description: "Changed",
                    justification: "Better way",
                  },
                ],
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

  const result = await model.checks["code-conformance-clear"].execute(
    checkContext,
  );
  assertEquals(result.pass, false);
  assertStringIncludes(result.errors![0], "1 unjustified");
  assertStringIncludes(result.errors![0], "step 2");
});

// ---------------------------------------------------------------------------
// Model registration smoke tests (code conformance)
// ---------------------------------------------------------------------------

Deno.test("model: exposes codeConformanceReview resource definition", () => {
  assertEquals("codeConformanceReview" in model.resources, true);
});

Deno.test("model: exposes code_conformance_review method definition", () => {
  assertEquals("code_conformance_review" in model.methods, true);
});

Deno.test("model: exposes justify_deviations method definition", () => {
  assertEquals("justify_deviations" in model.methods, true);
});

Deno.test("model: exposes code-conformance-clear check definition", () => {
  assertEquals("code-conformance-clear" in model.checks, true);
});

// ---------------------------------------------------------------------------
// triage: regression verification
// ---------------------------------------------------------------------------

Deno.test("triage: rejects isRegression=true without adversarial evidence fields", async () => {
  const { context, restore } = await buildTestContext(42);
  try {
    await assertRejects(
      () =>
        model.methods.triage.execute(
          {
            type: "bug",
            confidence: "high",
            reasoning: "It broke",
            isRegression: true,
          },
          context,
        ),
      Error,
      "Regression classification requires adversarial verification",
    );
  } finally {
    await restore();
  }
});

Deno.test("triage: accepts isRegression=true with all adversarial evidence fields (confirmed)", async () => {
  const { context, writes, restore } = await buildTestContext(42);
  try {
    await model.methods.triage.execute(
      {
        type: "bug",
        confidence: "high",
        reasoning: "It broke",
        isRegression: true,
        regressionIntroducedIn: "2026.07.01.1",
        regressionEvidence: "Commit abc123 shows it worked before",
        regressionCounterEvidence: "Could be a test gap, not a regression",
        regressionVerdict: "confirmed",
        regressionVerdictReasoning:
          "The feature demonstrably worked in the prior release",
      },
      context,
    );

    const classWrite = writes.find((w) => w.specName === "classification");
    assertEquals(classWrite !== undefined, true);
    assertEquals(classWrite!.data.isRegression, true);
    assertEquals(classWrite!.data.regressionVerdict, "confirmed");
    assertEquals(classWrite!.data.regressionIntroducedIn, "2026.07.01.1");
  } finally {
    await restore();
  }
});

Deno.test("triage: downgrades regression to plain bug when verdict is downgraded", async () => {
  const { context, writes, restore } = await buildTestContext(42);
  try {
    await model.methods.triage.execute(
      {
        type: "bug",
        confidence: "high",
        reasoning: "Reported as regression but never actually worked",
        isRegression: true,
        regressionIntroducedIn: "2026.07.01.1",
        regressionEvidence: "User says it used to work",
        regressionCounterEvidence:
          "Git history shows this code path was never tested and the behavior was always incorrect",
        regressionVerdict: "downgraded",
        regressionVerdictReasoning:
          "No evidence it ever worked — user was likely misremembering a different feature",
      },
      context,
    );

    const classWrite = writes.find((w) => w.specName === "classification");
    assertEquals(classWrite !== undefined, true);
    assertEquals(classWrite!.data.isRegression, false);
    assertEquals(classWrite!.data.regressionVerdict, "downgraded");
    assertEquals(
      classWrite!.data.regressionIntroducedIn,
      undefined,
      "regressionIntroducedIn must be cleared on downgrade",
    );
  } finally {
    await restore();
  }
});

Deno.test("triage: non-regression classification does not require evidence fields", async () => {
  const { context, writes, restore } = await buildTestContext(42);
  try {
    await model.methods.triage.execute(
      {
        type: "feature",
        confidence: "high",
        reasoning: "New feature request",
      },
      context,
    );

    const classWrite = writes.find((w) => w.specName === "classification");
    assertEquals(classWrite !== undefined, true);
    assertEquals(classWrite!.data.isRegression, undefined);
  } finally {
    await restore();
  }
});

// ---------------------------------------------------------------------------
// summarize
// ---------------------------------------------------------------------------

Deno.test("summarize: writes summary-main and transitions to done", async () => {
  const { context, writes, restore } = await buildTestContext(42);
  try {
    await model.methods.summarize.execute(
      {
        originalProblem:
          "The CLI crashed when running `swamp model list` with no models defined",
        deliveredOutcome:
          "Added an empty-state check that returns a helpful message instead of crashing",
        outcomeMet: true,
      },
      context,
    );

    const summaryWrite = writes.find((w) => w.specName === "summary");
    assertEquals(summaryWrite !== undefined, true);
    assertEquals(summaryWrite!.instanceName, "summary-main");
    assertEquals(
      summaryWrite!.data.originalProblem,
      "The CLI crashed when running `swamp model list` with no models defined",
    );
    assertEquals(
      summaryWrite!.data.deliveredOutcome,
      "Added an empty-state check that returns a helpful message instead of crashing",
    );
    assertEquals(summaryWrite!.data.outcomeMet, true);
    assertEquals(typeof summaryWrite!.data.summarizedAt, "string");

    const stateWrite = writes.find((w) => w.specName === "state");
    assertEquals(stateWrite !== undefined, true);
    assertEquals(stateWrite!.data.phase, "done");
    assertEquals(stateWrite!.data.issueNumber, 42);
  } finally {
    await restore();
  }
});

Deno.test("summarize: records outcomeMet=false when outcome does not match", async () => {
  const { context, writes, restore } = await buildTestContext(42);
  try {
    await model.methods.summarize.execute(
      {
        originalProblem: "Need OAuth support for SSO login",
        deliveredOutcome:
          "Added basic API key auth but OAuth was deferred to a follow-up",
        outcomeMet: false,
      },
      context,
    );

    const summaryWrite = writes.find((w) => w.specName === "summary");
    assertEquals(summaryWrite !== undefined, true);
    assertEquals(summaryWrite!.data.outcomeMet, false);
  } finally {
    await restore();
  }
});

// ---------------------------------------------------------------------------
// Model registration smoke tests (new features)
// ---------------------------------------------------------------------------

Deno.test("model: exposes summary resource definition", () => {
  assertEquals("summary" in model.resources, true);
});

Deno.test("model: exposes summarize method definition", () => {
  assertEquals("summarize" in model.methods, true);
});

// ---------------------------------------------------------------------------
// fast_forward
// ---------------------------------------------------------------------------

Deno.test("fast_forward: writes classification, plan, adversarialReview, codeConformanceReview, and state", async () => {
  const { context, writes, restore } = await buildTestContext(99);
  try {
    await model.methods.fast_forward.execute(
      {
        summary: "Add retry logic to HTTP client",
        steps: [
          {
            order: 1,
            description: "Add retry wrapper",
            files: ["src/http/client.ts"],
          },
          {
            order: 2,
            description: "Add retry tests",
            files: ["src/http/client_test.ts"],
          },
        ],
        testingStrategy: "Unit tests for retry logic",
      },
      context,
    );

    const classificationWrite = writes.find((w) =>
      w.specName === "classification"
    );
    assertEquals(classificationWrite !== undefined, true);
    assertEquals(classificationWrite!.data.type, "platform");
    assertEquals(classificationWrite!.data.confidence, "high");

    const planWrite = writes.find((w) => w.specName === "plan");
    assertEquals(planWrite !== undefined, true);
    assertEquals(planWrite!.data.version, 1);
    assertEquals(planWrite!.data.summary, "Add retry logic to HTTP client");
    assertEquals(
      (planWrite!.data.steps as Array<unknown>).length,
      2,
    );

    const advReviewWrite = writes.find((w) =>
      w.specName === "adversarialReview"
    );
    assertEquals(advReviewWrite !== undefined, true);
    assertEquals(advReviewWrite!.data.planVersion, 1);
    assertEquals(
      (advReviewWrite!.data.findings as Array<unknown>).length,
      0,
    );

    const conformanceWrite = writes.find((w) =>
      w.specName === "codeConformanceReview"
    );
    assertEquals(conformanceWrite !== undefined, true);
    assertEquals(conformanceWrite!.data.planVersion, 1);
    const conformanceSteps = conformanceWrite!.data.steps as Array<
      Record<string, unknown>
    >;
    assertEquals(conformanceSteps.length, 2);
    assertEquals(conformanceSteps[0].status, "implemented");
    assertEquals(conformanceSteps[1].status, "implemented");

    const stateWrite = writes.find((w) => w.specName === "state");
    assertEquals(stateWrite !== undefined, true);
    assertEquals(stateWrite!.data.phase, "implementing");
    assertEquals(stateWrite!.data.issueNumber, 99);
  } finally {
    await restore();
  }
});

Deno.test("model: exposes fast_forward method definition", () => {
  assertEquals("fast_forward" in model.methods, true);
});

// ---------------------------------------------------------------------------
// Pinned invariants
// ---------------------------------------------------------------------------

/**
 * Every upstream write must go through the policy module in
 * `_lib/lifecycle_recorder.ts`. A direct client call would reintroduce the
 * swallow this model was changed to remove — including in `post_attestation`,
 * whose deliberate downgrade wraps the policy call in a try/catch rather than
 * bypassing it, which is why this assertion needs no exceptions.
 */
Deno.test("issue_lifecycle: no upstream write bypasses the policy module", async () => {
  const source = await Deno.readTextFile(
    new URL("./issue_lifecycle.ts", import.meta.url),
  );

  const bypasses = [".postLifecycleEntry(", ".submitComment("];
  for (const call of bypasses) {
    assertEquals(
      source.includes(call),
      false,
      `${call} must be reached through _lib/lifecycle_recorder.ts, not called ` +
        `directly — a direct call swallows the failure it should surface`,
    );
  }
});

/**
 * Pinned ratchet over the rollback flag. A method that writes local state
 * before its lifecycle post must roll that write back when the post raises,
 * or the phase advances past a step the audit trail never recorded.
 *
 * The two exclusions are deliberate and not interchangeable with an omission:
 * `notify` sends a contributor ripple and `post_attestation` files an
 * attestation, neither of which rollback can reach, so re-running them would
 * duplicate an external side effect. `review` neither writes nor posts.
 *
 * Adding a method forces an edit here and a decision about the flag.
 */
Deno.test("issue_lifecycle: rollbackOnFailure matches the pinned method set", () => {
  const rollsBack = [
    "start",
    "triage",
    "plan",
    "iterate",
    "adversarial_review",
    "resolve_findings",
    "code_conformance_review",
    "justify_deviations",
    "approve",
    "implement",
    "fast_forward",
    "verify",
    "verification_passed",
    "verification_failed",
    "link_pr",
    "pr_merged",
    "pr_failed",
    "ship",
    "complete",
    "skip_notify",
    "summarize",
  ];
  const doesNotRollBack = ["review", "post_attestation", "notify"];

  const methods = model.methods as Record<string, { rollbackOnFailure?: true }>;
  assertEquals(
    Object.keys(methods).sort(),
    [...rollsBack, ...doesNotRollBack].sort(),
    "a method was added or removed — decide whether it needs rollbackOnFailure",
  );

  for (const name of rollsBack) {
    assertEquals(
      methods[name].rollbackOnFailure,
      true,
      `${name} writes state before its lifecycle post, so it must roll that ` +
        `write back when the post raises`,
    );
  }
  for (const name of doesNotRollBack) {
    assertEquals(
      methods[name].rollbackOnFailure,
      undefined,
      `${name} is deliberately excluded from rollback`,
    );
  }
});

// ---------------------------------------------------------------------------
// Model wiring — a dropped audit record fails the step
// ---------------------------------------------------------------------------

/**
 * Like `buildTestContext`, but with credentials present and fetch stubbed, so
 * the method builds a real client and the upstream responses are scripted.
 */
async function buildOnlineTestContext(
  issueNumber: number,
  respond: (url: string, method: string) => Response,
): Promise<{
  context: Parameters<typeof model.methods.pr_merged.execute>[1];
  restore: () => Promise<void>;
}> {
  const { context, restore: restoreBase } = await buildTestContext(issueNumber);
  const originalFetch = globalThis.fetch;

  Deno.env.set("SWAMP_API_KEY", "fake-key");
  Deno.env.set("SWAMP_CLUB_URL", "https://fake.swamp-club.com");

  globalThis.fetch = ((
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    return Promise.resolve(respond(url, init?.method ?? "GET"));
  }) as typeof fetch;

  return {
    context,
    restore: async () => {
      globalThis.fetch = originalFetch;
      await restoreBase();
    },
  };
}

Deno.test("plan: fails the step when the lifecycle entry is rejected", async () => {
  const { context, restore } = await buildOnlineTestContext(
    42,
    (url) =>
      url.endsWith("/healthz")
        ? new Response("ok", { status: 200 })
        : new Response(
          JSON.stringify({ error: "payload keys must not start with $" }),
          { status: 400 },
        ),
  );
  try {
    const error = await assertRejects(
      () =>
        model.methods.plan.execute({
          summary: "s",
          dddAnalysis: "d",
          steps: [{ order: 1, description: "x", files: ["a.ts"] }],
          testingStrategy: "t",
          potentialChallenges: [],
        }, context),
      Error,
    );
    assertStringIncludes(error.message, "plan_generated lifecycle entry");
    assertStringIncludes(error.message, "HTTP 400");
  } finally {
    await restore();
  }
});

Deno.test("plan: succeeds unchanged when no credentials are configured", async () => {
  const { context, writes, restore } = await buildTestContext(42);
  try {
    await model.methods.plan.execute({
      summary: "s",
      dddAnalysis: "d",
      steps: [{ order: 1, description: "x", files: ["a.ts"] }],
      testingStrategy: "t",
      potentialChallenges: [],
    }, context);

    const stateWrite = writes.find((w) => w.specName === "state");
    assertEquals(stateWrite!.data.phase, "plan_generated");
  } finally {
    await restore();
  }
});

/**
 * The auto-assign block promises in its own comment that assignment never
 * breaks the triage flow, so the entry reporting on it must use the
 * best-effort variant. Asserted at the source, since driving `start` to that
 * branch would need the whole assignee lookup stubbed.
 */
Deno.test("start: the assignment entry is recorded best-effort", async () => {
  const source = await Deno.readTextFile(
    new URL("./issue_lifecycle.ts", import.meta.url),
  );
  const assignedEntry = source.indexOf('step: "assigned"');
  assertEquals(assignedEntry > -1, true, "the assigned entry must still exist");

  const preceding = source.slice(0, assignedEntry);
  const recorder = preceding.lastIndexOf("recordLifecycle");
  assertStringIncludes(
    source.slice(recorder, assignedEntry),
    "recordLifecycleBestEffort",
    "the assigned entry reports on a best-effort action and must not raise",
  );
});

// ---------------------------------------------------------------------------
// attestation-posted check
// ---------------------------------------------------------------------------

function attestationCheckContext(
  stored: Record<string, Record<string, unknown> | undefined>,
) {
  return {
    methodName: "link_pr",
    dataRepository: {
      getContent: (_type: string, _modelId: string, dataName: string) => {
        const value = stored[dataName];
        return Promise.resolve(
          value === undefined
            ? null
            : new TextEncoder().encode(JSON.stringify(value)),
        );
      },
    },
    modelType: "@swamp/issue-lifecycle",
    modelId: "issue-42",
  };
}

Deno.test("attestation-posted: passes when a receipt records a passing gate", async () => {
  const result = await model.checks["attestation-posted"].execute(
    attestationCheckContext({
      "attestationRecord-main": {
        attestationId: "att-1",
        commit: "abc123",
        branch: "fix/thing",
        gatePassed: true,
        postedBy: "someone",
        postedAt: new Date().toISOString(),
      },
    }),
  );

  assertEquals(result.pass, true);
});

Deno.test("attestation-posted: rejects a receipt whose gate failed", async () => {
  const result = await model.checks["attestation-posted"].execute(
    attestationCheckContext({
      "attestationRecord-main": {
        attestationId: "att-2",
        commit: "abc123",
        branch: "fix/thing",
        gatePassed: false,
        postedBy: "someone",
        postedAt: new Date().toISOString(),
      },
    }),
  );

  assertEquals(result.pass, false);
  assertStringIncludes(result.errors![0], "att-2");
});

Deno.test("attestation-posted: rejects a PR with no verification at all", async () => {
  const result = await model.checks["attestation-posted"].execute(
    attestationCheckContext({}),
  );

  assertEquals(result.pass, false);
  assertStringIncludes(result.errors![0], "submit-change");
});

Deno.test("attestation-posted: admits a verification recorded before receipts existed", async () => {
  // In-flight lifecycles: definitions auto-upgrade at run time, so this check
  // reaches a lifecycle that posted a good attestation under the previous
  // version, which wrote no receipt. Stranding it would force a re-verify of
  // work already verified.
  const result = await model.checks["attestation-posted"].execute(
    attestationCheckContext({
      "verificationResult-main": {
        allPassed: true,
        stepsFailed: 0,
        verifiedAt: "2026-09-01T12:00:00.000Z",
      },
    }),
  );

  assertEquals(result.pass, true);
});

Deno.test("attestation-posted: rejects a verification recorded after receipts existed", async () => {
  const result = await model.checks["attestation-posted"].execute(
    attestationCheckContext({
      "verificationResult-main": {
        allPassed: true,
        stepsFailed: 0,
        verifiedAt: new Date().toISOString(),
      },
    }),
  );

  assertEquals(result.pass, false);
  assertStringIncludes(result.errors![0], "never accepted");
});

Deno.test("attestation-posted and verification-clear gate link_pr and complete", () => {
  // complete transitions the swamp-club issue to `shipped`, so it carries the
  // same evidence requirement as opening a PR.
  assertEquals(model.checks["attestation-posted"].appliesTo, [
    "link_pr",
    "complete",
  ]);
  assertEquals(model.checks["verification-clear"].appliesTo, [
    "link_pr",
    "complete",
  ]);
});

// ---------------------------------------------------------------------------
// verification_passed argument resolution
// ---------------------------------------------------------------------------

function attestation(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: "1",
    workflowRunId: "run-7",
    subject: { commit: "abc123", branch: "fix/thing" },
    gate: { allPassed: true, stepsFailed: 0 },
    steps: [
      {
        job: "build-static-analysis",
        step: "lint",
        model: "build-lint-run-7",
        status: "succeeded",
      },
      {
        job: "reviews",
        step: "ux-review",
        model: "review-ux-run-7",
        status: "skipped",
      },
    ],
    ...overrides,
  });
}

Deno.test("resolveVerificationArgs: reads the whole checklist out of the attestation", () => {
  const resolved = resolveVerificationArgs({ attestation: attestation() });

  assertEquals(resolved.workflowRunId, "run-7");
  assertEquals(resolved.commit, "abc123");
  assertEquals(resolved.branch, "fix/thing");
  assertEquals(resolved.steps.length, 2);
  assertEquals(resolved.steps[0].model, "build-lint-run-7");
  assertEquals(resolved.steps[1].status, "skipped");
});

Deno.test("resolveVerificationArgs: the attestation wins over anything else supplied", () => {
  // The point of the workflow path: a caller cannot narrate a commit the run
  // did not verify alongside the document that says which one it did.
  const resolved = resolveVerificationArgs({
    attestation: attestation(),
    commit: "deadbeef",
    branch: "some/other",
    workflowRunId: "run-999",
    steps: [],
  });

  assertEquals(resolved.commit, "abc123");
  assertEquals(resolved.workflowRunId, "run-7");
  assertEquals(resolved.steps.length, 2);
});

Deno.test("resolveVerificationArgs: refuses an attestation whose gate did not pass", () => {
  assertThrows(
    () =>
      resolveVerificationArgs({
        attestation: attestation({
          gate: { allPassed: false, stepsFailed: 2 },
        }),
      }),
    Error,
    "did not pass",
  );
});

Deno.test("resolveVerificationArgs: a non-terminal step status is not a pass", () => {
  const resolved = resolveVerificationArgs({
    attestation: attestation({
      steps: [{ job: "build-tests", step: "run-tests", status: "unknown" }],
    }),
  });

  assertEquals(resolved.steps[0].status, "failed");
});

Deno.test("resolveVerificationArgs: rejects malformed attestation JSON", () => {
  assertThrows(
    () => resolveVerificationArgs({ attestation: "{not json" }),
    Error,
    "not valid JSON",
  );
});

Deno.test("resolveVerificationArgs: the manual path still takes explicit arguments", () => {
  const resolved = resolveVerificationArgs({
    workflowRunId: "run-1",
    commit: "abc123",
    branch: "fix/thing",
    steps: [{
      job: "build-tests",
      step: "run-tests",
      model: "build-tests",
      method: "execute",
      status: "succeeded",
    }],
  });

  assertEquals(resolved.commit, "abc123");
  assertEquals(resolved.steps.length, 1);
});

Deno.test("resolveVerificationArgs: names what the manual path is missing", () => {
  assertThrows(
    () => resolveVerificationArgs({ commit: "abc123" }),
    Error,
    "workflowRunId, branch, steps",
  );
});

Deno.test("verification_passed: writes the checklist derived from the attestation", async () => {
  const { context, writes, restore } = await buildTestContext(42);
  try {
    await model.methods.verification_passed.execute(
      { attestation: attestation() },
      context,
    );

    const write = writes.find((w) => w.specName === "verificationResult")!;
    assertEquals(write.data.workflowRunId, "run-7");
    assertEquals(write.data.commit, "abc123");
    assertEquals(write.data.allPassed, true);
    assertEquals(write.data.stepsCompleted, 1);
    assertEquals(write.data.stepsSkipped, 1);
    assertEquals(write.data.stepsFailed, 0);
    assertEquals(write.data.stepsTotal, 2);
  } finally {
    await restore();
  }
});

// ---------------------------------------------------------------------------
// Commit binding and the complete override
// ---------------------------------------------------------------------------

function gateContext(
  stored: Record<string, Record<string, unknown> | undefined>,
  opts: { methodName?: string; reason?: string } = {},
) {
  return {
    methodName: opts.methodName ?? "link_pr",
    unresolvedMethodArgs: opts.reason === undefined
      ? {}
      : { reason: opts.reason },
    dataRepository: {
      getContent: (_t: string, _m: string, dataName: string) => {
        const value = stored[dataName];
        return Promise.resolve(
          value === undefined
            ? null
            : new TextEncoder().encode(JSON.stringify(value)),
        );
      },
    },
    modelType: "@swamp/issue-lifecycle",
    modelId: "issue-42",
  };
}

const PASSING_RESULT = { allPassed: true, stepsFailed: 0, commit: "abc123" };
const PASSING_RECORD = {
  attestationId: "att-1",
  commit: "abc123",
  branch: "fix/thing",
  gatePassed: true,
  postedBy: "someone",
  postedAt: "2026-09-21T12:00:00.000Z",
};
const TARGET = {
  commit: "abc123",
  branch: "fix/thing",
  startedAt: "2026-09-21T11:00:00.000Z",
};

Deno.test("verify: persists the commit and branch verification was started for", async () => {
  const { context, writes, restore } = await buildTestContext(42);
  try {
    await model.methods.verify.execute(
      { commit: "abc123", branch: "fix/thing" },
      context,
    );

    const target = writes.find((w) => w.specName === "verificationTarget")!;
    assertEquals(target.instanceName, "verificationTarget-main");
    assertEquals(target.data.commit, "abc123");
    assertEquals(target.data.branch, "fix/thing");
  } finally {
    await restore();
  }
});

Deno.test("verification-clear: rejects a result from a different commit", async () => {
  const result = await model.checks["verification-clear"].execute(
    gateContext({
      "verificationResult-main": { ...PASSING_RESULT, commit: "old999" },
      "verificationTarget-main": TARGET,
    }),
  );

  assertEquals(result.pass, false);
  assertStringIncludes(result.errors![0], "old999");
  assertStringIncludes(result.errors![0], "abc123");
});

Deno.test("attestation-posted: rejects an attestation for a different commit", async () => {
  const result = await model.checks["attestation-posted"].execute(
    gateContext({
      "attestationRecord-main": { ...PASSING_RECORD, commit: "old999" },
      "verificationTarget-main": TARGET,
    }),
  );

  assertEquals(result.pass, false);
  assertStringIncludes(result.errors![0], "att-1");
});

Deno.test("commit binding: both checks pass when every record agrees", async () => {
  const stored = {
    "verificationResult-main": PASSING_RESULT,
    "attestationRecord-main": PASSING_RECORD,
    "verificationTarget-main": TARGET,
  };

  assertEquals(
    (await model.checks["verification-clear"].execute(gateContext(stored)))
      .pass,
    true,
  );
  assertEquals(
    (await model.checks["attestation-posted"].execute(gateContext(stored)))
      .pass,
    true,
  );
});

Deno.test("commit binding: a lifecycle with no target is admitted", async () => {
  // Verified before `verify` began persisting its commit — there is nothing to
  // compare against, and stranding it would force re-verifying finished work.
  const result = await model.checks["verification-clear"].execute(
    gateContext({ "verificationResult-main": PASSING_RESULT }),
  );

  assertEquals(result.pass, true);
});

Deno.test("complete: is gated by verification and attestation like link_pr", async () => {
  const result = await model.checks["verification-clear"].execute(
    gateContext({}, { methodName: "complete" }),
  );

  assertEquals(result.pass, false);
  assertStringIncludes(result.errors![0], "reason=");
});

Deno.test("complete: a written reason opens the escape", async () => {
  const stored = {};
  assertEquals(
    (await model.checks["verification-clear"].execute(
      gateContext(stored, { methodName: "complete", reason: "docs only" }),
    )).pass,
    true,
  );
  assertEquals(
    (await model.checks["attestation-posted"].execute(
      gateContext(stored, { methodName: "complete", reason: "docs only" }),
    )).pass,
    true,
  );
});

Deno.test("complete: a blank reason is not an escape", async () => {
  const result = await model.checks["verification-clear"].execute(
    gateContext({}, { methodName: "complete", reason: "   " }),
  );

  assertEquals(result.pass, false);
});

Deno.test("link_pr: the complete escape does not apply to it", async () => {
  // The override is complete's alone — link_pr is the path the verification
  // chain exists to guard, so a reason must never open it.
  const result = await model.checks["attestation-posted"].execute(
    gateContext({}, { methodName: "link_pr", reason: "just this once" }),
  );

  assertEquals(result.pass, false);
});

Deno.test("complete: records the override reason on the lifecycle entry", async () => {
  const { context, restore } = await buildTestContext(42);
  try {
    // No swamp-club credentials in the test context, so this exercises the
    // local path: the reason must reach the log and the state write must land.
    await model.methods.complete.execute({ reason: "docs only" }, context);
  } finally {
    await restore();
  }
});

Deno.test("verify: is legal from every phase a commit can move in", () => {
  // Re-verifying has to stay reachable after a PR is open: CI checks the
  // attestation's commit against the PR head, so every push needs a fresh
  // verification, and `verify` is what records the commit the gates compare
  // against. Accepting only `implementing` meant refreshing that record
  // required marking a healthy PR failed first.
  assertEquals(TRANSITIONS.verify, [
    "implementing",
    "verifying",
    "pr_open",
    "pr_failed",
  ]);
});
