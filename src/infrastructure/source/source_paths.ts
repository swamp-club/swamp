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

import { join } from "@std/path";
import { homeDirectory } from "../persistence/paths.ts";

/**
 * Get the swamp source directory path.
 * Located at ~/.swamp/source/
 */
export function getSwampSourceDir(): string {
  return join(homeDirectory(), ".swamp", "source");
}

/**
 * Get the path to the source metadata file.
 * Located at ~/.swamp/source/.swamp-source-meta.json
 */
export function getSourceMetaPath(): string {
  return join(getSwampSourceDir(), ".swamp-source-meta.json");
}
