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

/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { assertEquals } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { PreviewChip } from "./PreviewChip.tsx";

Deno.test("PreviewChip: says Preview in words, with a title saying it may change", () => {
  assertEquals(
    renderToStaticMarkup(<PreviewChip />),
    '<span class="preview-chip" title="A preview: what it shows may change">Preview</span>',
  );
});

Deno.test("PreviewChip: a placement class is added to the shared one", () => {
  assertEquals(
    renderToStaticMarkup(<PreviewChip className="spot" />),
    '<span class="preview-chip spot" title="A preview: what it shows may change">Preview</span>',
  );
});
