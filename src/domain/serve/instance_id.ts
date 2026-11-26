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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** lower-cased, so two spellings of one id never name two keys */
export function normalizedUuid(input: unknown): string | undefined {
  if (typeof input !== "string" || !UUID_PATTERN.test(input)) return undefined;
  return input.toLowerCase();
}

export class InstanceIdError extends Error {
  constructor() {
    super("Invalid instance id: expected a UUID");
    this.name = "InstanceIdError";
  }
}

/** a member process's id; safe as a control-plane key segment once created */
export class InstanceId {
  private constructor(readonly value: string) {}

  static create(input: unknown): InstanceId {
    const value = normalizedUuid(input);
    if (value === undefined) throw new InstanceIdError();
    return new InstanceId(value);
  }

  static isValid(input: unknown): boolean {
    return normalizedUuid(input) !== undefined;
  }

  equals(other: InstanceId): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }

  toJSON(): string {
    return this.value;
  }
}
