/**
 * HTTP handlers for model types API endpoints.
 */

import type { RouteContext } from "../router.ts";
import { jsonResponse } from "../router.ts";
import { modelRegistry } from "../../../domain/models/model.ts";

export function listTypes(_ctx: RouteContext): Response {
  const types = modelRegistry.types().map((t) => ({
    raw: t.raw,
    normalized: t.normalized,
  }));

  return jsonResponse({ types });
}
