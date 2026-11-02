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

import type { SwampError } from "../errors.ts";
import type { ExtensionKind } from "../../domain/repo/swamp_sources.ts";

export interface SourceModifyData {
  action: "added" | "removed";
  path: string;
  only?: ExtensionKind[];
  totalSources: number;
  installedSkills?: string[];
}

export type SourceModifyEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: SourceModifyData }
  | { kind: "error"; error: SwampError };

export interface SourceListEntry {
  path: string;
  only?: ExtensionKind[];
  expandedPaths: string[];
  status: "valid" | "path_not_found" | "no_extensions";
  /**
   * extension kinds this source contributes, from the same resolver used at
   * load time; populated when status is valid and sorted by EXTENSION_KINDS
   * order so output is stable. Optional so older JSON consumers keep working
   */
  resolvedKinds?: ExtensionKind[];
}

export interface SourceListData {
  sources: SourceListEntry[];
}

export type SourceListEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: SourceListData }
  | { kind: "error"; error: SwampError };
