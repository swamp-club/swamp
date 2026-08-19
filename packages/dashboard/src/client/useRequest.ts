import { useCallback, useEffect, useState } from "react";
import { useSwamp } from "./SwampProvider";

interface UseRequestResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useRequest<T = Record<string, unknown>>(
  type: string,
  payload?: Record<string, unknown>,
): UseRequestResult<T> {
  const { connected, request } = useSwamp();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const payloadKey = payload ? JSON.stringify(payload) : "";

  const fetch = useCallback(() => {
    if (!connected) return;
    setLoading(true);
    setError(null);
    request<T>(type, payload)
      .then((result) => {
        console.log(`[swamp-dashboard] ${type}:`, result);
        setData(result);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [connected, type, payloadKey, request]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { data, loading, error, refetch: fetch };
}
