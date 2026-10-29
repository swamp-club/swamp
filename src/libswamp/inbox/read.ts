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
  type AuthCredentials,
  keyFingerprint,
} from "../../domain/auth/auth_credentials.ts";
import { applyPollOutcome } from "../../domain/inbox/inbox_policy.ts";
import {
  InboxCacheKey,
  type InboxState,
} from "../../domain/inbox/inbox_state.ts";
import type { ClientIdentity } from "../../infrastructure/http/client_identity.ts";
import {
  type InboxMessage,
  type InboxSummaryResult,
  isInboxMessageId,
} from "../../infrastructure/http/inbox_schemas.ts";
import { SwampClubClient } from "../../infrastructure/http/swamp_club_client.ts";
import { InboxCacheFileRepository } from "../../infrastructure/inbox/inbox_cache_file_repository.ts";
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import { processOwnsConfigDir } from "../../infrastructure/persistence/config_dir_ownership.ts";
import type { LibSwampContext } from "../context.ts";
import {
  cancelled,
  notAuthenticated,
  type SwampError,
  validationFailed,
} from "../errors.ts";
import {
  type InboxListDeps,
  type InboxMessageView,
  toMessageView,
} from "./list.ts";
import { toPollOutcome } from "./poll_outcome.ts";

/**
 * How many pages of unread messages `inbox read` lists while every entry on
 * them breaks the contract, before it reports nothing to read.
 */
export const MAX_INBOX_READ_PAGES = 5;

/**
 * How long a summary call made while reading may take: the one that finds
 * the message the notice announced, and the one that follows marking read.
 * Either falls back when it runs out, so this only bounds the wait.
 */
export const INBOX_REFRESH_TIMEOUT_MS = 5_000;

/** Dependencies for reading and marking inbox messages, injected for tests. */
export interface InboxReadDeps {
  loadCredentials: () => Promise<AuthCredentials | null>;
  listMessages: InboxListDeps["listMessages"];
  /** The requested ids swamp-club confirmed as read. */
  markInboxRead: (
    serverUrl: string,
    apiKey: string,
    ids: readonly string[],
    signal: AbortSignal,
  ) => Promise<string[]>;
  getInboxMessage: (
    serverUrl: string,
    apiKey: string,
    id: string,
    signal: AbortSignal,
  ) => Promise<InboxMessage>;
  inboxSummary: (
    serverUrl: string,
    apiKey: string,
    signal: AbortSignal,
  ) => Promise<InboxSummaryResult>;
  loadInboxState: (key: InboxCacheKey) => Promise<InboxState>;
  saveInboxState: (key: InboxCacheKey, state: InboxState) => Promise<void>;
  /** Whether this process may write the swamp config directory. */
  ownsConfigDir: () => boolean;
  now: () => number;
  serverUrlOverride?: string;
}

export interface CreateInboxReadDepsOptions {
  serverUrlOverride?: string;
  identity?: ClientIdentity;
}

/** Wires real infrastructure into InboxReadDeps. */
export function createInboxReadDeps(
  options: CreateInboxReadDepsOptions = {},
): InboxReadDeps {
  const auth = new AuthRepository();
  const cache = new InboxCacheFileRepository();
  const client = (serverUrl: string) =>
    new SwampClubClient(serverUrl, options.identity);
  return {
    loadCredentials: () => auth.load(),
    listMessages: (serverUrl, apiKey, listOptions, signal) =>
      client(serverUrl).listInboxMessages(apiKey, listOptions, signal),
    markInboxRead: (serverUrl, apiKey, ids, signal) =>
      client(serverUrl).markInboxRead(apiKey, ids, signal),
    getInboxMessage: (serverUrl, apiKey, id, signal) =>
      client(serverUrl).getInboxMessage(apiKey, id, signal),
    // No etag: a 304 would keep the unread count from before the marking.
    inboxSummary: (serverUrl, apiKey, signal) =>
      client(serverUrl).inboxSummary(apiKey, null, signal),
    loadInboxState: (key) => cache.load(key),
    saveInboxState: (key, state) => cache.save(key, state),
    ownsConfigDir: processOwnsConfigDir,
    now: () => Date.now(),
    serverUrlOverride: options.serverUrlOverride,
  };
}

export type MarkReadEvent =
  | { kind: "loading_credentials" }
  | { kind: "contacting_server"; serverUrl: string }
  | { kind: "completed"; marked: string[] }
  | { kind: "error"; error: SwampError };

export interface InboxReadNextView {
  /**
   * The message the notice announced, or else the newest unread message, now
   * read; null when nothing was unread.
   */
  message: InboxMessageView | null;
  /**
   * Whether the message is read now: swamp-club confirmed marking it, or it
   * was already read.
   */
  marked: boolean;
  /** Whether more unread messages are waiting after this one. */
  moreUnread: boolean;
  /** Entries Swamp Club sent that broke the inbox contract and were left out. */
  dropped: number;
}

export type InboxReadNextEvent =
  | { kind: "loading_credentials" }
  | { kind: "contacting_server"; serverUrl: string }
  | { kind: "completed"; view: InboxReadNextView }
  | { kind: "error"; error: SwampError };

interface Session {
  serverUrl: string;
  apiKey: string;
}

async function* openSession(
  deps: InboxReadDeps,
): AsyncGenerator<
  | { kind: "loading_credentials" }
  | { kind: "contacting_server"; serverUrl: string }
  | { kind: "error"; error: SwampError },
  Session | undefined
> {
  yield { kind: "loading_credentials" };
  const credentials = await deps.loadCredentials();
  // An empty key is the identity cache older versions left in auth.json
  // after an env-key run: no credential, not a revoked one.
  if (!credentials?.apiKey) {
    yield { kind: "error", error: notAuthenticated() };
    return undefined;
  }
  const serverUrl = deps.serverUrlOverride ?? credentials.serverUrl;
  yield { kind: "contacting_server", serverUrl };
  return { serverUrl, apiKey: credentials.apiKey };
}

function isAbort(error: unknown): error is DOMException {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * Asks for the unread summary, with no ETag, and stores the answer in the
 * key's inbox cache for the server it asked when this process owns the
 * config dir. Never throws: null when no answer came, and a cache that
 * cannot be written is left as it was.
 */
async function askSummary(
  ctx: LibSwampContext,
  deps: InboxReadDeps,
  session: Session,
): Promise<InboxSummaryResult | null> {
  try {
    const sentAt = deps.now();
    const result = await deps.inboxSummary(
      session.serverUrl,
      session.apiKey,
      ctx.withTimeout(INBOX_REFRESH_TIMEOUT_MS).signal,
    );
    // A failed call is not a poll: recording it would put the next real
    // poll off, and leave the notice up for longer.
    if (result.kind === "failed") {
      ctx.logger.debug`Inbox summary failed: ${result.reason}`;
      return result;
    }
    if (deps.ownsConfigDir()) {
      try {
        const key = InboxCacheKey.of(
          session.serverUrl,
          await keyFingerprint(session.apiKey),
        );
        const state = await deps.loadInboxState(key);
        await deps.saveInboxState(
          key,
          applyPollOutcome(state, toPollOutcome(result, sentAt), deps.now()),
        );
      } catch (error: unknown) {
        ctx.logger.debug`Could not update the inbox cache: ${error}`;
      }
    }
    return result;
  } catch (error: unknown) {
    ctx.logger.debug`Could not ask for the inbox summary: ${error}`;
    return null;
  }
}

/**
 * Asks for the unread count once more after marking read, so the notice
 * stops now rather than at the next poll. Never throws: the messages are
 * already read, and the next poll corrects the cache.
 */
async function refreshInboxCache(
  ctx: LibSwampContext,
  deps: InboxReadDeps,
  session: Session,
): Promise<void> {
  if (!deps.ownsConfigDir()) return;
  await askSummary(ctx, deps, session);
}

/** The id of the message the notice announced; null when the summary gave none. */
async function announcedMessageId(
  ctx: LibSwampContext,
  deps: InboxReadDeps,
  session: Session,
): Promise<string | null> {
  const result = await askSummary(ctx, deps, session);
  return result?.kind === "ok" ? result.summary.newestId : null;
}

/**
 * The message the notice announced, while it is still unread. Null when the
 * summary named none, or the message is gone, read, or one this client
 * refuses: the caller then reads the newest unread message instead. Only an
 * abort propagates.
 */
async function announcedUnread(
  ctx: LibSwampContext,
  deps: InboxReadDeps,
  session: Session,
): Promise<InboxMessage | null> {
  const id = await announcedMessageId(ctx, deps, session);
  if (id === null) return null;
  try {
    const message = await deps.getInboxMessage(
      session.serverUrl,
      session.apiKey,
      id,
      ctx.signal,
    );
    return message.readAt === null ? message : null;
  } catch (error: unknown) {
    if (isAbort(error)) throw error;
    ctx.logger
      .debug`Could not fetch the announced inbox message ${id}: ${error}`;
    return null;
  }
}

async function markAndRefresh(
  ctx: LibSwampContext,
  deps: InboxReadDeps,
  session: Session,
  ids: readonly string[],
): Promise<string[]> {
  const marked = await deps.markInboxRead(
    session.serverUrl,
    session.apiKey,
    ids,
    ctx.signal,
  );
  await refreshInboxCache(ctx, deps, session);
  return marked;
}

/**
 * Marks exactly these messages read, then refreshes the inbox cache. With no
 * ids it completes at once, with no request. A client failure propagates as
 * the UserError the client threw.
 */
export async function* markRead(
  ctx: LibSwampContext,
  deps: InboxReadDeps,
  ids: readonly string[],
): AsyncIterable<MarkReadEvent> {
  if (ids.length === 0) {
    yield { kind: "completed", marked: [] };
    return;
  }
  const session = yield* openSession(deps);
  if (!session) return;
  try {
    const marked = await markAndRefresh(ctx, deps, session, ids);
    yield { kind: "completed", marked };
  } catch (error: unknown) {
    if (isAbort(error)) {
      yield { kind: "error", error: cancelled(error) };
      return;
    }
    throw error;
  }
}

/**
 * Reads the message the notice announced, or else the newest unread message:
 * fetches it and marks it read. Reading the announced message first lets the
 * notice stop at once, even when newer messages that never raise it, such as
 * mentions, are waiting. The message is marked before it is shown, so a run
 * killed in between leaves it read but unseen; `swamp inbox --all` lists it,
 * and `swamp inbox read <id>` shows it.
 */
export async function* inboxReadNext(
  ctx: LibSwampContext,
  deps: InboxReadDeps,
): AsyncIterable<InboxReadNextEvent> {
  const session = yield* openSession(deps);
  if (!session) return;
  try {
    const announced = await announcedUnread(ctx, deps, session);
    // Two, so the second tells whether more are waiting. A page whose
    // entries were all dropped says nothing about what lies behind it, so
    // listing goes on past it, a few pages at most.
    let page = await deps.listMessages(
      session.serverUrl,
      session.apiKey,
      { status: "unread", limit: 2 },
      ctx.signal,
    );
    let dropped = page.dropped;
    // With the announced message in hand, the first page already says
    // whether more are waiting.
    for (
      let pages = 1;
      announced === null && page.messages.length === 0 &&
      page.nextCursor !== null &&
      pages < MAX_INBOX_READ_PAGES;
      pages++
    ) {
      page = await deps.listMessages(
        session.serverUrl,
        session.apiKey,
        { status: "unread", limit: 2, before: page.nextCursor },
        ctx.signal,
      );
      dropped += page.dropped;
    }
    const shown = announced ?? page.messages[0];
    if (shown === undefined) {
      yield {
        kind: "completed",
        view: {
          message: null,
          marked: false,
          // Listing stopped at the page cap with older messages left.
          moreUnread: page.nextCursor !== null,
          dropped,
        },
      };
      return;
    }
    const shownId = shown.id.toUpperCase();
    const confirmed = await markAndRefresh(ctx, deps, session, [shown.id]);
    const marked = confirmed.some((id) => id.toUpperCase() === shownId);
    yield {
      kind: "completed",
      view: {
        // The read endpoint returns ids only, so readAt is this CLI's clock.
        message: {
          ...toMessageView(shown),
          readAt: marked ? new Date(deps.now()).toISOString() : null,
        },
        marked,
        // A dropped entry is an unread message this CLI could not show.
        moreUnread: page.messages.some((m) => m.id.toUpperCase() !== shownId) ||
          page.nextCursor !== null || dropped > 0,
        dropped,
      },
    };
  } catch (error: unknown) {
    if (isAbort(error)) {
      yield { kind: "error", error: cancelled(error) };
      return;
    }
    throw error;
  }
}

/** The refusal for an id that is not a message id. */
function notAMessageId(id: string): SwampError {
  return validationFailed(
    `Not a message id: ${id}. Message ids are the 26-character ids swamp inbox prints.`,
  );
}

/**
 * Reads one message by its id: fetches it and, when it is unread, marks it
 * read. A message already read is shown again and nothing is sent. An id
 * that is not a ULID is refused before any request; an unknown one, or
 * someone else's, propagates as the client's UserError.
 */
export async function* inboxReadById(
  ctx: LibSwampContext,
  deps: InboxReadDeps,
  id: string,
): AsyncIterable<InboxReadNextEvent> {
  if (!isInboxMessageId(id)) {
    yield { kind: "error", error: notAMessageId(id) };
    return;
  }
  const session = yield* openSession(deps);
  if (!session) return;
  const messageId = id.toUpperCase();
  try {
    const message = await deps.getInboxMessage(
      session.serverUrl,
      session.apiKey,
      messageId,
      ctx.signal,
    );
    // Two, so one other than this message tells whether more are waiting.
    const page = await deps.listMessages(
      session.serverUrl,
      session.apiKey,
      { status: "unread", limit: 2 },
      ctx.signal,
    );
    // A dropped entry is an unread message this CLI could not show.
    const moreUnread = page.messages.some((m) =>
      m.id.toUpperCase() !== messageId
    ) ||
      page.nextCursor !== null || page.dropped > 0;
    if (message.readAt !== null) {
      yield {
        kind: "completed",
        view: {
          message: toMessageView(message),
          marked: true,
          moreUnread,
          dropped: page.dropped,
        },
      };
      return;
    }
    const confirmed = await markAndRefresh(ctx, deps, session, [messageId]);
    const marked = confirmed.some((c) => c.toUpperCase() === messageId);
    yield {
      kind: "completed",
      view: {
        // The read endpoint returns ids only, so readAt is this CLI's clock.
        message: {
          ...toMessageView(message),
          readAt: marked ? new Date(deps.now()).toISOString() : null,
        },
        marked,
        moreUnread,
        dropped: page.dropped,
      },
    };
  } catch (error: unknown) {
    if (isAbort(error)) {
      yield { kind: "error", error: cancelled(error) };
      return;
    }
    throw error;
  }
}

/** What one mark request came to. */
export type InboxMarkOutcome =
  | { kind: "confirmed"; ids: string[] }
  | { kind: "failed"; reason: string };

/**
 * Marks messages read while the inbox stays open. Requests reach Swamp Club
 * one at a time, in the order they were made, and the cache is refreshed
 * once, by `finish`.
 */
export interface InboxMarkSession {
  /**
   * Marks exactly these ids read. Resolves to the ids swamp-club confirmed,
   * or why the request failed; never rejects.
   */
  mark(ids: readonly string[]): Promise<InboxMarkOutcome>;
  /**
   * Waits for the requests still in flight, for at most `finishTimeoutMs`,
   * aborts any left, then refreshes the inbox cache once if anything was
   * confirmed. Never rejects.
   */
  finish(): Promise<void>;
}

export interface InboxMarkSessionOptions {
  /** How long `finish` waits for requests still in flight. */
  finishTimeoutMs?: number;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class InboxMarkSessionImpl implements InboxMarkSession {
  private readonly controller = new AbortController();
  private readonly requestCtx: LibSwampContext;
  private session: Promise<Session | SwampError> | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private confirmedAny = false;

  constructor(
    private readonly ctx: LibSwampContext,
    private readonly deps: InboxReadDeps,
    private readonly finishTimeoutMs: number,
  ) {
    this.requestCtx = ctx.withSignal(this.controller.signal);
  }

  mark(ids: readonly string[]): Promise<InboxMarkOutcome> {
    const run = this.tail.then(() => this.send([...ids]));
    this.tail = run;
    return run;
  }

  async finish(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.finishTimeoutMs);
    });
    await Promise.race([this.tail, bound]);
    clearTimeout(timer);
    // Whatever is still running is abandoned, and settles once aborted.
    this.controller.abort();
    await this.tail;
    if (!this.confirmedAny || this.session === undefined) return;
    const session = await this.session;
    if ("apiKey" in session) {
      await refreshInboxCache(this.ctx, this.deps, session);
    }
  }

  private openOnce(): Promise<Session | SwampError> {
    this.session ??= (async () => {
      const credentials = await this.deps.loadCredentials();
      // An empty key is the identity cache older versions left in
      // auth.json after an env-key run: no credential, not a revoked one.
      if (!credentials?.apiKey) return notAuthenticated();
      return {
        serverUrl: this.deps.serverUrlOverride ?? credentials.serverUrl,
        apiKey: credentials.apiKey,
      };
    })();
    return this.session;
  }

  private async send(ids: string[]): Promise<InboxMarkOutcome> {
    if (ids.length === 0) return { kind: "confirmed", ids: [] };
    try {
      const session = await this.openOnce();
      if (!("apiKey" in session)) {
        return { kind: "failed", reason: session.message };
      }
      const confirmed = await this.deps.markInboxRead(
        session.serverUrl,
        session.apiKey,
        ids,
        this.requestCtx.signal,
      );
      if (confirmed.length > 0) this.confirmedAny = true;
      return { kind: "confirmed", ids: confirmed };
    } catch (error: unknown) {
      return {
        kind: "failed",
        reason: isAbort(error) ? "cancelled" : reasonOf(error),
      };
    }
  }
}

/** Starts a mark session; credentials load with the first request. */
export function createInboxMarkSession(
  ctx: LibSwampContext,
  deps: InboxReadDeps,
  options: InboxMarkSessionOptions = {},
): InboxMarkSession {
  return new InboxMarkSessionImpl(
    ctx,
    deps,
    options.finishTimeoutMs ?? INBOX_REFRESH_TIMEOUT_MS,
  );
}
