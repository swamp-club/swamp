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
import type { AccountNotice } from "../../domain/account_notices/account_notice.ts";
import {
  applyPollOutcome,
  daysLeft,
  effectiveNotices,
  noticeToShow,
  recordNoticeShown,
  shouldPoll,
} from "../../domain/account_notices/account_notice_policy.ts";
import type { AccountNoticeState } from "../../domain/account_notices/account_notice_state.ts";
import { InboxCacheKey } from "../../domain/inbox/inbox_state.ts";
import type { AccountNoticesResult } from "../../infrastructure/http/account_notice_schemas.ts";
import type { ClientIdentity } from "../../infrastructure/http/client_identity.ts";
import { SwampClubClient } from "../../infrastructure/http/swamp_club_client.ts";
import { AccountNoticeCacheFileRepository } from "../../infrastructure/account_notices/account_notice_cache_file_repository.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import { processOwnsConfigDir } from "../../infrastructure/persistence/config_dir_ownership.ts";
import { waitOrAbort } from "../inbox/notice.ts";
import { toPollOutcome } from "./poll_outcome.ts";

const logger = getSwampLogger(["account", "notices"]);

export const ACCOUNT_NOTICE_POLL_TIMEOUT_MS = 5_000;

export const ACCOUNT_NOTICE_POLL_GRACE_MS = 250;

// a fast command polls only to clear an ended trial, so it waits longer for it
export const ACCOUNT_NOTICE_FAST_POLL_GRACE_MS = 1_500;

export const ACCOUNT_NOTICE_REFRESH_TIMEOUT_MS = 3_000;

export interface AccountNoticeDeps {
  loadCredentials: () => Promise<AuthCredentials | null>;
  accountNotices: (
    serverUrl: string,
    apiKey: string,
    signal: AbortSignal,
  ) => Promise<AccountNoticesResult>;
  loadState: (key: InboxCacheKey) => Promise<AccountNoticeState>;
  saveState: (key: InboxCacheKey, state: AccountNoticeState) => Promise<void>;
  // never rejects
  configDirWritable: () => Promise<boolean>;
  now: () => number;
  // never rejects, so a wait cut short is not an error
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface CreateAccountNoticeDepsOptions {
  identity?: ClientIdentity;
  configDir?: string;
}

export function createAccountNoticeDeps(
  options: CreateAccountNoticeDepsOptions = {},
): AccountNoticeDeps {
  const auth = new AuthRepository(
    options.configDir ? { configDir: options.configDir } : undefined,
  );
  // built on first use: resolving the config dir throws without a home dir
  let cacheRepository: AccountNoticeCacheFileRepository | undefined;
  const cache = () =>
    cacheRepository ??= new AccountNoticeCacheFileRepository(
      options.configDir,
    );
  return {
    loadCredentials: () => auth.load(),
    accountNotices: (serverUrl, apiKey, signal) =>
      new SwampClubClient(serverUrl, options.identity).accountNotices(
        apiKey,
        signal,
      ),
    loadState: (key) => cache().load(key),
    saveState: (key, state) => cache().save(key, state),
    configDirWritable: async () => {
      try {
        return processOwnsConfigDir() && await cache().canWrite();
      } catch {
        return false;
      }
    },
    now: () => Date.now(),
    wait: waitOrAbort,
  };
}

interface ActiveKey {
  serverUrl: string;
  apiKey: string;
  cacheKey: InboxCacheKey;
}

// throws when the server URL does not parse
async function activeKey(deps: AccountNoticeDeps): Promise<ActiveKey | null> {
  const credentials = await deps.loadCredentials();
  // an empty key is the identity cache older versions left in auth.json
  if (!credentials?.apiKey) return null;
  return {
    serverUrl: credentials.serverUrl,
    apiKey: credentials.apiKey,
    cacheKey: InboxCacheKey.of(
      credentials.serverUrl,
      await keyFingerprint(credentials.apiKey),
    ),
  };
}

export interface AccountNoticeView {
  kind: AccountNotice["kind"];
  slug: string;
  name: string;
  personal: boolean;
  billingUrl: string;
  endsAt?: string;
  daysRemaining?: number;
}

// never another host: the server's path on the configured server, or swamp's
function billingUrlFor(serverUrl: string, notice: AccountNotice): string {
  const base = serverUrl.replace(/\/+$/, "");
  if (notice.billingPath !== null) return `${base}${notice.billingPath}`;
  return notice.collective.personal
    ? `${base}/billing`
    : `${base}/o/${encodeURIComponent(notice.collective.slug)}/billing`;
}

function toView(
  serverUrl: string,
  notice: AccountNotice,
  now: number,
): AccountNoticeView {
  const { slug, name, personal } = notice.collective;
  return {
    kind: notice.kind,
    slug,
    name,
    personal,
    billingUrl: billingUrlFor(serverUrl, notice),
    ...(notice.kind === "trial-ending"
      ? {
        endsAt: new Date(notice.endsAt).toISOString(),
        daysRemaining: daysLeft(notice, now),
      }
      : {}),
  };
}

export interface AccountNoticePoll {
  // never throws
  settle(): Promise<void>;
}

export async function startAccountNoticePoll(
  deps: AccountNoticeDeps,
  options: { readonly slowCommand: boolean },
): Promise<AccountNoticePoll | null> {
  let key: ActiveKey | null;
  try {
    key = await activeKey(deps);
    if (key === null) return null;
    const state = await deps.loadState(key.cacheKey);
    if (!shouldPoll(state, deps.now(), options)) return null;
    // unwritable cache: the schedule can never advance, so every run would poll
    if (!await deps.configDirWritable()) return null;
    // counted before it is sent: a command that calls Deno.exit never settles it
    await deps.saveState(
      key.cacheKey,
      applyPollOutcome(
        state,
        { kind: "failed", reason: "in flight" },
        deps.now(),
      ),
    );
  } catch (error: unknown) {
    logger.debug`Could not start the account notice poll: ${error}`;
    return null;
  }
  const { serverUrl, apiKey, cacheKey } = key;

  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(ACCOUNT_NOTICE_POLL_TIMEOUT_MS),
  ]);
  let done = false;
  const sentAt = deps.now();
  let request: Promise<AccountNoticesResult>;
  try {
    request = deps.accountNotices(serverUrl, apiKey, signal);
  } catch (error: unknown) {
    request = Promise.reject(error);
  }
  // handled here, so it never rejects unhandled before teardown awaits it
  const settled: Promise<AccountNoticesResult> = request
    .catch((error: unknown): AccountNoticesResult => ({
      kind: "failed",
      reason: error instanceof Error ? error.message : String(error),
    }))
    .finally(() => {
      done = true;
    });

  const settle = async (): Promise<void> => {
    const grace = new AbortController();
    const graceWait = deps.wait(
      options.slowCommand
        ? ACCOUNT_NOTICE_POLL_GRACE_MS
        : ACCOUNT_NOTICE_FAST_POLL_GRACE_MS,
      grace.signal,
    );
    await Promise.race([settled, graceWait]);
    grace.abort();
    await graceWait;
    if (!done) controller.abort();
    const result = await settled;
    try {
      // reloaded: another command may have saved this key's state since
      const current = await deps.loadState(cacheKey);
      await deps.saveState(
        cacheKey,
        applyPollOutcome(current, toPollOutcome(result, sentAt), deps.now()),
      );
    } catch (error: unknown) {
      logger.debug`Could not save the account notice poll: ${error}`;
    }
  };

  let settling: Promise<void> | undefined;
  return {
    settle: () => settling ??= settle(),
  };
}

// printed only once recorded, so a notice that can't stop repeating never shows
export async function showAccountNotice(
  deps: AccountNoticeDeps,
): Promise<AccountNoticeView | null> {
  try {
    const key = await activeKey(deps);
    if (key === null) return null;
    const now = deps.now();
    if (noticeToShow(await deps.loadState(key.cacheKey), now) === null) {
      return null;
    }
    if (!await deps.configDirWritable()) return null;
    // reloaded, so the save never puts back an older snapshot
    const current = await deps.loadState(key.cacheKey);
    const shown = noticeToShow(current, now);
    if (shown === null) return null;
    try {
      await deps.saveState(
        key.cacheKey,
        recordNoticeShown(current, shown.notice, now),
      );
    } catch (error: unknown) {
      logger.debug`Could not record the account notice: ${error}`;
      return null;
    }
    return toView(key.serverUrl, shown.notice, now);
  } catch (error: unknown) {
    logger.debug`Could not read the account notice cache: ${error}`;
    return null;
  }
}

// null on failure, so a failure is never read as no notices
export async function refreshAccountNotices(
  deps: AccountNoticeDeps,
): Promise<AccountNoticeView[] | null> {
  try {
    const key = await activeKey(deps);
    if (key === null) return null;
    const sentAt = deps.now();
    const result = await deps.accountNotices(
      key.serverUrl,
      key.apiKey,
      AbortSignal.timeout(ACCOUNT_NOTICE_REFRESH_TIMEOUT_MS),
    ).catch((error: unknown): AccountNoticesResult => ({
      kind: "failed",
      reason: error instanceof Error ? error.message : String(error),
    }));
    const outcome = toPollOutcome(result, sentAt);
    const now = deps.now();
    if (await deps.configDirWritable()) {
      try {
        const current = await deps.loadState(key.cacheKey);
        await deps.saveState(
          key.cacheKey,
          applyPollOutcome(current, outcome, now),
        );
      } catch (error: unknown) {
        logger.debug`Could not save the account notices: ${error}`;
      }
    }
    if (outcome.kind !== "ok") return null;
    return effectiveNotices(
      { notices: outcome.notices, fetchedAt: sentAt },
      now,
    )
      .map((notice) => toView(key.serverUrl, notice, now));
  } catch (error: unknown) {
    logger.debug`Could not refresh the account notices: ${error}`;
    return null;
  }
}
