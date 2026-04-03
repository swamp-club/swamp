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

import type { SwampError } from "../errors.ts";
import type { ExtensionKind } from "../../domain/repo/swamp_sources.ts";

/** Data returned when a source is added or removed. */
export interface SourceModifyData {
  action: "added" | "removed";
  path: string;
  only?: ExtensionKind[];
  totalSources: number;
}

/** Events emitted by source add/remove operations. */
export type SourceModifyEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: SourceModifyData }
  | { kind: "error"; error: SwampError };

/** A single source entry with resolution status. */
export interface SourceListEntry {
  path: string;
  only?: ExtensionKind[];
  expandedPaths: string[];
  status: "valid" | "path_not_found" | "no_extensions";
}

/** Data returned by the source list operation. */
export interface SourceListData {
  sources: SourceListEntry[];
}

/** Events emitted by the source list operation. */
export type SourceListEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: SourceListData }
  | { kind: "error"; error: SwampError };
