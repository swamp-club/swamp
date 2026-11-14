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
import { handOffCopied, OwnAgentPrompt } from "./parts.tsx";

const PROMPT =
  "Read the brief at /ws/tasks/2026-11-14-x.md and follow it. If the swamp-getting-started skill isn't loaded, read .claude/skills/swamp-getting-started/SKILL.md in the workspace the brief names.";

function render(apiKeyFromEnv = false, copied = false): string {
  return renderToStaticMarkup(
    <OwnAgentPrompt
      prompt={PROMPT}
      apiKeyFromEnv={apiKeyFromEnv}
      copied={copied}
    />,
  );
}

Deno.test("OwnAgentPrompt: shows the steps and the prompt with a Copy button, and no terminal command", () => {
  const html = render();
  assertStringIncludes(html, "Open your agent app");
  assertStringIncludes(html, "Paste this prompt.");
  assertStringIncludes(
    html,
    `<pre class="start-command-text">${PROMPT.replaceAll("'", "&#x27;")}</pre>`,
  );
  assertStringIncludes(html, ">Copy prompt</button>");
  assert(!html.toLowerCase().includes("open a terminal"));
});

Deno.test("OwnAgentPrompt: says Copied when the hand-off already copied it", () => {
  assertStringIncludes(render(false, true), ">Copied</button>");
});

Deno.test("OwnAgentPrompt: names SWAMP_API_KEY only when the key comes from the environment", () => {
  assertEquals(render(false).includes("SWAMP_API_KEY"), false);
  assertStringIncludes(render(true), "<code>SWAMP_API_KEY</code>");
});

Deno.test("handOffCopied: false for a task this page never handed off", () => {
  assertEquals(handOffCopied(undefined), false);
  assertEquals(handOffCopied(crypto.randomUUID()), false);
});
