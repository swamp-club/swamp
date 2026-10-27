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

/**
 * What the CLI remembers about one API key's inbox between commands. Three
 * parts that change for different reasons: the last good server summary, when
 * to poll next, and which message the notice last announced.
 */

/** The last good `/api/inbox/summary` answer and its `ETag`. */
export interface InboxSnapshot {
  readonly unread: number;
  /** The newest unread message's id, upper-case ULID. */
  readonly newestId: string | null;
  readonly newestAt: string | null;
  /** The server's value, unclamped. The policy applies the floor and ceiling. */
  readonly pollAfterSeconds: number;
  readonly etag: string | null;
}

/** The poll outcomes that stop polling for a key. */
export const POLL_STOP_REASONS = [
  "unsupported",
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
  /** Epoch milliseconds. */
  readonly at: number;
}

/** When the key was last polled and when it may be polled again. */
export interface PollSchedule {
  /** Epoch milliseconds of the last poll, whatever its outcome. */
  readonly lastPolledAt: number | null;
  /** Epoch milliseconds a backoff asked the poll to wait until. */
  readonly nextPollAt: number | null;
  readonly stop: PollStop | null;
}

/** The message the notice last announced, and when it first showed. */
export interface Announcement {
  readonly id: string;
  /** Epoch milliseconds. */
  readonly at: number;
}

export interface InboxState {
  /** Null until the first successful poll. */
  readonly snapshot: InboxSnapshot | null;
  readonly schedule: PollSchedule;
  readonly announcement: Announcement | null;
}

export const InboxState = {
  /** The state of a key that has never been polled. */
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
  | { readonly kind: "not_modified" }
  /** The server has no inbox. */
  | { readonly kind: "unsupported" }
  /** A collective key has no inbox. */
  | { readonly kind: "unavailable" }
  /** The key is unknown or revoked. */
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

/** Remembers each API key's inbox state, keyed by its fingerprint. */
export interface InboxCacheRepository {
  /** The key's state, or an empty state when none is stored or it is invalid. */
  load(fingerprint: string): Promise<InboxState>;
  save(fingerprint: string, state: InboxState): Promise<void>;
}
