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
  const colonIndex = value.indexOf(":");
  if (colonIndex === -1) {
    throw new Error(
      `Invalid principal "${value}": expected ${
        describeAlternatives(
          PrincipalKindSchema.options.map((k) => `${k}:<id>`),
        )
      }`,
    );
  }
  const kind = value.slice(0, colonIndex);
  const id = value.slice(colonIndex + 1);
  if (id.length === 0) {
    throw new Error(`Invalid principal "${value}": id cannot be empty`);
  }
  const parsed = PrincipalKindSchema.safeParse(kind);
  if (!parsed.success) {
    throw new Error(
      `Invalid principal kind "${kind}": expected ${
        describeAlternatives(PrincipalKindSchema.options)
      }`,
    );
  }
  return { kind: parsed.data, id };
}

export function principalToString(principal: Principal): string {
  return `${principal.kind}:${principal.id}`;
}
