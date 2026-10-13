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
import { assert, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { LoadError } from "./LoadError.tsx";

Deno.test("LoadError: names what failed, shows serve's message and a retry", () => {
  const html = renderToStaticMarkup(
    <LoadError subject="vaults" message="socket closed" onRetry={() => {}} />,
  );
  assertStringIncludes(html, 'role="alert"');
  assertStringIncludes(html, "Couldn&#x27;t load vaults.");
  assertStringIncludes(html, "socket closed");
  assertStringIncludes(
    html,
    '<button type="button" class="btn-sm">Retry</button>',
  );
});

Deno.test("LoadError: inset adds panel margins", () => {
  const html = renderToStaticMarkup(
    <LoadError subject="keys" message={null} onRetry={() => {}} inset />,
  );
  assertStringIncludes(html, "margin:12px 18px");
  assert(!html.includes("null"));
});
