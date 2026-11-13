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
import { NAV_ICONS } from "../../components/nav_icons.tsx";
import type { StartClient } from "./client.ts";
import { PAST_SESSIONS_CARD_TEXT, PastSessionsPanel } from "./PastSessions.tsx";
import { WorkspaceSections } from "./parts.tsx";
import type { StartStatus } from "./types.ts";

const STATUS: StartStatus = {
  workspacePath: null,
  workspaceName: null,
  signedIn: "signed_in",
  screen: "workspace",
  enrolledTools: [],
  apiKeyFromEnv: false,
  trusted: false,
  signals: {
    kubeconfig: false,
    awsConfig: false,
    gcloudAdc: false,
    claudeTranscripts: true,
    codexSessions: false,
  },
};

// Static rendering runs no effects, so the client is never called.
const CLIENT = {} as unknown as StartClient;

function render(initialOpen?: boolean): string {
  return renderToStaticMarkup(
    <PastSessionsPanel
      status={STATUS}
      client={CLIENT}
      onStatus={() => {}}
      taken={[]}
      disabled={false}
      initialOpen={initialOpen}
    />,
  );
}

Deno.test("PastSessionsPanel: collapsed, it is one line with the Swampify icon and a swampify! button", () => {
  const html = render();
  assertStringIncludes(html, 'class="start-past-card"');
  assertStringIncludes(html, NAV_ICONS.swampify);
  assertStringIncludes(html, PAST_SESSIONS_CARD_TEXT);
  assertStringIncludes(html, ">swampify!</button>");
  assertEquals(html.includes("<form"), false);
  assertEquals(html.includes("What it reads"), false);
});

Deno.test("PastSessionsPanel: open, it shows the disclosure, window, scope, agent and workspace name", () => {
  const html = render(true);
  assertEquals(html.includes('class="start-past-card"'), false);
  for (
    const part of [
      "Start from your past sessions",
      "What it reads:",
      "What the workspace stores:",
      "Where it goes:",
      'id="start-past-window"',
      'id="start-past-exclude"',
      'name="start-past-agent"',
      'id="start-past-name"',
      "Create workspace from past sessions",
    ]
  ) {
    assertStringIncludes(html, part);
  }
});

Deno.test("WorkspaceSections: the past-sessions card comes before the workspace list and create form", () => {
  const html = renderToStaticMarkup(
    <WorkspaceSections
      pastSessions={<i>card</i>}
      workspaces={<i>workspaces</i>}
      after={<i>steps</i>}
    />,
  );
  const card = html.indexOf("card");
  const workspaces = html.indexOf("workspaces");
  assert(card !== -1 && card < workspaces, html);
  assert(workspaces < html.indexOf("steps"), html);
});
