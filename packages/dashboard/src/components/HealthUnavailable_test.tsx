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
import { HealthUnavailable } from "./HealthUnavailable.tsx";

Deno.test("HealthUnavailable: loading renders a busy skeleton, not text", () => {
  const html = renderToStaticMarkup(
    <HealthUnavailable state="loading" subject="schedules" />,
  );
  assertStringIncludes(html, 'aria-busy="true"');
  assertStringIncludes(html, "Loading schedules");
  assertStringIncludes(html, 'class="skel-list-row"');
  assert(!html.includes("…"));
});

Deno.test("HealthUnavailable: loading wraps a given skeleton in the region", () => {
  const html = renderToStaticMarkup(
    <HealthUnavailable
      state="loading"
      subject="webhooks"
      skeleton={<div className="my-rows" />}
    />,
  );
  assertStringIncludes(html, 'aria-busy="true"');
  assertStringIncludes(html, "Loading webhooks");
  assertStringIncludes(html, 'class="my-rows"');
  assert(!html.includes("skel-list-row"));
});

Deno.test("HealthUnavailable: denied explains the refusal as an alert", () => {
  const html = renderToStaticMarkup(
    <HealthUnavailable state="denied" subject="schedules" />,
  );
  assertStringIncludes(html, 'role="alert"');
  assertStringIncludes(html, "Access denied");
  assert(!html.includes("aria-busy"));
});
