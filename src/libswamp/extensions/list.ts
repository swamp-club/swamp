// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";

/** A single extension entry for list output. */
export interface ExtensionListEntry {
  name: string;
  version: string;
  pulledAt: string;
  files: string[];
}

/** Data payload for the completed event. */
export interface ExtensionListData {
  extensions: ExtensionListEntry[];
}

export type ExtensionListEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: ExtensionListData }
  | { kind: "error"; error: SwampError };

/** Upstream extension entry as stored on disk. */
interface UpstreamEntry {
  version: string;
  pulledAt?: string;
  files?: string[];
}

/** Dependencies for the extension list operation. */
export interface ExtensionListDeps {
  readUpstreamExtensions: () => Promise<Record<string, UpstreamEntry>>;
}

/** Yields the list of installed upstream extensions. */
export async function* extensionList(
  _ctx: LibSwampContext,
  deps: ExtensionListDeps,
): AsyncIterable<ExtensionListEvent> {
  yield { kind: "resolving" };

  const upstreamData = await deps.readUpstreamExtensions();

  const entries: ExtensionListEntry[] = Object.entries(upstreamData)
    .map(([name, entry]) => ({
      name,
      version: entry.version,
      pulledAt: entry.pulledAt ?? "",
      files: entry.files ?? [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  yield { kind: "completed", data: { extensions: entries } };
}
