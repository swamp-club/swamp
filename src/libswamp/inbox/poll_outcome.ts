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

import type { InboxSummaryResult } from "../../infrastructure/http/inbox_schemas.ts";
import {
  isStorableEtag,
  MAX_NEWEST_AT_LENGTH,
  type PollOutcome,
} from "../../domain/inbox/inbox_state.ts";

/**
 * Translates the HTTP client's summary result into the domain's poll outcome.
 * Values the cache could not store are dropped here, so whatever the poll
 * keeps also loads.
 */
export function toPollOutcome(result: InboxSummaryResult): PollOutcome {
  switch (result.kind) {
    case "ok": {
      const { summary, etag } = result;
      return {
        kind: "ok",
        snapshot: {
          unread: summary.unread,
          newestId: summary.newestId,
          newestAt: summary.newestAt !== null &&
              summary.newestAt.length <= MAX_NEWEST_AT_LENGTH
            ? summary.newestAt
            : null,
          pollAfterSeconds: summary.pollAfterSeconds,
          etag: etag !== null && isStorableEtag(etag) ? etag : null,
        },
      };
    }
    case "not_modified":
    case "unsupported":
    case "unavailable":
    case "rejected":
      return { kind: result.kind };
    case "backoff":
      return result.retryAfterSeconds === undefined
        ? { kind: "backoff" }
        : { kind: "backoff", retryAfterSeconds: result.retryAfterSeconds };
    case "failed":
      return { kind: "failed", reason: result.reason };
    default: {
      const _exhaustive: never = result;
      return _exhaustive;
    }
  }
}
