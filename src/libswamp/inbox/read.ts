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

export const MAX_INBOX_READ_PAGES = 5;

/** either call falls back when it runs out, so this only bounds the wait. */
export const INBOX_REFRESH_TIMEOUT_MS = 5_000;

export interface InboxReadDeps {
  loadCredentials: () => Promise<AuthCredentials | null>;
  listMessages: InboxListDeps["listMessages"];
  /**
   * onConfirmed is given each batch's confirmed ids as it is answered, before
   * any later throw.
   */
  markInboxRead: (
    serverUrl: string,
    apiKey: string,
    ids: readonly string[],
    signal: AbortSignal,
    onConfirmed?: (ids: string[]) => void,
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
  ownsConfigDir: () => boolean;
  now: () => number;
  serverUrlOverride?: string;
}

export interface CreateInboxReadDepsOptions {
  serverUrlOverride?: string;
  identity?: ClientIdentity;
}

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
    markInboxRead: (serverUrl, apiKey, ids, signal, onConfirmed) =>
      client(serverUrl).markInboxRead(apiKey, ids, signal, onConfirmed),
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

export interface InboxReadNextView {
  message: InboxMessageView | null;
  marked: boolean;
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
 * asks with no ETag and stores the answer in the key's inbox cache when this
 * process owns the config dir. Never throws: null when no answer came, and an
 * unwritable cache is left as it was.
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
 * so the notice stops now rather than at the next poll. Never throws: the
 * messages are already read, and the next poll corrects the cache.
 */
async function refreshInboxCache(
  ctx: LibSwampContext,
  deps: InboxReadDeps,
  session: Session,
): Promise<void> {
  if (!deps.ownsConfigDir()) return;
  await askSummary(ctx, deps, session);
}

async function announcedMessageId(
  ctx: LibSwampContext,
  deps: InboxReadDeps,
  session: Session,
): Promise<string | null> {
  const result = await askSummary(ctx, deps, session);
  return result?.kind === "ok" ? result.summary.newestId : null;
}

/**
 * null when the summary named none, or the message is gone, read or refused:
 * the caller then reads the newest unread message. Only an abort propagates.
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
 * reading the announced message first lets the notice stop at once even when
 * newer messages that never raise it are waiting. It is marked before it is
 * shown, so a killed run leaves it read but unseen.
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

function notAMessageId(id: string): SwampError {
  return validationFailed(
    `Not a message id: ${id}. Message ids are the 26-character ids swamp inbox prints.`,
  );
}

/**
 * a message already read is shown again and nothing is sent. A non-ULID id is
 * refused before any request; an unknown one, or someone else's, propagates as
 * the client's UserError.
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

/**
 * What one mark request came to. A failed request may have been partly
 * applied: `ids` are the ones swamp-club confirmed before it failed.
 */
export type InboxMarkOutcome =
  | { kind: "confirmed"; ids: string[] }
  | { kind: "failed"; reason: string; ids: string[] };

/**
 * requests reach Swamp Club one at a time, in the order made; the cache is
 * refreshed once, by finish.
 */
export interface InboxMarkSession {
  mark(ids: readonly string[]): Promise<InboxMarkOutcome>;
  /**
   * Waits for the requests still in flight, for at most `finishTimeoutMs`,
   * aborts any left, then refreshes the inbox cache once if any request was
   * sent: one that failed or was aborted may still have been applied.
   * Never rejects.
   */
  finish(): Promise<void>;
}

export interface InboxMarkSessionOptions {
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
  private sentAny = false;

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
    if (!this.sentAny || this.session === undefined) return;
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
    const confirmed: string[] = [];
    try {
      const session = await this.openOnce();
      if (!("apiKey" in session)) {
        return { kind: "failed", reason: session.message, ids: [] };
      }
      // A mark queued behind one finish() aborted is never sent.
      if (!this.requestCtx.signal.aborted) this.sentAny = true;
      return {
        kind: "confirmed",
        ids: await this.deps.markInboxRead(
          session.serverUrl,
          session.apiKey,
          ids,
          this.requestCtx.signal,
          (batch) => {
            for (const id of batch) confirmed.push(id);
          },
        ),
      };
    } catch (error: unknown) {
      return {
        kind: "failed",
        reason: isAbort(error) ? "cancelled" : reasonOf(error),
        ids: confirmed,
      };
    }
  }
}

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
