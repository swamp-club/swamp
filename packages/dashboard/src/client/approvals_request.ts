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

import type { ApprovalsReply } from "./approvals.ts";
import { createRequestRunner } from "./request_runner.ts";
import { type RequestErrorInfo, requestErrorInfo } from "./stream.ts";

export interface ApprovalsSnapshot {
  data: ApprovalsReply | null;
  loading: boolean;
  error: string | null;
  errorInfo: RequestErrorInfo | null;
  /** Replies and failures applied so far. Neither ever decreases. */
  replies: number;
  failures: number;
}

/** The counts a page saw when it mounted. */
export type ApprovalsMark = Pick<ApprovalsSnapshot, "replies" | "failures">;

/**
 * The listing as a page that mounted at `mark` sees it: only what settled
 * since, as with a request the page owned. A listing retained from before
 * is neither shown nor actionable, and neither is an earlier failure.
 */
export function sinceMark(
  snapshot: ApprovalsSnapshot,
  mark: ApprovalsMark,
): ApprovalsSnapshot {
  const replied = snapshot.replies > mark.replies;
  const failed = snapshot.failures > mark.failures;
  return {
    ...snapshot,
    data: replied ? snapshot.data : null,
    error: failed ? snapshot.error : null,
    errorInfo: failed ? snapshot.errorInfo : null,
  };
}

/** One dashboard's listing; consumers observe the same snapshot and read. */
export interface ApprovalsRequest {
  getSnapshot(): ApprovalsSnapshot;
  subscribe(listener: () => void): () => void;
  start(): Promise<ApprovalsReply | null>;
  stop(): void;
  /** Joins the read in flight, or starts one. Failures resolve to null. */
  reload(): Promise<ApprovalsReply | null>;
  /** Reads after a mutation, retiring any pre-mutation reply. */
  refresh(): Promise<ApprovalsReply | null>;
}

const emptySnapshot = (mark: ApprovalsMark): ApprovalsSnapshot => ({
  data: null,
  loading: true,
  error: null,
  errorInfo: null,
  ...mark,
});

export function createApprovalsRequest(
  request: () => Promise<ApprovalsReply>,
): ApprovalsRequest {
  const runner = createRequestRunner();
  const listeners = new Set<() => void>();
  let snapshot = emptySnapshot({ replies: 0, failures: 0 });
  let active = false;
  let revision = 0;
  const publish = (next: ApprovalsSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const read = (join: boolean): Promise<ApprovalsReply | null> => {
    // A callback from a mutation may finish after its dashboard unmounts.
    if (!active) return Promise.resolve(null);
    const start = () => {
      revision++;
      publish({ ...snapshot, loading: true, error: null, errorInfo: null });
      return request();
    };
    const apply = {
      result: (data: ApprovalsReply) =>
        publish({
          ...snapshot,
          data,
          loading: false,
          error: null,
          errorInfo: null,
          replies: snapshot.replies + 1,
        }),
      error: (error: unknown) =>
        publish({
          ...snapshot,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
          errorInfo: requestErrorInfo(error),
          failures: snapshot.failures + 1,
        }),
    };
    const settled = join
      ? runner.join(start, apply)
      : runner.send(start, apply);
    const startedRevision = revision;
    return settled.then(() =>
      active && revision === startedRevision && snapshot.error === null
        ? snapshot.data
        : null
    );
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: () => {
      active = true;
      return read(true);
    },
    stop: () => {
      active = false;
      revision++;
      runner.invalidate();
      // The counts carry over: a page's mark must stay comparable.
      const { replies, failures } = snapshot;
      publish(emptySnapshot({ replies, failures }));
    },
    reload: () => read(true),
    refresh: () => read(false),
  };
}
