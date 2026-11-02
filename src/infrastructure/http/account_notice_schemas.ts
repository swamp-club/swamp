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

import { z } from "zod";
import { PROSE_INVISIBLE_RE, sanitizeLine } from "./inbox_schemas.ts";
import { MAX_ACCOUNT_NOTICES } from "../../domain/account_notices/account_notice.ts";

// matched exactly: any other 403 is a gateway's
export const NOTICES_REQUIRE_USER = "notices_require_user";

// a longer body is refused unread: the answer is a handful of short notices
export const MAX_ACCOUNT_NOTICES_BODY_BYTES = 64 * 1024;

export const MAX_NOTICE_NAME_LENGTH = 120;

const MAX_BILLING_PATH_LENGTH = 200;

export const SLUG_RE = /^[a-z0-9_-]{1,64}$/;

// the joiners prose keeps print nothing on their own
export function isBlankName(name: string): boolean {
  return name.replace(/[\u200c\u200d]/g, "").trim() === "";
}

export type ParsedAccountNotice =
  | {
    readonly kind: "trial-ended";
    readonly slug: string;
    readonly name: string;
    readonly personal: boolean;
    // a same-origin relative path, or null when the server's was refused
    readonly href: string | null;
  }
  | {
    readonly kind: "trial-ending";
    readonly slug: string;
    readonly name: string;
    readonly personal: boolean;
    readonly href: string | null;
    readonly endsAt: string;
    readonly daysRemaining: number;
  };

// best effort: every failure is a case here rather than a throw
export type AccountNoticesResult =
  | {
    readonly kind: "ok";
    readonly notices: readonly ParsedAccountNotice[];
  }
  | { readonly kind: "unsupported" }
  // 403 notices_require_user: a collective key
  | { readonly kind: "unavailable" }
  | { readonly kind: "rejected" }
  | { readonly kind: "backoff"; readonly retryAfterSeconds?: number }
  | { readonly kind: "failed"; readonly reason: string };

// printable ASCII only: any space would let server text print a second URL
const PRINTABLE_ASCII_RE = /^[\x21-\x7e]+$/;

// anything that could resolve to another host is refused
export function trustedBillingPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (
    raw.length === 0 || raw.length > MAX_BILLING_PATH_LENGTH ||
    !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") ||
    !PRINTABLE_ASCII_RE.test(raw)
  ) {
    return null;
  }
  const base = "https://origin.invalid";
  try {
    const url = new URL(raw, base);
    return url.origin === base ? raw : null;
  } catch {
    return null;
  }
}

const common = {
  slug: z.string().regex(SLUG_RE),
  name: z.string()
    .transform((s) =>
      sanitizeLine(s, MAX_NOTICE_NAME_LENGTH, PROSE_INVISIBLE_RE)
    )
    .refine((s) => !isBlankName(s)),
  personal: z.boolean(),
  href: z.unknown().optional().transform(trustedBillingPath),
};

const endedSchema = z.object({ kind: z.literal("trial-ended"), ...common });

const endingSchema = z.object({
  kind: z.literal("trial-ending"),
  ...common,
  endsAt: z.iso.datetime({ offset: true }),
  daysRemaining: z.number().int().nonnegative().max(3650),
});

const noticeSchema = z.discriminatedUnion("kind", [endedSchema, endingSchema]);

const envelopeSchema = z.object({ notices: z.array(z.unknown()) });

const errorSchema = z.object({ error: z.string() });

// a seat notice, a later kind or a malformed entry is dropped, never fatal
export function parseAccountNotices(
  raw: unknown,
): ParsedAccountNotice[] | undefined {
  const envelope = envelopeSchema.safeParse(raw);
  if (!envelope.success) return undefined;
  const notices: ParsedAccountNotice[] = [];
  for (const entry of envelope.data.notices) {
    const parsed = noticeSchema.safeParse(entry);
    if (!parsed.success) continue;
    notices.push(parsed.data);
    if (notices.length === MAX_ACCOUNT_NOTICES) break;
  }
  return notices;
}

export function parseAccountNoticesErrorCode(raw: unknown): string | undefined {
  const parsed = errorSchema.safeParse(raw);
  return parsed.success ? parsed.data.error : undefined;
}
