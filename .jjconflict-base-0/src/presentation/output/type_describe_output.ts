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

// Re-export shim: types from libswamp, formatting from renderers.
// This file is retained for backward compatibility with un-migrated commands
// (model_create_output.ts, type_describe_output_test.ts).

export type {
  DataOutputSpecDescribeData,
  MethodDescribeData,
} from "../../libswamp/types/schema_helpers.ts";

export type { TypeDescribeData } from "../../libswamp/types/describe.ts";

export {
  formatMethodLines,
  formatSchemaAttributes,
} from "../renderers/model_get.ts";

export { renderTypeDescribe } from "../renderers/type_describe.ts";
