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

import type { AccountNotice } from "../../domain/account_notices/account_notice.ts";
import type { AccountNoticePollOutcome } from "../../domain/account_notices/account_notice_state.ts";
import type {
  AccountNoticesResult,
  ParsedAccountNotice,
} from "../../infrastructure/http/account_notice_schemas.ts";

function toNotice(parsed: ParsedAccountNotice): AccountNotice {
  const collective = {
    slug: parsed.slug,
    name: parsed.name,
    personal: parsed.personal,
  };
  return parsed.kind === "trial-ending"
    ? {
      kind: "trial-ending",
      collective,
      billingPath: parsed.href,
      endsAt: Date.parse(parsed.endsAt),
      daysRemaining: parsed.daysRemaining,
    }
    : { kind: "trial-ended", collective, billingPath: parsed.href };
}

export function toPollOutcome(
  result: AccountNoticesResult,
  sentAt: number,
): AccountNoticePollOutcome {
  switch (result.kind) {
    case "ok":
      return { kind: "ok", notices: result.notices.map(toNotice), sentAt };
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
