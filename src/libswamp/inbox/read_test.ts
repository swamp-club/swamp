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
  createInboxMarkSession,
  inboxReadById,
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

const UNREAD_ID = "01JBX5Q8ZK00000000000000ZX";
const READ_ID = "01JBX5Q8ZK00000000000000ZP";

Deno.test("inboxReadById: an unread message is shown and marked", async () => {
  const { deps, rec } = makeDeps();

  const last = lastOf(
    await collect<InboxReadNextEvent>(
      inboxReadById(createLibSwampContext(), deps, UNREAD_ID),
    ),
  );

  assert(last.kind === "completed");
  assertEquals(last.view.message?.id, UNREAD_ID);
  assertEquals(last.view.message?.readAt, new Date(NOW).toISOString());
  assertEquals(last.view.marked, true);
  assertEquals(rec.got, [UNREAD_ID]);
  assertEquals(rec.marked, [[UNREAD_ID]]);
  assertEquals(rec.saved.length, 1);
});

Deno.test("inboxReadById: a read message is shown as read and nothing is marked", async () => {
  const { deps, rec } = makeDeps();

  const last = lastOf(
    await collect<InboxReadNextEvent>(
      inboxReadById(createLibSwampContext(), deps, READ_ID),
    ),
  );

  assert(last.kind === "completed");
  assertEquals(last.view.message?.id, READ_ID);
  assertEquals(last.view.message?.readAt, "2026-10-24T13:15:00.000Z");
  // Read already, so the renderer has nothing unconfirmed to warn about.
  assertEquals(last.view.marked, true);
  assertEquals(rec.marked, []);
  assertEquals(rec.summaries, 0);
});

Deno.test("inboxReadById: a lower-case id is fetched upper-case", async () => {
  const { deps, rec } = makeDeps();

  const last = lastOf(
    await collect<InboxReadNextEvent>(
      inboxReadById(createLibSwampContext(), deps, UNREAD_ID.toLowerCase()),
    ),
  );

  assert(last.kind === "completed");
  assertEquals(rec.got, [UNREAD_ID]);
  assertEquals(rec.marked, [[UNREAD_ID]]);
});

Deno.test("inboxReadById: an id that is not a ULID is refused with no request", async () => {
  let loaded = false;
  const { deps, rec } = makeDeps({
    loadCredentials: () => {
      loaded = true;
      return Promise.resolve(credentials);
    },
  });

  const events = await collect<InboxReadNextEvent>(
    inboxReadById(createLibSwampContext(), deps, "not-an-id"),
  );

  assertEquals(events.length, 1);
  const [only] = events;
  assert(only.kind === "error");
  assertEquals(only.error.code, "validation_failed");
  assertEquals(
    only.error.message,
    "Not a message id: not-an-id. Message ids are the 26-character ids swamp inbox prints.",
  );
  assertEquals(loaded, false);
  assertEquals(rec.got, []);
});

Deno.test("inboxReadById: an unknown id propagates the client's not-found error", async () => {
  const { deps, rec } = makeDeps();
  const unknown = "01JBX5Q8ZK0000000000000999";

  const error = await assertRejects(() =>
    collect<InboxReadNextEvent>(
      inboxReadById(createLibSwampContext(), deps, unknown),
    )
  );

  assert(error instanceof UserError);
  assertEquals(error.message, `Message ${unknown} not found.`);
  assertEquals(rec.marked, []);
});

Deno.test("inboxReadById: moreUnread counts unread messages other than this one", async () => {
  const cases: { page: InboxMessagePage; want: boolean }[] = [
    // The page holds this message and one other.
    { page: unreadPage, want: true },
    // Only this message, and nothing after it.
    {
      page: {
        messages: unreadPage.messages.filter((m) => m.id === UNREAD_ID),
        nextCursor: null,
        dropped: 0,
      },
      want: false,
    },
    // Only this message, with a later page.
    {
      page: {
        messages: unreadPage.messages.filter((m) => m.id === UNREAD_ID),
        nextCursor: UNREAD_ID,
        dropped: 0,
      },
      want: true,
    },
    // Only this message, and an entry the client left out.
    {
      page: {
        messages: unreadPage.messages.filter((m) => m.id === UNREAD_ID),
        nextCursor: null,
        dropped: 1,
      },
      want: true,
    },
  ];
  for (const { page, want } of cases) {
    const { deps, rec } = makeDeps({ page });

    const last = lastOf(
      await collect<InboxReadNextEvent>(
        inboxReadById(createLibSwampContext(), deps, UNREAD_ID),
      ),
    );

    assert(last.kind === "completed");
    assertEquals(last.view.moreUnread, want);
    assertEquals(last.view.dropped, page.dropped);
    assertEquals(rec.listed, [{ status: "unread", limit: 2 }]);
  }
});

Deno.test("inboxReadById: an id swamp-club does not confirm stays unread", async () => {
  const { deps } = makeDeps({ markInboxRead: () => Promise.resolve([]) });

  const last = lastOf(
    await collect<InboxReadNextEvent>(
      inboxReadById(createLibSwampContext(), deps, UNREAD_ID),
    ),
  );

  assert(last.kind === "completed");
  assertEquals(last.view.marked, false);
  assertEquals(last.view.message?.readAt, null);
});

Deno.test("inboxReadById: the view has the same keys as inboxReadNext's", async () => {
  const byId = lastOf(
    await collect<InboxReadNextEvent>(
      // The message inboxReadNext reads, so the optional fields match.
      inboxReadById(
        createLibSwampContext(),
        makeDeps().deps,
        "01JBX5Q8ZK0000000000000104",
      ),
    ),
  );
  const next = lastOf(
    await collect<InboxReadNextEvent>(
      inboxReadNext(createLibSwampContext(), makeDeps().deps),
    ),
  );

  assert(byId.kind === "completed" && next.kind === "completed");
  assertEquals(Object.keys(byId.view).sort(), Object.keys(next.view).sort());
  assertEquals(
    Object.keys(byId.view.message ?? {}).sort(),
    Object.keys(next.view.message ?? {}).sort(),
  );
});

Deno.test("inboxReadById: not signed in is notAuthenticated, with no call", async () => {
  const { deps, rec } = makeDeps({ credentials: null });

  const last = lastOf(
    await collect<InboxReadNextEvent>(
      inboxReadById(createLibSwampContext(), deps, UNREAD_ID),
    ),
  );

  assert(last.kind === "error");
  assertEquals(last.error.code, "not_authenticated");
  assertEquals(rec.got, []);
});

Deno.test("createInboxMarkSession: sends each mark in order and refreshes the cache once at finish", async () => {
  const { deps, rec } = makeDeps();
  const session = createInboxMarkSession(createLibSwampContext(), deps);

  const first = session.mark([UNREAD_ID]);
  const second = session.mark(["01JBX5Q8ZK0000000000000104"]);

  assertEquals(await first, { kind: "confirmed", ids: [UNREAD_ID] });
  assertEquals(await second, {
    kind: "confirmed",
    ids: ["01JBX5Q8ZK0000000000000104"],
  });
  assertEquals(rec.marked, [[UNREAD_ID], ["01JBX5Q8ZK0000000000000104"]]);
  assertEquals(rec.summaries, 0);

  await session.finish();

  assertEquals(rec.summaries, 1);
  assertEquals(rec.saved.length, 1);
});

Deno.test("createInboxMarkSession: a later request waits for the one before it", async () => {
  const order: string[] = [];
  let release: (() => void) | undefined;
  const { deps } = makeDeps({
    markInboxRead: async (_url, _key, ids) => {
      order.push(`start ${ids[0]}`);
      if (ids[0] === "A") {
        await new Promise<void>((resolve) => release = resolve);
      }
      order.push(`end ${ids[0]}`);
      return [...ids];
    },
  });
  const session = createInboxMarkSession(createLibSwampContext(), deps);

  const first = session.mark(["A"]);
  const second = session.mark(["B"]);
  await waitForRelease(() => release);
  release?.();
  await Promise.all([first, second]);

  assertEquals(order, ["start A", "end A", "start B", "end B"]);
  await session.finish();
});

/** Waits until the stubbed request has parked its resolver. */
async function waitForRelease(get: () => (() => void) | undefined) {
  for (let i = 0; i < 100 && get() === undefined; i++) {
    await Promise.resolve();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }
  assert(get() !== undefined);
}

Deno.test("createInboxMarkSession: a failed request is a result, and later marks still run", async () => {
  let calls = 0;
  const { deps, rec } = makeDeps({
    markInboxRead: (_url, _key, ids) => {
      calls++;
      return calls === 1
        ? Promise.reject(new UserError("Swamp Club is unavailable."))
        : Promise.resolve([...ids]);
    },
  });
  const session = createInboxMarkSession(createLibSwampContext(), deps);

  assertEquals(await session.mark([UNREAD_ID]), {
    kind: "failed",
    reason: "Swamp Club is unavailable.",
    ids: [],
  });
  assertEquals(await session.mark([UNREAD_ID]), {
    kind: "confirmed",
    ids: [UNREAD_ID],
  });
  await session.finish();
  assertEquals(rec.summaries, 1);
});

Deno.test("createInboxMarkSession: a request sent with nothing confirmed still refreshes", async () => {
  const { deps, rec } = makeDeps({ markInboxRead: () => Promise.resolve([]) });
  const session = createInboxMarkSession(createLibSwampContext(), deps);

  assertEquals(await session.mark([UNREAD_ID]), { kind: "confirmed", ids: [] });
  await session.finish();

  assertEquals(rec.summaries, 1);
});

Deno.test("createInboxMarkSession: a failed request keeps the ids confirmed before it failed, and refreshes", async () => {
  const { deps, rec } = makeDeps({
    markInboxRead: (_url, _key, ids, _signal, onConfirmed) => {
      onConfirmed?.([ids[0]]);
      return Promise.reject(new UserError("Swamp Club is unavailable."));
    },
  });
  const session = createInboxMarkSession(createLibSwampContext(), deps);

  assertEquals(await session.mark([UNREAD_ID, READ_ID]), {
    kind: "failed",
    reason: "Swamp Club is unavailable.",
    ids: [UNREAD_ID],
  });
  await session.finish();

  assertEquals(rec.summaries, 1);
});

Deno.test("createInboxMarkSession: a request that failed with nothing confirmed still refreshes", async () => {
  const { deps, rec } = makeDeps({
    markInboxRead: () =>
      Promise.reject(new UserError("Swamp Club is unavailable.")),
  });
  const session = createInboxMarkSession(createLibSwampContext(), deps);

  assertEquals((await session.mark([UNREAD_ID])).kind, "failed");
  await session.finish();

  assertEquals(rec.summaries, 1);
});

Deno.test("createInboxMarkSession: finish with no marks loads no credentials", async () => {
  let loaded = false;
  const { deps, rec } = makeDeps({
    loadCredentials: () => {
      loaded = true;
      return Promise.resolve(credentials);
    },
  });

  await createInboxMarkSession(createLibSwampContext(), deps).finish();

  assertEquals(loaded, false);
  assertEquals(rec.summaries, 0);
});

Deno.test("createInboxMarkSession: finish aborts a request still running at the bound", async () => {
  let aborted = false;
  const { deps, rec } = makeDeps({
    markInboxRead: (_url, _key, _ids, signal) =>
      new Promise<string[]>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
  });
  const session = createInboxMarkSession(createLibSwampContext(), deps, {
    finishTimeoutMs: 0,
  });

  const pending = session.mark([UNREAD_ID]);
  await session.finish();

  assertEquals(aborted, true);
  assertEquals(await pending, { kind: "failed", reason: "cancelled", ids: [] });
  // The request may have been applied before the abort.
  assertEquals(rec.summaries, 1);
});

Deno.test("createInboxMarkSession: not signed in fails the mark with the sign-in hint", async () => {
  const { deps, rec } = makeDeps({ credentials: null });
  const session = createInboxMarkSession(createLibSwampContext(), deps);

  const outcome = await session.mark([UNREAD_ID]);

  assert(outcome.kind === "failed");
  assertEquals(
    outcome.reason,
    "Not authenticated. Run 'swamp auth login' to sign in.",
  );
  assertEquals(rec.marked, []);
  await session.finish();
  assertEquals(rec.summaries, 0);
});
