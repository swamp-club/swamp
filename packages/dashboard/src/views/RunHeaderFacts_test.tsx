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
import { RunByFact } from "./RunHeaderFacts.tsx";

Deno.test("RunByFact: names the integration client a run was started through", () => {
  assertEquals(
    renderToStaticMarkup(
      <RunByFact initiatedBy="user:alice" client="integration:slackwater" />,
    ),
    '<div class="rd-fact"><dt>By</dt><dd><span class="rd-by" title="user:alice via integration:slackwater">user:alice<span class="client-via"> via integration:slackwater</span></span></dd></div>',
  );
});

Deno.test("RunByFact: a run started through a direct client shows who alone", () => {
  assertEquals(
    renderToStaticMarkup(
      <RunByFact initiatedBy="user:alice" client="direct:cli" />,
    ),
    '<div class="rd-fact"><dt>By</dt><dd><span class="rd-by" title="user:alice">user:alice</span></dd></div>',
  );
});

Deno.test("RunByFact: a run with no recorded client reads as before", () => {
  assertEquals(
    renderToStaticMarkup(<RunByFact initiatedBy="user:alice" />),
    '<div class="rd-fact"><dt>By</dt><dd><span class="rd-by" title="user:alice">user:alice</span></dd></div>',
  );
});
