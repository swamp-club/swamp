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
import { SERVICE_PRINCIPAL_IDS } from "./principal.ts";

export const SubjectKindSchema = z.enum([
  "user",
  "group",
  "idp-group",
  "service",
]);

export type SubjectKind = z.infer<typeof SubjectKindSchema>;

/** Joins quoted items as `"a", "b", or "c"` for error messages. */
function describeAlternatives(items: readonly string[]): string {
  const quoted = items.map((item) => `"${item}"`);
  return `${quoted.slice(0, -1).join(", ")}, or ${quoted[quoted.length - 1]}`;
}

export const SubjectSchema = z.object({
  kind: SubjectKindSchema,
  name: z.string().min(1),
});

export type Subject = z.infer<typeof SubjectSchema>;

export function parseSubject(value: string): Subject {
  const colonIndex = value.indexOf(":");
  if (colonIndex === -1) {
    throw new Error(
      `Invalid subject "${value}": expected ${
        describeAlternatives(
          SubjectKindSchema.options.map((k) => `${k}:<name>`),
        )
      }`,
    );
  }
  const kind = value.slice(0, colonIndex);
  const name = value.slice(colonIndex + 1);
  if (name.length === 0) {
    throw new Error(`Invalid subject "${value}": name cannot be empty`);
  }
  const parsed = SubjectKindSchema.safeParse(kind);
  if (!parsed.success) {
    throw new Error(
      `Invalid subject kind "${kind}": expected ${
        describeAlternatives(SubjectKindSchema.options)
      }`,
    );
  }
  if (
    parsed.data === "service" &&
    !(SERVICE_PRINCIPAL_IDS as readonly string[]).includes(name)
  ) {
    throw new Error(
      `Invalid subject "${value}": expected ${
        SERVICE_PRINCIPAL_IDS.map((id) => `"service:${id}"`).join(" or ")
      }`,
    );
  }
  return { kind: parsed.data, name };
}

export function subjectToString(subject: Subject): string {
  return `${subject.kind}:${subject.name}`;
}
