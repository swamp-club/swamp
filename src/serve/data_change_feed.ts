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

/** Only data intents pass: content, writers, principals, keys and control-plane data never leave serve. */

import {
  type AggregateResourceResolver,
  readAccessOf,
} from "../domain/datastore_v3/commit_authorization.ts";
import type { CommitChange } from "../domain/datastore_v3/commit_store.ts";
import type { AccessResource } from "../domain/access/access_decision_service.ts";
import type { DataChange, DataChangeKind } from "./protocol.ts";

export interface DataChangeFilter {
  /** Behavior names; any when absent. */
  behaviors?: readonly string[];
  /** Behavior types; any when absent. */
  types?: readonly string[];
}

const CHANGE_OF: Readonly<Record<string, DataChangeKind>> = {
  "data.save": "saved",
  "data.append": "saved",
  "data.delete": "deleted",
  "data.gc": "deleted",
  "data.rename": "renamed",
};

/** One change per item and version: a save writes several keys for one version. */
export async function dataChangesOf(
  change: CommitChange,
  namespace: string,
  resolver: AggregateResourceResolver,
  readable: (resource: AccessResource) => boolean,
  filter: DataChangeFilter = {},
): Promise<DataChange[]> {
  if (change.commit.namespace !== namespace) return [];
  const seen = new Set<string>();
  const out: DataChange[] = [];
  for (const op of change.commit.ops) {
    if (op.kind !== "put" && op.kind !== "tombstone") continue;
    const intent = op.intent;
    const kind = CHANGE_OF[intent.kind];
    if (kind === undefined || !("model" in intent) || !("name" in intent)) {
      continue;
    }
    if (filter.types && !filter.types.includes(intent.model.type)) continue;
    const access = await readAccessOf(op, resolver);
    // admin is what control-plane data needs; it is never an app's to watch
    if (access === undefined || access.action !== "read") continue;
    if (!readable(access.resource)) continue;
    const lookup = await resolver.model(intent.model);
    if (lookup === undefined) continue;
    const behavior = lookup.definition.name;
    if (filter.behaviors && !filter.behaviors.includes(behavior)) continue;
    const version = "version" in intent ? intent.version : undefined;
    const to = "to" in intent ? intent.to : undefined;
    const key = [kind, intent.model.id, intent.name, version ?? "", to ?? ""]
      .join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      cursor: change.cursor,
      at: change.commit.at,
      behavior,
      type: intent.model.type,
      name: intent.name,
      ...(version !== undefined ? { version } : {}),
      change: kind,
      ...(to !== undefined ? { to } : {}),
    });
  }
  // a whole-name delete also tombstones the name's version-less marker; the
  // versioned changes already say it went
  return out.filter((c) =>
    c.version !== undefined || c.change !== "deleted" ||
    !out.some((o) =>
      o !== c && o.change === "deleted" && o.behavior === c.behavior &&
      o.name === c.name && o.version !== undefined
    )
  );
}
