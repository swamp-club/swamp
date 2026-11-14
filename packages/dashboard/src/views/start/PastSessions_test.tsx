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

function render(open = false): string {
  return renderToStaticMarkup(
    <PastSessionsPanel
      status={STATUS}
      client={CLIENT}
      onStatus={() => {}}
      taken={[]}
      disabled={false}
      open={open}
      onOpenChange={() => {}}
    />,
  );
}

Deno.test("PastSessionsPanel: collapsed, it is one line with the Swampify icon and a Swampify! button", () => {
  const html = render();
  assertStringIncludes(html, 'class="start-past-card"');
  assertStringIncludes(html, NAV_ICONS.swampify);
  assertStringIncludes(html, PAST_SESSIONS_CARD_TEXT);
  assertStringIncludes(html, ">Swampify!</button>");
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
      ">Every session on this machine</button>",
      'aria-expanded="false"',
      'name="start-past-agent"',
      'id="start-past-name"',
      ">Launch Claude Code</button>",
    ]
  ) {
    assertStringIncludes(html, part);
  }
});

Deno.test("PastSessionsPanel: open, the scope is every session until the user limits it", () => {
  const html = render(true);
  assertEquals(html.includes("<textarea"), false);
  assertStringIncludes(html, 'class="start-input start-select"');
  assertStringIncludes(
    html,
    '<button type="button" class="start-past-scope" aria-expanded="false" aria-controls="start-past-exclude">Every session on this machine</button>',
  );
});

Deno.test("PastSessionsPanel: open, each agent with history is a small card with its badge, the picked one selected", () => {
  const html = render(true);
  assertStringIncludes(html, 'role="radiogroup"');
  assertStringIncludes(
    html,
    'class="start-past-agent-card start-past-agent-card-selected"',
  );
  assertStringIncludes(html, "start-agent-badge-md");
  assertStringIncludes(html, ">Claude Code</span>");
  assertEquals(html.includes(">Codex</span>"), false);
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

Deno.test("PastSessionsPanel: open, the window offers 7 to 365 days and all history, 30 picked, no note", () => {
  const html = render(true);
  for (
    const option of [
      '<option value="7">Last 7 days</option>',
      '<option value="30" selected="">Last 30 days</option>',
      '<option value="90">Last 90 days</option>',
      '<option value="180">Last 180 days</option>',
      '<option value="365">Last 365 days</option>',
      '<option value="all">All history</option>',
    ]
  ) {
    assertStringIncludes(html, option);
  }
  assertEquals(html.includes("takes longer to assess"), false);
});

Deno.test("PastSessionsPanel: open, Use my own agent sits before Launch, which names the picked agent", () => {
  const html = render(true);
  assertStringIncludes(
    html,
    '<button type="button" class="start-secondary">Use my own agent</button>',
  );
  assert(
    html.indexOf(">Use my own agent<") < html.indexOf(">Launch Claude Code<"),
  );
  assertEquals(html.includes(">Swampify!</button>"), false);
  assertStringIncludes(html, "nothing opens.");
});
