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

import { assertEquals, assertRejects } from "@std/assert";
import { model } from "./issue_lifecycle.ts";

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

Deno.test("link_pr: writes pullRequest-main resource with url and linkedAt", async () => {
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

Deno.test("link_pr: is idempotent — second call overwrites the pullRequest resource", async () => {
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
  } finally {
    await restore();
  }
});

Deno.test("link_pr: rejects empty url via zod schema", async () => {
  await assertRejects(
    () => model.methods.link_pr.arguments.parseAsync({ url: "" }),
  );
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

Deno.test("model: version bumped to 2026.04.09.1", () => {
  assertEquals(model.version, "2026.04.09.1");
});

// ---------------------------------------------------------------------------
// pr_merged
// ---------------------------------------------------------------------------

Deno.test("pr_merged: transitions state to releasing and writes mergedAt", async () => {
  const { context, writes, restore } = await buildTestContext(42, {
    resources: {
      "pullRequest-main": {
        url: "https://github.com/systeminit/swamp/pull/1141",
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

Deno.test("pr_failed: transitions state to pr_failed and writes failure info", async () => {
  const { context, writes, restore } = await buildTestContext(42, {
    resources: {
      "pullRequest-main": {
        url: "https://github.com/systeminit/swamp/pull/1141",
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
