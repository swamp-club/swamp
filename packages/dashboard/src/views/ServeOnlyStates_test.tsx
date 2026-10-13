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
import { assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SCHEDULE_MANUAL_LINKS,
  SchedulesLocalState,
  WEBHOOK_MANUAL_LINKS,
  WebhooksLocalState,
} from "./ServeOnlyStates.tsx";

const copy = () => Promise.resolve(true);

Deno.test("SchedulesLocalState: says schedules need swamp serve and how to turn them on", () => {
  const html = renderToStaticMarkup(<SchedulesLocalState copy={copy} />);
  assertStringIncludes(html, 'class="act-state act-disabled"');
  assertStringIncludes(html, 'data-local-state="schedules"');
  assertStringIncludes(html, "Schedules off");
  assertStringIncludes(html, "<code>swamp serve</code>");
  assertStringIncludes(html, "trigger:");
  assertStringIncludes(html, "swamp serve --dashboard");
  for (const link of SCHEDULE_MANUAL_LINKS) {
    assertStringIncludes(html, `href="${link.href}"`);
  }
});

Deno.test("WebhooksLocalState: says webhooks need swamp serve and shows the serve.yaml entry", () => {
  const html = renderToStaticMarkup(<WebhooksLocalState copy={copy} />);
  assertStringIncludes(html, 'class="act-state act-disabled"');
  assertStringIncludes(html, 'data-local-state="webhooks"');
  assertStringIncludes(html, "Webhooks off");
  assertStringIncludes(html, ".swamp/serve.yaml");
  assertStringIncludes(html, "webhooks:");
  assertStringIncludes(html, "swamp serve check-config");
  for (const link of WEBHOOK_MANUAL_LINKS) {
    assertStringIncludes(html, `href="${link.href}"`);
  }
});
