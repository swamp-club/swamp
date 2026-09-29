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

export const PrincipalKindSchema = z.enum(["user", "worker", "service"]);

export type PrincipalKind = z.infer<typeof PrincipalKindSchema>;

/**
 * The built-in service principals. No other `service:` id exists, so a
 * misspelt one is refused rather than silently matching nothing.
 */
export const SERVICE_PRINCIPAL_IDS = ["scheduler", "webhook"] as const;

/** Why a `service:` id is refused, or null when it names a built-in. */
export function unknownServiceIdError(
  value: string,
  id: string,
): string | null {
  if ((SERVICE_PRINCIPAL_IDS as readonly string[]).includes(id)) return null;
  const expected = SERVICE_PRINCIPAL_IDS.map((known) => `"service:${known}"`)
    .join(" or ");
  return `Invalid principal "${value}": expected ${expected}`;
}

/** Joins quoted items as `"a", "b" or "c"` for error messages. */
function describeAlternatives(items: readonly string[]): string {
  const quoted = items.map((item) => `"${item}"`);
  return `${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1]}`;
}

export const PrincipalSchema = z.object({
  kind: PrincipalKindSchema,
  id: z.string().min(1),
});

export type Principal = z.infer<typeof PrincipalSchema>;

export function parsePrincipal(value: string): Principal {
  return parsePrincipalOfKinds(value, PrincipalKindSchema.options);
}

/**
 * Parses a principal, accepting only the given kinds. Error messages name
 * exactly those kinds, so a caller that cannot take every kind (token mint)
 * never suggests one it would then refuse.
 */
export function parsePrincipalOfKinds(
  value: string,
  kinds: readonly PrincipalKind[],
): Principal {
  const colonIndex = value.indexOf(":");
  if (colonIndex === -1) {
    throw new Error(
      `Invalid principal "${value}": expected ${
        describeAlternatives(kinds.map((k) => `${k}:<id>`))
      }`,
    );
  }
  const kind = value.slice(0, colonIndex);
  const id = value.slice(colonIndex + 1);
  if (id.length === 0) {
    throw new Error(`Invalid principal "${value}": id cannot be empty`);
  }
  const parsed = PrincipalKindSchema.safeParse(kind);
  if (!parsed.success || !kinds.includes(parsed.data)) {
    throw new Error(
      `Invalid principal kind "${kind}": expected ${
        describeAlternatives(kinds)
      }`,
    );
  }
  if (parsed.data === "service") {
    const error = unknownServiceIdError(value, id);
    if (error) throw new Error(error);
  }
  return { kind: parsed.data, id };
}

export function principalToString(principal: Principal): string {
  return `${principal.kind}:${principal.id}`;
}
