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

export const MAX_MEMBER_NAME_LENGTH = 64;

const MEMBER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

export class MemberNameError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid member name: ${reason}`);
    this.name = "MemberNameError";
  }
}

/** names a member and the hub alike; never echoes the refused value */
export class MemberName {
  private constructor(readonly value: string) {}

  /** the rule a value breaks, or undefined when it is a valid name */
  static problem(input: unknown): string | undefined {
    if (typeof input !== "string") return "expected a string";
    if (input === "") return "must not be empty";
    if (input.length > MAX_MEMBER_NAME_LENGTH) {
      return `must be at most ${MAX_MEMBER_NAME_LENGTH} characters`;
    }
    if (!MEMBER_NAME_PATTERN.test(input)) {
      return "may contain only letters, digits, '-' and '_'";
    }
    return undefined;
  }

  static create(input: unknown): MemberName {
    const reason = MemberName.problem(input);
    if (reason !== undefined) throw new MemberNameError(reason);
    return new MemberName(input as string);
  }

  equals(other: MemberName): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }

  toJSON(): string {
    return this.value;
  }
}
