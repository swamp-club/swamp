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

import { z } from "zod";

/**
 * A report reference: either a string (report name, applies to all methods)
 * or an object with optional method scoping.
 */
const ReportRefSchema = z.union([
  z.string(),
  z.object({
    name: z.string(),
    methods: z.array(z.string()).optional(),
  }),
]);

/**
 * Schema for report selection in definition/workflow YAML.
 */
export const ReportSelectionSchema = z.object({
  require: z.array(ReportRefSchema).optional(),
  skip: z.array(z.string()).optional(),
}).optional();

/**
 * A report reference: string shorthand or object with method scoping.
 */
export type ReportRef = string | { name: string; methods?: string[] };

/**
 * Report selection (require/skip) from a definition or workflow.
 */
export type ReportSelection = {
  require?: ReportRef[];
  skip?: string[];
};
