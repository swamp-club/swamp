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

import { useCallback, useEffect, useRef, useState } from "react";
import { useSwamp } from "./SwampProvider.tsx";
import { createRequestRunner } from "./request_runner.ts";
import { type RequestErrorInfo, requestErrorInfo } from "./stream.ts";

interface UseRequestResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Serve's error code plus any reason/entity type, when the request failed. */
  errorInfo: RequestErrorInfo | null;
  refetch: () => void;
  /**
   * Re-reads without stacking: waits for the read still in flight, or sends
   * one when none is. Resolves once it has answered; never rejects.
   */
  reload: () => Promise<void>;
}

interface UseRequestOptions {
  /**
   * When false the request is not sent and the hook reports no data, no
   * error and not loading. Lets a view wait for a request it depends on.
   */
  enabled?: boolean;
}

export function useRequest<T = Record<string, unknown>>(
  type: string,
  payload?: Record<string, unknown>,
  options: UseRequestOptions = {},
): UseRequestResult<T> {
  const enabled = options.enabled ?? true;
  const { connected, request } = useSwamp();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [errorInfo, setErrorInfo] = useState<RequestErrorInfo | null>(null);
  const runnerRef = useRef(createRequestRunner());
  const lastKeyRef = useRef<string | null>(null);

  const payloadKey = payload ? JSON.stringify(payload) : "";
  const requestKey = `${type}\u0000${payloadKey}`;

  const run = useCallback((join: boolean): Promise<void> => {
    const runner = runnerRef.current;
    if (!enabled) {
      runner.invalidate();
      lastKeyRef.current = null;
      setData(null);
      setError(null);
      setErrorInfo(null);
      setLoading(false);
      return Promise.resolve();
    }
    // A different request must not show the previous request's result
    // while it loads — even while disconnected; a refetch of the same
    // request keeps it.
    if (lastKeyRef.current !== requestKey) {
      lastKeyRef.current = requestKey;
      runner.invalidate();
      setData(null);
      setError(null);
      setErrorInfo(null);
      setLoading(true);
    }
    if (!connected) return Promise.resolve();
    setLoading(true);
    setError(null);
    setErrorInfo(null);
    const start = () => request<T>(type, payload);
    const apply = {
      result: (result: T) => {
        setData(result);
        setLoading(false);
      },
      error: (err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setErrorInfo(requestErrorInfo(err));
        setLoading(false);
      },
    };
    return join ? runner.join(start, apply) : runner.send(start, apply);
  }, [connected, enabled, type, payloadKey, request]);

  const fetch = useCallback(() => {
    run(false).catch(() => {});
  }, [run]);
  const reload = useCallback(() => run(true), [run]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  useEffect(() => {
    const runner = runnerRef.current;
    return () => runner.invalidate();
  }, []);

  return { data, loading, error, errorInfo, refetch: fetch, reload };
}
