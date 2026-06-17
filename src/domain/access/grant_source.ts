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

const FIXED_SOURCES = ["method", "file", "config"] as const;

export const GrantSourceSchema = z.string().min(1).refine(
  (value) => {
    if ((FIXED_SOURCES as readonly string[]).includes(value)) {
      return true;
    }
    return value.startsWith("extension:");
  },
  {
    message:
      'Grant source must be "method", "file", "config", or "extension:<name>"',
  },
);

export type GrantSource = z.infer<typeof GrantSourceSchema>;

export function parseGrantSource(value: string): GrantSource {
  const result = GrantSourceSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Invalid grant source "${value}": must be "method", "file", "config", or "extension:<name>"`,
    );
  }
  return result.data;
}
