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

const emptySnapshot = (): ApprovalsSnapshot => ({
  data: null,
  loading: true,
  error: null,
  errorInfo: null,
});

export function createApprovalsRequest(
  request: () => Promise<ApprovalsReply>,
): ApprovalsRequest {
  const runner = createRequestRunner();
  const listeners = new Set<() => void>();
  let snapshot = emptySnapshot();
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
        publish({ data, loading: false, error: null, errorInfo: null }),
      error: (error: unknown) =>
        publish({
          ...snapshot,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
          errorInfo: requestErrorInfo(error),
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
      publish(emptySnapshot());
    },
    reload: () => read(true),
    refresh: () => read(false),
  };
}
