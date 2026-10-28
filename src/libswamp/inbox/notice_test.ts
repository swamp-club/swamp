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

import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import {
  type AuthCredentials,
  keyFingerprint,
} from "../../domain/auth/auth_credentials.ts";
import type {
  InboxSnapshot,
  InboxState,
} from "../../domain/inbox/inbox_state.ts";
import type { InboxSummaryResult } from "../../infrastructure/http/inbox_schemas.ts";
import { InboxCacheFileRepository } from "../../infrastructure/inbox/inbox_cache_file_repository.ts";
import { withMockedEnv } from "../../infrastructure/persistence/path_test_helpers.ts";
import {
  createInboxNoticeDeps,
  INBOX_POLL_GRACE_MS,
  type InboxNoticeDeps,
  showInboxNotice,
  startInboxPoll,
} from "./notice.ts";

const credentials: AuthCredentials = {
  serverUrl: "https://swamp-club.com",
  apiKey: "swamp_test_key",
  apiKeyId: "key-1",
  username: "keeb",
};

const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const ID_A = "01JBX5Q8ZK00000000000000ZX";

const okSummary: InboxSummaryResult = {
  kind: "ok",
  summary: {
    unread: 2,
    newestId: ID_A,
    newestAt: "2026-10-28T11:30:00.000Z",
    pollAfterSeconds: 900,
  },
  etag: '"v2"',
};

function snapshot(overrides: Partial<InboxSnapshot> = {}): InboxSnapshot {
  return {
    unread: 2,
    newestId: ID_A,
    newestAt: "2026-10-28T11:30:00.000Z",
    pollAfterSeconds: 900,
    etag: '"v1"',
    ...overrides,
  };
}

/** A key polled two hours ago: due again, with a cached snapshot. */
function polledState(overrides: Partial<InboxSnapshot> = {}): InboxState {
  return {
    snapshot: snapshot(overrides),
    schedule: { lastPolledAt: NOW - 2 * HOUR_MS, nextPollAt: null, stop: null },
    announcement: null,
  };
}

interface Recorder {
  summaries: { etag: string | null; signal: AbortSignal }[];
  waits: AbortSignal[];
  saves: number;
}

interface Harness {
  deps: InboxNoticeDeps;
  rec: Recorder;
  cache: InboxCacheFileRepository;
  fingerprint: string;
}

/**
 * Runs `fn` against a real per-key cache in a temp config dir, with an
 * injected client and wait. The temp dir is removed whether `fn` passes or
 * fails.
 */
async function withHarness(
  options: {
    state?: InboxState;
    summary?: (signal: AbortSignal) => Promise<InboxSummaryResult>;
    /** Resolve the grace wait at once rather than only when aborted. */
    graceElapses?: boolean;
    overrides?: Partial<InboxNoticeDeps>;
  },
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-inbox-notice-" });
  try {
    const cache = new InboxCacheFileRepository(dir);
    const fingerprint = await keyFingerprint(credentials.apiKey);
    if (options.state) await cache.save(fingerprint, options.state);
    const rec: Recorder = { summaries: [], waits: [], saves: 0 };
    const deps: InboxNoticeDeps = {
      loadCredentials: () => Promise.resolve(credentials),
      inboxSummary: (_url, _key, etag, signal) => {
        rec.summaries.push({ etag, signal });
        return options.summary
          ? options.summary(signal)
          : Promise.resolve(okSummary);
      },
      loadInboxState: (fp) => cache.load(fp),
      saveInboxState: (fp, state) => {
        rec.saves++;
        return cache.save(fp, state);
      },
      ownsConfigDir: () => true,
      now: () => NOW,
      wait: (_ms, signal) => {
        rec.waits.push(signal);
        if (options.graceElapses) return Promise.resolve();
        return new Promise((resolve) => {
          if (signal.aborted) resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      ...options.overrides,
    };
    await fn({ deps, rec, cache, fingerprint });
  } finally {
    await Deno.remove(dir, { recursive: true }).catch((error) => {
      if (Deno.build.os !== "windows") throw error;
    });
  }
}

/** A summary that answers only when its signal aborts, as the client does. */
function pendingUntilAborted(
  signal: AbortSignal,
): Promise<InboxSummaryResult> {
  return new Promise((resolve) => {
    signal.addEventListener(
      "abort",
      () => resolve({ kind: "failed", reason: "request aborted" }),
      { once: true },
    );
  });
}

Deno.test("startInboxPoll: a poll that settled before teardown is saved without waiting out the grace", async () => {
  await withHarness({}, async ({ deps, rec, cache, fingerprint }) => {
    const poll = await startInboxPoll(deps);
    assert(poll !== null);
    await poll.settle();

    assertEquals(rec.summaries.length, 1);
    assertEquals(rec.summaries[0].signal.aborted, false);
    // The grace wait was cut short as soon as the poll had settled.
    assertEquals(rec.waits.length, 1);
    assertEquals(rec.waits[0].aborted, true);
    const saved = await cache.load(fingerprint);
    assertEquals(saved.snapshot?.unread, 2);
    assertEquals(saved.snapshot?.etag, '"v2"');
    assertEquals(saved.schedule.lastPolledAt, NOW);
  });
});

Deno.test("startInboxPoll: a poll still running when the grace ends is aborted and saved as failed", async () => {
  await withHarness(
    { summary: pendingUntilAborted, graceElapses: true },
    async ({ deps, rec, cache, fingerprint }) => {
      const poll = await startInboxPoll(deps);
      assert(poll !== null);
      await poll.settle();

      assertEquals(rec.summaries[0].signal.aborted, true);
      const saved = await cache.load(fingerprint);
      assertStrictEquals(saved.snapshot, null);
      assertEquals(saved.schedule.lastPolledAt, NOW);
    },
  );
});

Deno.test("startInboxPoll: sends the cached etag, and a 304 keeps the snapshot", async () => {
  await withHarness(
    {
      state: polledState(),
      summary: () => Promise.resolve({ kind: "not_modified" }),
    },
    async ({ deps, rec, cache, fingerprint }) => {
      const poll = await startInboxPoll(deps);
      assert(poll !== null);
      await poll.settle();

      assertEquals(rec.summaries[0].etag, '"v1"');
      const saved = await cache.load(fingerprint);
      assertEquals(saved.snapshot, snapshot());
      assertEquals(saved.schedule.lastPolledAt, NOW);
    },
  );
});

Deno.test("startInboxPoll: a key that has never been polled sends no etag", async () => {
  await withHarness({}, async ({ deps, rec }) => {
    const poll = await startInboxPoll(deps);
    assert(poll !== null);
    await poll.settle();
    assertStrictEquals(rec.summaries[0].etag, null);
  });
});

Deno.test("startInboxPoll: a client that rejects or throws is saved as a failed poll", async () => {
  const throwing = () => {
    throw new Error("boom");
  };
  for (
    const summary of [
      () => Promise.reject(new Error("boom")),
      throwing,
    ]
  ) {
    await withHarness({ summary }, async ({ deps, cache, fingerprint }) => {
      const poll = await startInboxPoll(deps);
      assert(poll !== null);
      await poll.settle();
      const saved = await cache.load(fingerprint);
      assertStrictEquals(saved.snapshot, null);
      assertEquals(saved.schedule.lastPolledAt, NOW);
    });
  }
});

Deno.test("startInboxPoll: settling twice saves once", async () => {
  await withHarness({}, async ({ deps, rec }) => {
    const poll = await startInboxPoll(deps);
    assert(poll !== null);
    await Promise.all([poll.settle(), poll.settle()]);
    assertEquals(rec.saves, 1);
  });
});

Deno.test("startInboxPoll: a save that throws never escapes settle", async () => {
  await withHarness(
    {
      overrides: { saveInboxState: () => Promise.reject(new Error("disk")) },
    },
    async ({ deps }) => {
      const poll = await startInboxPoll(deps);
      assert(poll !== null);
      await poll.settle();
    },
  );
});

Deno.test("startInboxPoll: no poll when it is not due", async () => {
  const recent: InboxState = {
    ...polledState(),
    schedule: { lastPolledAt: NOW - 60_000, nextPollAt: null, stop: null },
  };
  await withHarness({ state: recent }, async ({ deps, rec }) => {
    assertStrictEquals(await startInboxPoll(deps), null);
    assertEquals(rec.summaries.length, 0);
  });
});

Deno.test("startInboxPoll: no poll for a stopped key", async () => {
  const stopped: InboxState = {
    ...polledState(),
    schedule: {
      lastPolledAt: NOW - 2 * HOUR_MS,
      nextPollAt: null,
      stop: { reason: "unavailable", at: NOW - 2 * HOUR_MS },
    },
  };
  await withHarness({ state: stopped }, async ({ deps, rec }) => {
    assertStrictEquals(await startInboxPoll(deps), null);
    assertEquals(rec.summaries.length, 0);
  });
});

Deno.test("startInboxPoll: no poll without a credential or with an empty key", async () => {
  for (
    const loaded of [null, { ...credentials, apiKey: "" }]
  ) {
    await withHarness(
      { overrides: { loadCredentials: () => Promise.resolve(loaded) } },
      async ({ deps, rec }) => {
        assertStrictEquals(await startInboxPoll(deps), null);
        assertEquals(rec.summaries.length, 0);
      },
    );
  }
});

Deno.test("startInboxPoll: no poll when the process does not own the config dir", async () => {
  await withHarness(
    { overrides: { ownsConfigDir: () => false } },
    async ({ deps, rec }) => {
      assertStrictEquals(await startInboxPoll(deps), null);
      assertEquals(rec.summaries.length, 0);
      assertEquals(rec.saves, 0);
    },
  );
});

Deno.test("startInboxPoll: a credential load that throws means no poll", async () => {
  await withHarness(
    {
      overrides: {
        loadCredentials: () => Promise.reject(new Error("unreadable")),
      },
    },
    async ({ deps, rec }) => {
      assertStrictEquals(await startInboxPoll(deps), null);
      assertEquals(rec.summaries.length, 0);
    },
  );
});

Deno.test("startInboxPoll: the grace the wait is asked for is the teardown cap", async () => {
  const asked: number[] = [];
  await withHarness(
    {
      overrides: {
        wait: (ms) => {
          asked.push(ms);
          return Promise.resolve();
        },
      },
    },
    async ({ deps }) => {
      const poll = await startInboxPoll(deps);
      assert(poll !== null);
      await poll.settle();
    },
  );
  assertEquals(asked, [INBOX_POLL_GRACE_MS]);
});

Deno.test("showInboxNotice: reads the cache only and records the announcement", async () => {
  await withHarness(
    { state: polledState() },
    async ({ deps, rec, cache, fingerprint }) => {
      assertEquals(await showInboxNotice(deps), { unread: 2 });
      assertEquals(rec.summaries.length, 0);
      const saved = await cache.load(fingerprint);
      assertEquals(saved.announcement, { id: ID_A, at: NOW });
    },
  );
});

Deno.test("showInboxNotice: nothing unread means no notice and no save", async () => {
  await withHarness(
    { state: polledState({ unread: 0, newestId: null }) },
    async ({ deps, rec }) => {
      assertStrictEquals(await showInboxNotice(deps), null);
      assertEquals(rec.saves, 0);
    },
  );
});

Deno.test("showInboxNotice: a retired notice stays retired", async () => {
  const announced: InboxState = {
    ...polledState(),
    announcement: { id: ID_A, at: NOW - 25 * HOUR_MS },
  };
  await withHarness({ state: announced }, async ({ deps }) => {
    assertStrictEquals(await showInboxNotice(deps), null);
  });
});

Deno.test("showInboxNotice: shows without recording when the process does not own the config dir", async () => {
  await withHarness(
    { state: polledState(), overrides: { ownsConfigDir: () => false } },
    async ({ deps, rec }) => {
      assertEquals(await showInboxNotice(deps), { unread: 2 });
      assertEquals(rec.saves, 0);
    },
  );
});

Deno.test("showInboxNotice: a save that throws still shows the notice", async () => {
  await withHarness(
    {
      state: polledState(),
      overrides: { saveInboxState: () => Promise.reject(new Error("disk")) },
    },
    async ({ deps }) => {
      assertEquals(await showInboxNotice(deps), { unread: 2 });
    },
  );
});

Deno.test("showInboxNotice: no credential means no notice", async () => {
  await withHarness(
    {
      state: polledState(),
      overrides: { loadCredentials: () => Promise.resolve(null) },
    },
    async ({ deps }) => {
      assertStrictEquals(await showInboxNotice(deps), null);
    },
  );
});

Deno.test("createInboxNoticeDeps: the wait ends when aborted and leaves no timer behind", async () => {
  const { wait } = createInboxNoticeDeps();
  const controller = new AbortController();
  // A minute-long wait: the test would hang, and the timer sanitizer would
  // fail it, if aborting did not clear the timer.
  const waiting = wait(60_000, controller.signal);
  controller.abort();
  await waiting;
  // An already-aborted signal resolves at once.
  await wait(60_000, controller.signal);
});

/** Every variable the config dir resolves from, unset. */
const NO_HOME = {
  SWAMP_CONFIG_DIR: undefined,
  SWAMP_HOME: undefined,
  XDG_CONFIG_HOME: undefined,
  HOME: undefined,
  USERPROFILE: undefined,
};

Deno.test("createInboxNoticeDeps: with no home directory the deps build, and the poll and notice fail safe", async () => {
  for (const key of [undefined, "swamp_test_key"]) {
    await withMockedEnv(
      { ...NO_HOME, SWAMP_API_KEY: key, SWAMP_API_KEY_FILE: undefined },
      async () => {
        let summaries = 0;
        const deps = {
          ...createInboxNoticeDeps(),
          inboxSummary: () => {
            summaries++;
            return Promise.resolve(okSummary);
          },
          ownsConfigDir: () => true,
        };
        assertStrictEquals(await startInboxPoll(deps), null);
        assertStrictEquals(await showInboxNotice(deps), null);
        assertEquals(summaries, 0);
      },
    );
  }
});

Deno.test("showInboxNotice: a notice already announced is shown again without writing the cache", async () => {
  const announced: InboxState = {
    ...polledState(),
    announcement: { id: ID_A, at: NOW - HOUR_MS },
  };
  await withHarness({ state: announced }, async ({ deps, rec }) => {
    assertEquals(await showInboxNotice(deps), { unread: 2 });
    assertEquals(rec.saves, 0);
  });
});
