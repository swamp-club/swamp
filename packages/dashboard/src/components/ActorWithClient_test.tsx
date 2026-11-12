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
import { assertEquals, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { ActorWithClient } from "./ActorWithClient.tsx";

Deno.test("ActorWithClient: names an integration client after the actor", () => {
  const html = renderToStaticMarkup(
    <ActorWithClient actor="alice" client="integration:slackwater" />,
  );
  assertStringIncludes(html, 'title="alice via integration:slackwater"');
  assertStringIncludes(
    html,
    '<span class="client-via"> via integration:slackwater</span>',
  );
});

Deno.test("ActorWithClient: a direct client shows the actor alone", () => {
  assertEquals(
    renderToStaticMarkup(
      <ActorWithClient actor="alice" client="direct:dashboard" className="x" />,
    ),
    '<span class="x" title="alice">alice</span>',
  );
});

Deno.test("ActorWithClient: no client shows the actor alone", () => {
  assertEquals(
    renderToStaticMarkup(<ActorWithClient actor="user:sub-1" />),
    '<span title="user:sub-1">user:sub-1</span>',
  );
});
