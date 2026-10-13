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
import { useSwamp } from "./SwampProvider";
import { createRequestSequence } from "./request_sequence";
import { fetchAllPages } from "./fetch_all_pages.ts";

/**
 * `useRequest` for a paged search that must be read in full: it follows
 * `total` page by page. `data` is null until the first complete read; a
 * refetch keeps the previous list visible until the new one is complete.
 */
export function useRequestAllPages<T>(
  type: string,
  payload: Record<string, unknown>,
  pageSize = 500,
): {
  data: T[] | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
} {
  const { connected, request } = useSwamp();
  const [data, setData] = useState<T[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sequenceRef = useRef(createRequestSequence());
  const payloadKey = JSON.stringify(payload);

  const fetch = useCallback(() => {
    if (!connected) return;
    const sequence = sequenceRef.current;
    const ticket = sequence.next();
    const base = JSON.parse(payloadKey) as Record<string, unknown>;
    setLoading(true);
    fetchAllPages<T>(
      (offset, limit) => request(type, { ...base, offset, limit }),
      { pageSize },
    )
      .then(({ items }) => {
        if (!sequence.isCurrent(ticket)) return;
        setData(items);
        setError(null);
        setLoading(false);
      })
      .catch((err) => {
        if (!sequence.isCurrent(ticket)) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [connected, request, type, payloadKey, pageSize]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  useEffect(() => {
    const sequence = sequenceRef.current;
    return () => sequence.invalidate();
  }, []);

  return { data, loading, error, refetch: fetch };
}
