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

import type { Group } from "../../domain/models/access/group_model.ts";
import type { OutputMode } from "../output/output.ts";

export interface AccessGroupListRenderer {
  renderList(groups: Group[]): void;
  renderMembers(group: Group): void;
}

function formatPrincipal(p: { kind: string; id: string }): string {
  return `${p.kind}:${p.id}`;
}

class LogAccessGroupListRenderer implements AccessGroupListRenderer {
  renderList(groups: Group[]): void {
    if (groups.length === 0) {
      console.log("No groups found.");
      return;
    }

    const header = `${"NAME".padEnd(30)}  ${"MEMBERS".padEnd(8)}  ${
      "CREATED BY".padEnd(20)
    }  CREATED AT`;
    console.log(header);

    for (const group of groups) {
      const name = group.name.padEnd(30);
      const members = String(group.members.length).padEnd(8);
      const createdBy = formatPrincipal(group.createdBy).padEnd(20);
      const createdAt = group.createdAt.slice(0, 10);
      console.log(`${name}  ${members}  ${createdBy}  ${createdAt}`);
    }
  }

  renderMembers(group: Group): void {
    if (group.members.length === 0) {
      console.log(`Group "${group.name}" has no members.`);
      return;
    }

    console.log(`Members of "${group.name}":`);
    for (const member of group.members) {
      console.log(`  ${formatPrincipal(member)}`);
    }
  }
}

class JsonAccessGroupListRenderer implements AccessGroupListRenderer {
  renderList(groups: Group[]): void {
    console.log(JSON.stringify(groups, null, 2));
  }

  renderMembers(group: Group): void {
    console.log(JSON.stringify(group, null, 2));
  }
}

export function createAccessGroupListRenderer(
  mode: OutputMode,
): AccessGroupListRenderer {
  switch (mode) {
    case "json":
      return new JsonAccessGroupListRenderer();
    case "log":
      return new LogAccessGroupListRenderer();
  }
}
