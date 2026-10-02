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

/**
 * Reports whether a parsed YAML document is a workflow definition — an
 * object with a top-level `jobs` key — rather than some other YAML that
 * happens to live next to workflows, such as an extension manifest or a
 * data file an extension ships for a model to read.
 *
 * Only the key's presence is checked, not its shape, so a workflow whose
 * `jobs` is malformed still counts and its construction error surfaces.
 */
export function isWorkflowDocument(
  data: unknown,
): data is Record<string, unknown> {
  return data !== null && typeof data === "object" && !Array.isArray(data) &&
    Object.hasOwn(data, "jobs");
}
