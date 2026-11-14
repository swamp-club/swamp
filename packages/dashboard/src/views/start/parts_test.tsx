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
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderToStaticMarkup } from "react-dom/server";
import { OwnAgentPrompt } from "./parts.tsx";

const PROMPT =
  "Read the brief at /ws/tasks/2026-11-14-x.md and follow it. If the swamp-getting-started skill isn't loaded, read .claude/skills/swamp-getting-started/SKILL.md in the workspace the brief names.";

function render(apiKeyFromEnv = false, copied = false): string {
  return renderToStaticMarkup(
    <OwnAgentPrompt
      prompt={PROMPT}
      apiKeyFromEnv={apiKeyFromEnv}
      dashboardHref="/dashboard/w/demo"
      initiallyCopied={copied}
    />,
  );
}

Deno.test("OwnAgentPrompt: shows the steps and the prompt with a Copy button, and no terminal command", () => {
  const html = render();
  assertStringIncludes(html, "Copy the prompt.");
  assertStringIncludes(html, "Open your agent app");
  assertStringIncludes(
    html,
    `<pre class="start-command-text">${PROMPT.replaceAll("'", "&#x27;")}</pre>`,
  );
  assertStringIncludes(html, 'aria-label="Copy prompt"');
  assert(!html.toLowerCase().includes("open a terminal"));
});

Deno.test("OwnAgentPrompt: a copy icon in the prompt's corner, then step 3 and the dashboard button", () => {
  const before = render();
  assertStringIncludes(
    before,
    'class="start-copy-icon" aria-label="Copy prompt" title="Copy prompt"><svg',
  );
  assertEquals(before.includes(">Copy prompt</button>"), false);
  const step = before.indexOf(
    "<li>Once your agent is running, head over to the dashboard.</li>",
  );
  assert(step > before.indexOf("start-command-text"), before);
  assert(step < before.indexOf("Open the dashboard</a>"), before);
  assertStringIncludes(
    before,
    '<a class="start-primary start-dashboard-link" href="/dashboard/w/demo">Open the dashboard</a>',
  );
  assertStringIncludes(render(false, true), 'aria-label="Copied"');
});

Deno.test("OwnAgentPrompt: names SWAMP_API_KEY only when the key comes from the environment", () => {
  assertEquals(render(false).includes("SWAMP_API_KEY"), false);
  assertStringIncludes(render(true), "<code>SWAMP_API_KEY</code>");
});

Deno.test("OwnAgentPrompt: a swampify task's link names Swampify", () => {
  const html = renderToStaticMarkup(
    <OwnAgentPrompt
      prompt={PROMPT}
      apiKeyFromEnv={false}
      dashboardHref="/dashboard/w/demo/swampify"
      dashboardName="Swampify"
      initiallyCopied
    />,
  );
  assertStringIncludes(
    html,
    'href="/dashboard/w/demo/swampify">Open Swampify</a>',
  );
});
