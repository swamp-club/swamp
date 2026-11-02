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

import { isAbsolute, resolve } from "@std/path";

export class RepoPath {
  private constructor(readonly value: string) {}

  static create(path: string): RepoPath {
    const trimmed = path.trim();
    if (trimmed.length === 0) {
      throw new Error("Repository path cannot be empty");
    }

    const absolutePath = isAbsolute(trimmed) ? trimmed : resolve(trimmed);

    return new RepoPath(absolutePath);
  }

  equals(other: RepoPath): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
