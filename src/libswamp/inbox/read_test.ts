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
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import {
  type AuthCredentials,
  keyFingerprint,
} from "../../domain/auth/auth_credentials.ts";
import { UserError } from "../../domain/errors.ts";
import {
  noticeToShow,
  recordNoticeShown,
} from "../../domain/inbox/inbox_policy.ts";
import { InboxCacheKey, InboxState } from "../../domain/inbox/inbox_state.ts";
import {
  type InboxListOptions,
  type InboxMessage,
  type InboxMessagePage,
  type InboxSummaryResult,
  parseInboxMessagePage,
} from "../../infrastructure/http/inbox_schemas.ts";
import { createLibSwampContext } from "../context.ts";
import { collect } from "../testing.ts";
import {
  type InboxReadDeps,
  inboxReadNext,
  type InboxReadNextEvent,
  markRead,
  type MarkReadEvent,
  MAX_INBOX_READ_PAGES,
} from "./read.ts";

const fixture = JSON.parse(
  await Deno.readTextFile(
    new URL(
      "../../infrastructure/http/inbox_responses.fixture.json",
      import.meta.url,
    ),
  ),
);
const fullPage: InboxMessagePage = parseInboxMessagePage(
  fixture.messagesPage,
)!;
const unreadPage: InboxMessagePage = {
  messages: fullPage.messages.filter((m) => m.readAt === null),
  nextCursor: null,
  dropped: 0,
};
const webKindsPage: InboxMessagePage = parseInboxMessagePage(
  fixture.webKindsPage,
)!;
const knownMessages: InboxMessage[] = [
  ...fullPage.messages,
  ...webKindsPage.messages,
];

function messageOf(kind: string): InboxMessage {
  const found = knownMessages.find((m) => m.kind === kind);
  assert(found !== undefined, kind);
  return found;
}

const credentials: AuthCredentials = {
  serverUrl: "https://swamp-club.com",
  apiKey: "swamp_test_key",
  apiKeyId: "key-1",
  username: "keeb",
};

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const NOW_ISO = new Date(NOW).toISOString();

const okSummary: InboxSummaryResult = {
  kind: "ok",
  summary: {
    unread: 1,
    newestId: "01JBX5Q8ZK00000000000000ZX",
    newestAt: "2026-10-25T17:30:00.000Z",
    pollAfterSeconds: 900,
  },
  etag: '"v2"',
};

/** A summary that names no message: the read falls back to the list. */
const quietSummary: InboxSummaryResult = {
  kind: "ok",
  summary: {
    unread: 0,
    newestId: null,
    newestAt: null,
    pollAfterSeconds: 900,
  },
  etag: '"v1"',
};

function announcing(id: string, unread = 1): InboxSummaryResult {
  return {
    kind: "ok",
    summary: {
      unread,
      newestId: id,
      newestAt: "2026-10-25T17:30:00.000Z",
      pollAfterSeconds: 900,
    },
    etag: '"v3"',
  };
}

interface Recorder {
  listed: InboxListOptions[];
  marked: string[][];
  summaries: number;
  got: string[];
  saved: { key: InboxCacheKey; state: InboxState }[];
}

/**
 * `summaries` answers the summary calls in order, the last repeating: in
 * inboxReadNext the first finds the announced message and the second
 * follows marking read. `summary` answers every call.
 */
function makeDeps(overrides: Partial<InboxReadDeps> & {
  page?: InboxMessagePage;
  summary?: InboxSummaryResult;
  summaries?: InboxSummaryResult[];
  credentials?: AuthCredentials | null;
} = {}): { deps: InboxReadDeps; rec: Recorder } {
  const rec: Recorder = {
    listed: [],
    marked: [],
    summaries: 0,
    got: [],
    saved: [],
  };
  const summaries = overrides.summary !== undefined
    ? [overrides.summary]
    : overrides.summaries ?? [quietSummary, okSummary];
  const deps: InboxReadDeps = {
    loadCredentials: () =>
      Promise.resolve(
        overrides.credentials === undefined
          ? credentials
          : overrides.credentials,
      ),
    listMessages: (_url, _key, options) => {
      rec.listed.push(options);
      return Promise.resolve(overrides.page ?? unreadPage);
    },
    markInboxRead: (_url, _key, ids) => {
      rec.marked.push([...ids]);
      return Promise.resolve([...ids]);
    },
    getInboxMessage: (_url, _key, id) => {
      rec.got.push(id);
      const found = knownMessages.find((m) => m.id === id);
      return found
        ? Promise.resolve(found)
        : Promise.reject(new UserError(`Message ${id} not found.`));
    },
    inboxSummary: () => {
      const answer = summaries[Math.min(rec.summaries, summaries.length - 1)];
      rec.summaries++;
      return Promise.resolve(answer);
    },
    loadInboxState: () => Promise.resolve(InboxState.empty()),
    saveInboxState: (key, state) => {
      rec.saved.push({ key, state });
      return Promise.resolve();
    },
    ownsConfigDir: () => true,
    now: () => NOW,
    ...overrides,
  };
  return { deps, rec };
}

function lastOf<E extends { kind: string }>(events: E[]): E {
  const last = events.at(-1);
  assert(last !== undefined);
  return last;
}

Deno.test("inboxReadNext: reads the newest unread message and marks only it", async () => {
  const { deps, rec } = makeDeps();

  const events = await collect<InboxReadNextEvent>(
    inboxReadNext(createLibSwampContext(), deps),
  );

  assertEquals(rec.listed, [{ status: "unread", limit: 2 }]);
  assertEquals(rec.marked, [["01JBX5Q8ZK0000000000000104"]]);
  const last = lastOf(events);
  assert(last.kind === "completed");
  assertEquals(last.view.message?.id, "01JBX5Q8ZK0000000000000104");
  assertEquals(last.view.message?.body, unreadPage.messages[0].body);
  assertEquals(last.view.message?.link, unreadPage.messages[0].link);
  assertEquals(last.view.message?.readAt, new Date(NOW).toISOString());
  assertEquals(last.view.marked, true);
  assertEquals(last.view.moreUnread, true);
  assertEquals(last.view.dropped, 0);
});

Deno.test("inboxReadNext: moreUnread follows a second message or a cursor", async () => {
  const one = unreadPage.messages.slice(0, 1);
  const cases: [InboxMessagePage, boolean][] = [
    [{ messages: one, nextCursor: null, dropped: 0 }, false],
    [{ messages: one, nextCursor: one[0].id, dropped: 0 }, true],
    [unreadPage, true],
    // The second entry broke the contract: it is still an unread message.
    [{ messages: one, nextCursor: null, dropped: 1 }, true],
  ];
  for (const [page, expected] of cases) {
    const { deps } = makeDeps({ page });

    const last = lastOf(
      await collect<InboxReadNextEvent>(
        inboxReadNext(createLibSwampContext(), deps),
      ),
    );

    assert(last.kind === "completed");
    assertEquals(last.view.moreUnread, expected);
  }
});

Deno.test("inboxReadNext: nothing unread marks nothing and reports dropped", async () => {
  const { deps, rec } = makeDeps({
    page: { messages: [], nextCursor: null, dropped: 1 },
  });

  const last = lastOf(
    await collect<InboxReadNextEvent>(
      inboxReadNext(createLibSwampContext(), deps),
    ),
  );

  assert(last.kind === "completed");
  assertEquals(last.view, {
    message: null,
    marked: false,
    moreUnread: false,
    dropped: 1,
  });
  assertEquals(rec.marked, []);
  // Only the summary that looks for the announced message: nothing was
  // marked, so there is nothing to refresh.
  assertEquals(rec.summaries, 1);
});

Deno.test("inboxReadNext: pages past entries that were all dropped", async () => {
  const [valid] = unreadPage.messages;
  const pages: InboxMessagePage[] = [
    { messages: [], nextCursor: "01JBX5Q8ZK00000000000000Z1", dropped: 2 },
    { messages: [], nextCursor: "01JBX5Q8ZK00000000000000Z0", dropped: 2 },
    { messages: [valid], nextCursor: null, dropped: 0 },
  ];
  const { deps, rec } = makeDeps({
    listMessages: (_url, _key, options) => {
      rec.listed.push(options);
      return Promise.resolve(pages[rec.listed.length - 1]);
    },
  });

  const last = lastOf(
    await collect<InboxReadNextEvent>(
      inboxReadNext(createLibSwampContext(), deps),
    ),
  );

  assert(last.kind === "completed");
  assertEquals(last.view.message?.id, valid.id);
  assertEquals(last.view.dropped, 4);
  assertEquals(last.view.moreUnread, true);
  assertEquals(rec.marked, [[valid.id]]);
  assertEquals(rec.listed, [
    { status: "unread", limit: 2 },
    { status: "unread", limit: 2, before: "01JBX5Q8ZK00000000000000Z1" },
    { status: "unread", limit: 2, before: "01JBX5Q8ZK00000000000000Z0" },
  ]);
});

Deno.test("inboxReadNext: stops paging after MAX_INBOX_READ_PAGES pages of dropped entries", async () => {
  const { deps, rec } = makeDeps({
    page: {
      messages: [],
      nextCursor: "01JBX5Q8ZK00000000000000Z1",
      dropped: 2,
    },
  });

  const last = lastOf(
    await collect<InboxReadNextEvent>(
      inboxReadNext(createLibSwampContext(), deps),
    ),
  );

  assert(last.kind === "completed");
  assertEquals(last.view.message, null);
  assertEquals(rec.listed.length, MAX_INBOX_READ_PAGES);
  assertEquals(last.view.dropped, 2 * MAX_INBOX_READ_PAGES);
  // Older pages are left unlisted, so more unread messages remain.
  assertEquals(last.view.moreUnread, true);
  assertEquals(rec.marked, []);
});

Deno.test("inboxReadNext: an id swamp-club does not confirm stays unread", async () => {
  const { deps } = makeDeps({ markInboxRead: () => Promise.resolve([]) });

  const last = lastOf(
    await collect<InboxReadNextEvent>(
      inboxReadNext(createLibSwampContext(), deps),
    ),
  );

  assert(last.kind === "completed");
  assertEquals(last.view.marked, false);
  assertEquals(last.view.message?.readAt, null);
});

Deno.test("inboxReadNext: the refreshed summary goes into the key's cache", async () => {
  const { deps, rec } = makeDeps();

  await collect<InboxReadNextEvent>(
    inboxReadNext(createLibSwampContext(), deps),
  );

  assertEquals(rec.summaries, 2);
  assertEquals(rec.saved.length, 2);
  const refreshed = rec.saved[1];
  assertEquals(
    refreshed.key,
    InboxCacheKey.of(
      credentials.serverUrl,
      await keyFingerprint(credentials.apiKey),
    ),
  );
  assertEquals(refreshed.state.snapshot, {
    unread: 1,
    newestId: "01JBX5Q8ZK00000000000000ZX",
    newestAt: "2026-10-25T17:30:00.000Z",
    pollAfterSeconds: 900,
    etag: '"v2"',
    fetchedAt: NOW,
  });
  assertEquals(refreshed.state.schedule.lastPolledAt, NOW);
});

Deno.test("inboxReadNext: the refresh is kept under the server it asked, not the stored one", async () => {
  const { deps, rec } = makeDeps({
    serverUrlOverride: "https://staging.swamp-club.com/",
  });

  await collect<InboxReadNextEvent>(
    inboxReadNext(createLibSwampContext(), deps),
  );

  assertEquals(rec.saved.length, 2);
  for (const { key } of rec.saved) {
    assertEquals(key.origin, "https://staging.swamp-club.com");
  }
});

Deno.test("inboxReadNext: a failed refresh leaves the cache and still succeeds", async () => {
  const { deps, rec } = makeDeps({
    summary: { kind: "failed", reason: "timeout" },
  });

  const last = lastOf(
    await collect<InboxReadNextEvent>(
      inboxReadNext(createLibSwampContext(), deps),
    ),
  );

  assert(last.kind === "completed");
  assertEquals(last.view.marked, true);
  assertEquals(rec.saved, []);
});

Deno.test("inboxReadNext: a cache that cannot be saved still succeeds", async () => {
  const { deps } = makeDeps({
    saveInboxState: () => Promise.reject(new Error("disk full")),
  });

  const last = lastOf(
    await collect<InboxReadNextEvent>(
      inboxReadNext(createLibSwampContext(), deps),
    ),
  );

  assert(last.kind === "completed");
  assertEquals(last.view.marked, true);
});

Deno.test("inboxReadNext: a config dir this process does not own is left alone", async () => {
  const { deps, rec } = makeDeps({ ownsConfigDir: () => false });

  await collect<InboxReadNextEvent>(
    inboxReadNext(createLibSwampContext(), deps),
  );

  assertEquals(rec.marked.length, 1);
  // The announced message is still looked for; only the cache is left.
  assertEquals(rec.summaries, 1);
  assertEquals(rec.saved, []);
});

Deno.test("inboxReadNext: not signed in is notAuthenticated, with no call", async () => {
  for (const missing of [null, { ...credentials, apiKey: "" }]) {
    const { deps, rec } = makeDeps({ credentials: missing });

    const last = lastOf(
      await collect<InboxReadNextEvent>(
        inboxReadNext(createLibSwampContext(), deps),
      ),
    );

    assert(last.kind === "error");
    assertEquals(last.error.code, "not_authenticated");
    assertEquals(rec.listed, []);
  }
});

Deno.test("inboxReadNext: the client's UserErrors propagate unchanged", async () => {
  for (
    const message of [
      "The inbox needs a personal API key; collective keys have no inbox.",
      "https://swamp-club.com has no inbox.",
    ]
  ) {
    const thrown = new UserError(message);
    const { deps } = makeDeps({ listMessages: () => Promise.reject(thrown) });

    const error = await assertRejects(() =>
      collect<InboxReadNextEvent>(inboxReadNext(createLibSwampContext(), deps))
    );

    assertStrictEquals(error, thrown);
  }
});

Deno.test("inboxReadNext: an abort is cancelled", async () => {
  const { deps } = makeDeps({
    listMessages: () =>
      Promise.reject(new DOMException("aborted", "AbortError")),
  });

  const last = lastOf(
    await collect<InboxReadNextEvent>(
      inboxReadNext(createLibSwampContext(), deps),
    ),
  );

  assert(last.kind === "error");
  assertEquals(last.error.code, "cancelled");
});

Deno.test("inboxReadNext: reads the announced message ahead of a newer mention, and the notice stops", async () => {
  const mention = messageOf("mention");
  const announced = messageOf("issue_update");
  assert(mention.id > announced.id);
  // The notice is up for the issue_update.
  let state = recordNoticeShown(
    {
      ...InboxState.empty(),
      snapshot: {
        unread: 1,
        newestId: announced.id,
        newestAt: announced.createdAt,
        pollAfterSeconds: 900,
        etag: '"v3"',
        fetchedAt: NOW - 1_000,
      },
    },
    NOW - 1_000,
  );
  assert(noticeToShow(state, NOW) !== null);
  const { deps, rec } = makeDeps({
    page: { messages: [mention, announced], nextCursor: null, dropped: 0 },
    // A mention never counts: after the read nothing that raises the
    // notice is unread.
    summaries: [announcing(announced.id), quietSummary],
    loadInboxState: () => Promise.resolve(state),
    saveInboxState: (_key, next) => {
      state = next;
      return Promise.resolve();
    },
  });

  const last = lastOf(
    await collect<InboxReadNextEvent>(
      inboxReadNext(createLibSwampContext(), deps),
    ),
  );

  assert(last.kind === "completed");
  assertEquals(last.view.message?.id, announced.id);
  assertEquals(rec.got, [announced.id]);
  assertEquals(rec.marked, [[announced.id]]);
  // The mention is still waiting.
  assertEquals(last.view.moreUnread, true);
  assertEquals(noticeToShow(state, NOW), null);
});

Deno.test("inboxReadNext: the summary asked before reading goes into the key's cache", async () => {
  const announced = messageOf("issue_update");
  const { deps, rec } = makeDeps({
    summaries: [announcing(announced.id), quietSummary],
  });

  await collect<InboxReadNextEvent>(
    inboxReadNext(createLibSwampContext(), deps),
  );

  assertEquals(rec.saved.length, 2);
  assertEquals(rec.saved[0].state.snapshot?.newestId, announced.id);
  assertEquals(rec.saved[0].state.snapshot?.etag, '"v3"');
});

Deno.test("inboxReadNext: without an announced message to read, reads the newest unread", async () => {
  const announced = messageOf("issue_update");
  const unknownId = "01JBX5Q8ZK00000000000009ZZ";
  const readCopy: InboxMessage = { ...announced, readAt: NOW_ISO };
  const cases: {
    name: string;
    first: InboxSummaryResult;
    get?: InboxReadDeps["getInboxMessage"];
    gets: number;
  }[] = [
    { name: "failed", first: { kind: "failed", reason: "timeout" }, gets: 0 },
    { name: "not_modified", first: { kind: "not_modified" }, gets: 0 },
    { name: "unsupported", first: { kind: "unsupported" }, gets: 0 },
    { name: "unavailable", first: { kind: "unavailable" }, gets: 0 },
    { name: "rejected", first: { kind: "rejected" }, gets: 0 },
    { name: "newestId null", first: quietSummary, gets: 0 },
    { name: "a 404 from the get", first: announcing(unknownId), gets: 1 },
    {
      name: "a message the client refuses",
      first: announcing(announced.id),
      get: () =>
        Promise.reject(
          new UserError("Swamp Club returned a malformed answer."),
        ),
      gets: 1,
    },
    {
      name: "a message already read",
      first: announcing(announced.id),
      get: () => Promise.resolve(readCopy),
      gets: 1,
    },
  ];
  for (const c of cases) {
    let gets = 0;
    const { deps, rec } = makeDeps({
      summaries: [c.first, okSummary],
      ...(c.get !== undefined
        ? {
          getInboxMessage: (...args) => {
            gets++;
            return c.get!(...args);
          },
        }
        : {}),
    });

    const last = lastOf(
      await collect<InboxReadNextEvent>(
        inboxReadNext(createLibSwampContext(), deps),
      ),
    );

    assert(last.kind === "completed", c.name);
    assertEquals(
      last.view.message?.id,
      unreadPage.messages[0].id,
      c.name,
    );
    assertEquals(rec.marked, [[unreadPage.messages[0].id]], c.name);
    assertEquals(gets + rec.got.length, c.gets, c.name);
  }
});

Deno.test("inboxReadNext: a summary call that throws falls back to the newest unread", async () => {
  const { deps, rec } = makeDeps({
    inboxSummary: () => Promise.reject(new Error("socket closed")),
  });

  const last = lastOf(
    await collect<InboxReadNextEvent>(
      inboxReadNext(createLibSwampContext(), deps),
    ),
  );

  assert(last.kind === "completed");
  assertEquals(last.view.message?.id, unreadPage.messages[0].id);
  assertEquals(rec.got, []);
});

Deno.test("inboxReadNext: moreUnread counts unread messages other than the announced one", async () => {
  const mention = messageOf("mention");
  const announced = messageOf("issue_update");
  const cases: [InboxMessagePage, boolean][] = [
    [{ messages: [announced], nextCursor: null, dropped: 0 }, false],
    [{ messages: [mention, announced], nextCursor: null, dropped: 0 }, true],
    [{ messages: [mention], nextCursor: null, dropped: 0 }, true],
    [{ messages: [announced], nextCursor: announced.id, dropped: 0 }, true],
    [{ messages: [announced], nextCursor: null, dropped: 1 }, true],
  ];
  for (const [page, expected] of cases) {
    const { deps } = makeDeps({
      page,
      summaries: [announcing(announced.id), quietSummary],
    });

    const last = lastOf(
      await collect<InboxReadNextEvent>(
        inboxReadNext(createLibSwampContext(), deps),
      ),
    );

    assert(last.kind === "completed");
    assertEquals(last.view.message?.id, announced.id);
    assertEquals(last.view.moreUnread, expected);
  }
});

Deno.test("inboxReadNext: with the announced message in hand, lists one page only", async () => {
  const announced = messageOf("issue_update");
  const { deps, rec } = makeDeps({
    page: {
      messages: [],
      nextCursor: "01JBX5Q8ZK00000000000000Z1",
      dropped: 2,
    },
    summaries: [announcing(announced.id), quietSummary],
  });

  const last = lastOf(
    await collect<InboxReadNextEvent>(
      inboxReadNext(createLibSwampContext(), deps),
    ),
  );

  assert(last.kind === "completed");
  assertEquals(last.view.message?.id, announced.id);
  assertEquals(rec.listed.length, 1);
  assertEquals(last.view.moreUnread, true);
});

Deno.test("inboxReadNext: an abort while fetching the announced message is cancelled", async () => {
  const announced = messageOf("issue_update");
  const { deps, rec } = makeDeps({
    summaries: [announcing(announced.id)],
    getInboxMessage: () =>
      Promise.reject(new DOMException("aborted", "AbortError")),
  });

  const last = lastOf(
    await collect<InboxReadNextEvent>(
      inboxReadNext(createLibSwampContext(), deps),
    ),
  );

  assert(last.kind === "error");
  assertEquals(last.error.code, "cancelled");
  assertEquals(rec.marked, []);
});

Deno.test("markRead: marks exactly the given ids and refreshes the cache", async () => {
  const ids = ["01JBX5Q8ZK0000000000000104", "01JBX5Q8ZK00000000000000ZX"];
  const { deps, rec } = makeDeps();

  const last = lastOf(
    await collect<MarkReadEvent>(markRead(createLibSwampContext(), deps, ids)),
  );

  assert(last.kind === "completed");
  assertEquals(last.marked, ids);
  assertEquals(rec.marked, [ids]);
  assertEquals(rec.listed, []);
  assertEquals(rec.saved.length, 1);
});

Deno.test("markRead: no ids makes no request and loads no credentials", async () => {
  let loaded = false;
  const { deps, rec } = makeDeps({
    loadCredentials: () => {
      loaded = true;
      return Promise.resolve(credentials);
    },
  });

  const events = await collect<MarkReadEvent>(
    markRead(createLibSwampContext(), deps, []),
  );

  assertEquals(events, [{ kind: "completed", marked: [] }]);
  assertEquals(loaded, false);
  assertEquals(rec.marked, []);
  assertEquals(rec.summaries, 0);
});

Deno.test("markRead: a client UserError propagates unchanged", async () => {
  const thrown = new UserError("https://swamp-club.com has no inbox.");
  const { deps } = makeDeps({ markInboxRead: () => Promise.reject(thrown) });

  const error = await assertRejects(() =>
    collect<MarkReadEvent>(
      markRead(createLibSwampContext(), deps, ["01JBX5Q8ZK0000000000000104"]),
    )
  );

  assertStrictEquals(error, thrown);
});
