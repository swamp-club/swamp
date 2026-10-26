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
 * `@swamp-club/extension-scoring` — how Swamp Club scores an extension.
 *
 * The extension quality rubric, and every rule it rests on, shared by the
 * swamp CLI (`swamp extension quality` and `push`) and the Swamp Club
 * registry's scorecard so both score an archive the same way:
 *
 * - `./rubric` — the factor table and the score composed from it
 * - `./archive` — which files in an archive count, and how `deno doc` runs
 * - `./licensing` — SPDX expressions and the manifest license policy
 * - `./secret-docs` — documentation that handles a secret in plaintext
 * - `./dependency-audit` — the `npm:` and `jsr:` dependency trust audit
 * - `./doc-failure` — why `deno doc` could not analyse a source
 * - `./source` — reading import specifiers without parsing
 * - `./vectors/*.json` — shared test vectors every consumer runs
 *
 * Everything here is pure TypeScript with no runtime APIs: the caller
 * extracts archives, runs `deno doc` and fetches from npm, OSV and JSR.
 *
 * ```ts
 * import { composeScore, RUBRIC_VERSION } from "@swamp-club/extension-scoring/rubric";
 * ```
 *
 * @module
 */

export * from "./rubric/mod.ts";
