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

import type { MemberName } from "./member_name.ts";
import type { ServeMember } from "./serve_member.ts";

/** names are unique among members not removed, the hub's own record included */
export class MemberRoster {
  readonly #live: ReadonlyMap<string, ServeMember>;

  /** hubName is reserved even before the hub's own record exists */
  constructor(
    members: readonly ServeMember[],
    private readonly hubName?: string,
  ) {
    const live = new Map<string, ServeMember>();
    for (const member of members) {
      if (!member.isRemoved) live.set(member.name, member);
    }
    this.#live = live;
  }

  liveMemberNamed(name: MemberName): ServeMember | undefined {
    return this.#live.get(name.value);
  }

  isNameTaken(name: MemberName): boolean {
    return name.value === this.hubName || this.#live.has(name.value);
  }

  /** names held by more than one live record: always empty when every admission went through isNameTaken */
  static duplicateLiveNames(members: readonly ServeMember[]): string[] {
    const counts = new Map<string, number>();
    for (const member of members) {
      if (member.isRemoved) continue;
      counts.set(member.name, (counts.get(member.name) ?? 0) + 1);
    }
    return [...counts].filter(([, n]) => n > 1).map(([name]) => name).sort();
  }
}
