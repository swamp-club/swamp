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
import {
  applyPollOutcome,
  type InboxNotice,
  noticeToShow,
  recordNoticeShown,
  shouldPoll,
} from "../../domain/inbox/inbox_policy.ts";
import type { InboxState } from "../../domain/inbox/inbox_state.ts";
import type { ClientIdentity } from "../../infrastructure/http/client_identity.ts";
import type { InboxSummaryResult } from "../../infrastructure/http/inbox_schemas.ts";
import { SwampClubClient } from "../../infrastructure/http/swamp_club_client.ts";
import { InboxCacheFileRepository } from "../../infrastructure/inbox/inbox_cache_file_repository.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import { processOwnsConfigDir } from "../../infrastructure/persistence/config_dir_ownership.ts";
import { toPollOutcome } from "./poll_outcome.ts";

const logger = getSwampLogger(["inbox", "notice"]);

/** How long the background inbox poll may take in all. */
export const INBOX_POLL_TIMEOUT_MS = 5_000;

/** How long teardown waits for a poll still running before it aborts it. */
export const INBOX_POLL_GRACE_MS = 250;

/** Dependencies for the background poll and the notice, injected for tests. */
export interface InboxNoticeDeps {
  loadCredentials: () => Promise<AuthCredentials | null>;
  inboxSummary: (
    serverUrl: string,
    apiKey: string,
    etag: string | null,
    signal: AbortSignal,
  ) => Promise<InboxSummaryResult>;
  loadInboxState: (fingerprint: string) => Promise<InboxState>;
  saveInboxState: (fingerprint: string, state: InboxState) => Promise<void>;
  /** Whether this process may write the swamp config directory. */
  ownsConfigDir: () => boolean;
  now: () => number;
  /**
   * Resolves after `ms`, or as soon as `signal` aborts. Never rejects, so a
   * wait cut short is not an error.
   */
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface CreateInboxNoticeDepsOptions {
  identity?: ClientIdentity;
}

function waitOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Wires real infrastructure into InboxNoticeDeps. */
export function createInboxNoticeDeps(
  options: CreateInboxNoticeDepsOptions = {},
): InboxNoticeDeps {
  const auth = new AuthRepository();
  const cache = new InboxCacheFileRepository();
  return {
    loadCredentials: () => auth.load(),
    inboxSummary: (serverUrl, apiKey, etag, signal) =>
      new SwampClubClient(serverUrl, options.identity).inboxSummary(
        apiKey,
        etag,
        signal,
      ),
    loadInboxState: (fingerprint) => cache.load(fingerprint),
    saveInboxState: (fingerprint, state) => cache.save(fingerprint, state),
    ownsConfigDir: processOwnsConfigDir,
    now: () => Date.now(),
    wait: waitOrAbort,
  };
}

interface ActiveKey {
  serverUrl: string;
  apiKey: string;
  fingerprint: string;
}

async function activeKey(deps: InboxNoticeDeps): Promise<ActiveKey | null> {
  const credentials = await deps.loadCredentials();
  // An empty key is the identity cache an env-key run leaves in auth.json:
  // no credential.
  if (!credentials?.apiKey) return null;
  return {
    serverUrl: credentials.serverUrl,
    apiKey: credentials.apiKey,
    fingerprint: await keyFingerprint(credentials.apiKey),
  };
}

/** A poll running alongside the command, settled once at teardown. */
export interface InboxPoll {
  /**
   * Waits up to {@link INBOX_POLL_GRACE_MS} more for the poll, aborts it if it
   * is still running, and saves its outcome to the key's cache. Never throws.
   */
  settle(): Promise<void>;
}

/**
 * Starts the inbox poll for the active key when one is due, or returns null.
 * Nothing is written until {@link InboxPoll.settle}, so a command that exits
 * early loses at most this one request. A process that cannot write the
 * config directory does not poll: it could not record the poll, so every run
 * would poll again. Never throws.
 */
export async function startInboxPoll(
  deps: InboxNoticeDeps,
): Promise<InboxPoll | null> {
  let key: ActiveKey | null;
  let state: InboxState;
  try {
    if (!deps.ownsConfigDir()) return null;
    key = await activeKey(deps);
    if (key === null) return null;
    state = await deps.loadInboxState(key.fingerprint);
    if (!shouldPoll(state, deps.now())) return null;
  } catch (error: unknown) {
    logger.debug`Could not start the inbox poll: ${error}`;
    return null;
  }
  const { serverUrl, apiKey, fingerprint } = key;

  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(INBOX_POLL_TIMEOUT_MS),
  ]);
  let done = false;
  let request: Promise<InboxSummaryResult>;
  try {
    request = deps.inboxSummary(
      serverUrl,
      apiKey,
      state.snapshot?.etag ?? null,
      signal,
    );
  } catch (error: unknown) {
    request = Promise.reject(error);
  }
  // Handled here, so the request can never reject unhandled before teardown
  // awaits it.
  const settled: Promise<InboxSummaryResult> = request
    .catch((error: unknown): InboxSummaryResult => ({
      kind: "failed",
      reason: error instanceof Error ? error.message : String(error),
    }))
    .finally(() => {
      done = true;
    });

  const settle = async (): Promise<void> => {
    const grace = new AbortController();
    const graceWait = deps.wait(INBOX_POLL_GRACE_MS, grace.signal);
    await Promise.race([settled, graceWait]);
    grace.abort();
    await graceWait;
    if (!done) controller.abort();
    const result = await settled;
    try {
      // Reloaded, not the state the poll started from: another command may
      // have saved this key's state since.
      const current = await deps.loadInboxState(fingerprint);
      await deps.saveInboxState(
        fingerprint,
        applyPollOutcome(current, toPollOutcome(result), deps.now()),
      );
    } catch (error: unknown) {
      logger.debug`Could not save the inbox poll: ${error}`;
    }
  };

  let settling: Promise<void> | undefined;
  return {
    settle: () => settling ??= settle(),
  };
}

/**
 * The notice to print after the command, from the cache alone: it never
 * contacts swamp-club. Records the notice as shown when this process may
 * write the config directory. Never throws.
 */
export async function showInboxNotice(
  deps: InboxNoticeDeps,
): Promise<InboxNotice | null> {
  try {
    const key = await activeKey(deps);
    if (key === null) return null;
    const state = await deps.loadInboxState(key.fingerprint);
    const now = deps.now();
    const notice = noticeToShow(state, now);
    if (notice === null) return null;
    if (deps.ownsConfigDir()) {
      try {
        await deps.saveInboxState(
          key.fingerprint,
          recordNoticeShown(state, now),
        );
      } catch (error: unknown) {
        logger.debug`Could not record the inbox notice: ${error}`;
      }
    }
    return notice;
  } catch (error: unknown) {
    logger.debug`Could not read the inbox cache: ${error}`;
    return null;
  }
}
