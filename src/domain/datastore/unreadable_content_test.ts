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

import { assert } from "@std/assert";
import { UserError } from "../errors.ts";
import {
  isUnreadableContentError,
  UNREADABLE_CONTENT_CODE,
} from "./unreadable_content.ts";
import { UNREADABLE_RECORD_CODE } from "../datastore_v3/read_model.ts";

Deno.test("isUnreadableContentError: matches the unreadable code only", () => {
  assert(
    isUnreadableContentError(new UserError("x", UNREADABLE_CONTENT_CODE)),
  );
  assert(!isUnreadableContentError(new UserError("x", "other_code")));
  assert(!isUnreadableContentError(new UserError("x")));
  assert(!isUnreadableContentError(new Error("x")));
  assert(!isUnreadableContentError(undefined));
});

Deno.test("isUnreadableContentError: the v3 read model's error code is the same code", () => {
  assert(UNREADABLE_RECORD_CODE === UNREADABLE_CONTENT_CODE);
});
