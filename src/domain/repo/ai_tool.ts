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

/**
 * The AI coding tool a swamp repo is enrolled for. Materialised in
 * .swamp.yaml under `tools` and surfaced to telemetry, audit, skills
 * resolution, and doctor checks.
 *
 * `none` is a marker-file sentinel meaning "explicitly opted out of tool
 * integration." The legacy single-tool field `tool: none` normalises to the
 * canonical `tools: []`; the union value is preserved for read-side
 * compatibility but is never written.
 */
export type AiTool =
  | "claude"
  | "cursor"
  | "opencode"
  | "codex"
  | "copilot"
  | "kiro"
  | "none";
