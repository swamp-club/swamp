/**
 * Safely extract an array from a WS response payload.
 * The serve protocol wraps responses as { data: ... } where the inner data
 * can be an array directly, an object with array values, or something else.
 * This helper handles all shapes defensively.
 */
export function extractArray<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    // { data: { results: [...] } } — workflow.run.search, workflow.search, model.search
    if (obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)) {
      const inner = obj.data as Record<string, unknown>;
      if (Array.isArray(inner.results)) return inner.results as T[];
      if (Array.isArray(inner.items)) return inner.items as T[];
      const innerValues = Object.values(inner);
      for (const v of innerValues) {
        if (Array.isArray(v)) return v as T[];
      }
    }
    // { data: [...] } — direct array in data
    if (Array.isArray(obj.data)) return obj.data as T[];
    // { results: [...] } — top-level results
    if (Array.isArray(obj.results)) return obj.results as T[];
    if (Array.isArray(obj.items)) return obj.items as T[];
  }
  return [];
}

/**
 * Extract a single object from a WS response payload.
 */
export function extractObject<T>(payload: unknown): T | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;
  if (obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)) {
    return obj.data as T;
  }
  return obj as unknown as T;
}
