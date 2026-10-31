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
 * The agent sessions page's requests (swamp-club#4155). Payloads and parsing
 * live in `agent_sessions.ts`; this file only sends them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRequest } from "./useRequest.ts";
import { useSwamp } from "./SwampProvider.tsx";
import {
  appendWindow,
  childrenPayload,
  detailPayload,
  listPayload,
  parseDetailReply,
  parseListReply,
  probePayload,
  replyData,
  type SessionList,
  type SessionRow,
} from "./agent_sessions.ts";
import type { AgentSessionReading } from "../lib/agent_sessions/record.ts";

/**
 * Whether the viewer can read at least one session: one query, limit 1. It
 * runs when the dashboard loads and when it reconnects, so sessions imported
 * while the dashboard is open show after a reload.
 */
export function useAgentSessionsVisible(): boolean {
  const probe = useRequest("data.query", probePayload());
  return parseListReply(replyData(probe.data)).rows.length > 0;
}

export interface ListState {
  readonly list: SessionList;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refetch: () => void;
}

export interface SessionListState extends ListState {
  /** Reads the next older window; set while there is one to read. */
  readonly loadOlder: (() => void) | null;
  readonly loadingOlder: boolean;
  readonly olderError: string | null;
}

/**
 * The newest window of sessions, and the older windows read on request.
 * A re-read of the newest window (a reconnect, a retry) drops the older
 * ones, whose cursor it no longer follows.
 */
export function useSessionList(): SessionListState {
  const { request } = useSwamp();
  const req = useRequest("data.query", listPayload());
  const first = useMemo(() => parseListReply(replyData(req.data)), [req.data]);
  const [older, setOlder] = useState<SessionList | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setOlder(null);
    setOlderError(null);
    setLoadingOlder(false);
  }, [first]);
  const list = older ?? first;
  const cursor = list.nextCursor;
  const loadOlder = useCallback(async () => {
    if (cursor === undefined) return;
    const at = generation.current;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const reply = await request("data.query", listPayload(cursor));
      if (at !== generation.current) return;
      setOlder(appendWindow(list, parseListReply(replyData(reply))));
    } catch (error) {
      if (at !== generation.current) return;
      setOlderError(error instanceof Error ? error.message : String(error));
    } finally {
      if (at === generation.current) setLoadingOlder(false);
    }
  }, [cursor, list, request]);
  return {
    list,
    loading: req.loading,
    error: req.error,
    refetch: req.refetch,
    loadOlder: cursor === undefined || loadingOlder
      ? null
      : () => void loadOlder(),
    loadingOlder,
    olderError,
  };
}

export interface DetailState {
  readonly reading: AgentSessionReading | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refetch: () => void;
}

/** One session's record, read only once it is opened. */
export function useSessionDetail(row: SessionRow | null): DetailState {
  const req = useRequest(
    "data.get",
    row ? detailPayload(row) : undefined,
    { enabled: row !== null },
  );
  const reading = useMemo(
    () => (req.data ? parseDetailReply(replyData(req.data)) : null),
    [req.data],
  );
  return {
    reading,
    loading: req.loading,
    error: req.error,
    refetch: req.refetch,
  };
}

/** One session's subagents, from their tags; null until a session opens. */
export function useSessionChildren(sessionId: string | null): ListState {
  const payload = sessionId ? childrenPayload(sessionId) : null;
  const req = useRequest("data.query", payload ?? undefined, {
    enabled: payload !== null,
  });
  const list = useMemo(() => parseListReply(replyData(req.data)), [req.data]);
  return { list, loading: req.loading, error: req.error, refetch: req.refetch };
}

export type ChildRecord =
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly error: string }
  | { readonly state: "read"; readonly reading: AgentSessionReading };

/**
 * Subagent records, each read when it is first asked for (a call expanded,
 * or its findings shown), and kept by data name while the session is open.
 */
export function useChildRecords(): {
  readonly records: ReadonlyMap<string, ChildRecord>;
  readonly load: (row: SessionRow) => Promise<void>;
  readonly reset: () => void;
} {
  const { request } = useSwamp();
  const [records, setRecords] = useState<ReadonlyMap<string, ChildRecord>>(
    () => new Map(),
  );
  const put = useCallback((name: string, value: ChildRecord) => {
    setRecords((current) => new Map(current).set(name, value));
  }, []);
  const load = useCallback(async (row: SessionRow) => {
    if (records.has(row.name)) return;
    put(row.name, { state: "loading" });
    try {
      const reply = await request("data.get", detailPayload(row));
      put(row.name, {
        state: "read",
        reading: parseDetailReply(replyData(reply)),
      });
    } catch (error) {
      put(row.name, {
        state: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [records, request, put]);
  const reset = useCallback(() => setRecords(new Map()), []);
  return { records, load, reset };
}
