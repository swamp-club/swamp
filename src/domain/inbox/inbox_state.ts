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

export interface InboxSnapshot {
  readonly unread: number;
  readonly newestId: string | null;
  readonly newestAt: string | null;
  /** The server's value, unclamped. The policy applies the floor and ceiling. */
  readonly pollAfterSeconds: number;
  readonly etag: string | null;
  /**
   * Epoch milliseconds the request that fetched this summary was sent, so an
   * older snapshot never replaces a newer one. Absent in state saved before
   * the field existed, which orders before any stamped snapshot.
   */
  readonly fetchedAt?: number;
}

export const POLL_STOP_REASONS = [
  "unavailable",
  "rejected",
] as const;

export type PollStopReason = typeof POLL_STOP_REASONS[number];

/**
 * Why and when polling stopped. Kept rather than a bare flag so a later rule
 * can retry a stopped key without migrating stored state.
 */
export interface PollStop {
  readonly reason: PollStopReason;
  readonly at: number;
}

export interface PollSchedule {
  readonly lastPolledAt: number | null;
  readonly nextPollAt: number | null;
  readonly stop: PollStop | null;
}

export interface Announcement {
  readonly id: string;
  readonly at: number;
}

export interface InboxState {
  readonly snapshot: InboxSnapshot | null;
  readonly schedule: PollSchedule;
  readonly announcement: Announcement | null;
}

export const InboxState = {
  empty(): InboxState {
    return {
      snapshot: null,
      schedule: { lastPolledAt: null, nextPollAt: null, stop: null },
      announcement: null,
    };
  },
};

/**
 * The result of one poll, in the domain's terms. It mirrors the HTTP client's
 * summary result so the server contract can change without touching the
 * policy.
 */
export type PollOutcome =
  | { readonly kind: "ok"; readonly snapshot: InboxSnapshot }
  | {
    readonly kind: "not_modified";
    readonly sentAt?: number;
  }
  | { readonly kind: "unsupported" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "rejected" }
  | { readonly kind: "backoff"; readonly retryAfterSeconds?: number }
  | { readonly kind: "failed"; readonly reason: string };

/** Message ids are upper-case ULIDs, so "newer than" is a string compare. */
export const INBOX_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const MAX_ETAG_LENGTH = 256;

export const MAX_NEWEST_AT_LENGTH = 64;

/**
 * Whether an `ETag` can be kept and sent back. One that cannot is dropped, so
 * the next poll is a plain request rather than a cache that never loads.
 */
export function isStorableEtag(etag: string): boolean {
  return etag.length > 0 && etag.length <= MAX_ETAG_LENGTH &&
    /^[\x20-\x7e]+$/.test(etag);
}

/**
 * Whose inbox state this is: one API key on one server. The same key used
 * against two servers (staging and production) keeps two states, so one
 * server's answers never decide when or what the other shows.
 */
export interface InboxCacheKey {
  readonly origin: string;
  /** The API key's fingerprint; never the key. */
  readonly fingerprint: string;
}

export const InboxCacheKey = {
  of(serverUrl: string, fingerprint: string): InboxCacheKey {
    return { origin: new URL(serverUrl).origin, fingerprint };
  },
};

export interface InboxCacheRepository {
  /** The key's state, or an empty state when none is stored or it is invalid. */
  load(key: InboxCacheKey): Promise<InboxState>;
  save(key: InboxCacheKey, state: InboxState): Promise<void>;
  delete(key: InboxCacheKey): Promise<void>;
}
