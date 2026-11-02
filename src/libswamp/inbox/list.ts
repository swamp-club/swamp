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

import type { AuthCredentials } from "../../domain/auth/auth_credentials.ts";
import type { ClientIdentity } from "../../infrastructure/http/client_identity.ts";
import {
  type InboxListOptions,
  type InboxMessage,
  type InboxMessagePage,
  type InboxReadStatus,
  isInboxMessageId,
} from "../../infrastructure/http/inbox_schemas.ts";
import { SwampClubClient } from "../../infrastructure/http/swamp_club_client.ts";
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import type { LibSwampContext } from "../context.ts";
import {
  cancelled,
  notAuthenticated,
  type SwampError,
  validationFailed,
} from "../errors.ts";

export const DEFAULT_INBOX_LIST_LIMIT = 20;
export const MAX_INBOX_LIST_LIMIT = 100;

export interface InboxListInput {
  all?: boolean;
  limit?: number;
  before?: string;
}

/** the body, link and action are the reading part, so they never reach the list. */
export interface InboxListItem {
  id: string;
  kind: string;
  title: string;
  createdAt: string;
  readAt: string | null;
}

export interface InboxListView {
  status: InboxReadStatus;
  messages: InboxListItem[];
  nextCursor: string | null;
  /** Entries Swamp Club sent that broke the inbox contract and were left out. */
  dropped: number;
}

export type InboxListEvent =
  | { kind: "loading_credentials" }
  | { kind: "contacting_server"; serverUrl: string }
  | { kind: "completed"; view: InboxListView }
  | { kind: "error"; error: SwampError };

export interface InboxListDeps {
  loadCredentials: () => Promise<AuthCredentials | null>;
  listMessages: (
    serverUrl: string,
    apiKey: string,
    options: InboxListOptions,
    signal: AbortSignal,
  ) => Promise<InboxMessagePage>;
  serverUrlOverride?: string;
}

export interface CreateInboxListDepsOptions {
  serverUrlOverride?: string;
  identity?: ClientIdentity;
}

export function createInboxListDeps(
  options: CreateInboxListDepsOptions = {},
): InboxListDeps {
  const repo = new AuthRepository();
  return {
    loadCredentials: () => repo.load(),
    listMessages: (serverUrl, apiKey, listOptions, signal) => {
      const client = new SwampClubClient(serverUrl, options.identity);
      return client.listInboxMessages(apiKey, listOptions, signal);
    },
    serverUrlOverride: options.serverUrlOverride,
  };
}

function refusal(input: InboxListInput): SwampError | undefined {
  const limit = input.limit;
  if (
    limit !== undefined &&
    (!Number.isInteger(limit) || limit < 1 || limit > MAX_INBOX_LIST_LIMIT)
  ) {
    return validationFailed(
      `--limit must be a whole number from 1 to ${MAX_INBOX_LIST_LIMIT}; got ${limit}.`,
    );
  }
  if (input.before !== undefined && !isInboxMessageId(input.before)) {
    return validationFailed(
      `--before must be a message id, such as the one a "To see older:" line names; got ${input.before}.`,
    );
  }
  return undefined;
}

function toView(
  status: InboxReadStatus,
  page: InboxMessagePage,
): InboxListView {
  return {
    status,
    // Built key by key, so the body, link and action never leave this file.
    messages: page.messages.map((m) => ({
      id: m.id,
      kind: m.kind,
      title: m.title,
      createdAt: m.createdAt,
      readAt: m.readAt,
    })),
    nextCursor: page.nextCursor,
    dropped: page.dropped,
  };
}

type InboxPageFetchEvent =
  | { kind: "loading_credentials" }
  | { kind: "contacting_server"; serverUrl: string }
  | { kind: "error"; error: SwampError };

/**
 * refused input never reaches the network; a client failure propagates as the
 * UserError the client threw.
 */
async function* fetchPage(
  ctx: LibSwampContext,
  deps: InboxListDeps,
  input: InboxListInput,
  status: InboxReadStatus,
): AsyncGenerator<InboxPageFetchEvent, InboxMessagePage | undefined> {
  const refused = refusal(input);
  if (refused) {
    yield { kind: "error", error: refused };
    return undefined;
  }

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

  try {
    return await deps.listMessages(
      serverUrl,
      credentials.apiKey,
      {
        status,
        // Always sent: the server's own default is larger than the CLI's.
        limit: input.limit ?? DEFAULT_INBOX_LIST_LIMIT,
        ...(input.before !== undefined
          ? { before: input.before.toUpperCase() }
          : {}),
      },
      ctx.signal,
    );
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") {
      yield { kind: "error", error: cancelled(error) };
      return undefined;
    }
    throw error;
  }
}

export async function* inboxList(
  ctx: LibSwampContext,
  deps: InboxListDeps,
  input: InboxListInput = {},
): AsyncIterable<InboxListEvent> {
  const status: InboxReadStatus = input.all ? "all" : "unread";
  const page = yield* fetchPage(ctx, deps, input, status);
  if (page) yield { kind: "completed", view: toView(status, page) };
}

export interface InboxMessageView {
  id: string;
  kind: string;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  /** An `https:` URL. */
  link?: string;
  /** A `swamp` command the message suggests; shown, never run. */
  action?: { label: string; command: string };
}

export interface InboxBrowseView {
  messages: InboxMessageView[];
  nextCursor: string | null;
  /** Entries Swamp Club sent that broke the inbox contract and were left out. */
  dropped: number;
}

export type InboxBrowseEvent =
  | { kind: "loading_credentials" }
  | { kind: "contacting_server"; serverUrl: string }
  | { kind: "completed"; view: InboxBrowseView }
  | { kind: "error"; error: SwampError };

export function toMessageView(m: InboxMessage): InboxMessageView {
  return {
    id: m.id,
    kind: m.kind,
    title: m.title,
    body: m.body,
    createdAt: m.createdAt,
    readAt: m.readAt,
    ...(m.link !== undefined ? { link: m.link } : {}),
    ...(m.action !== undefined
      ? { action: { label: m.action.label, command: m.action.command } }
      : {}),
  };
}

/**
 * read messages are always included so they can be opened again; marks nothing
 * read.
 */
export async function* inboxBrowse(
  ctx: LibSwampContext,
  deps: InboxListDeps,
  input: InboxListInput = {},
): AsyncIterable<InboxBrowseEvent> {
  const page = yield* fetchPage(ctx, deps, input, "all");
  if (!page) return;
  yield {
    kind: "completed",
    view: {
      messages: page.messages.map(toMessageView),
      nextCursor: page.nextCursor,
      dropped: page.dropped,
    },
  };
}
