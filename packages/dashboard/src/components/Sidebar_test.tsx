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
import { Sidebar } from "./Sidebar.tsx";
import type { LogoutStep } from "./logout_confirm.ts";

const OLD_LOGOUT_ARROW = "M6 2H3v12h3M10 5l3 3-3 3M13 8H6";
const POWER = "M4.5 4.5a5 5 0 1 0 7 0M8 2v6";

function render(
  options: {
    local?: boolean;
    logoutStep?: LogoutStep;
    agentSessionsVisible?: boolean;
  } = {},
): string {
  return renderToStaticMarkup(
    <Sidebar
      activeView="overview"
      onNavigate={() => {}}
      health={null}
      approvalCount={0}
      agentSessionsVisible={options.agentSessionsVisible}
      local={options.local}
      onLogout={() => {}}
      collapsed
      onToggleCollapsed={() => {}}
      drawerOpen={false}
      onCloseDrawer={() => {}}
      initialLogoutStep={options.logoutStep}
    />,
  );
}

Deno.test("Sidebar: the collapsed Logout shows a power icon, not an arrow", () => {
  const html = render();
  assertStringIncludes(html, `d="${POWER}"`);
  assert(!html.includes(OLD_LOGOUT_ARROW), "the old arrow glyph is gone");
  // The expand toggle keeps its chevron.
  assertStringIncludes(html, 'aria-label="Expand sidebar"');
  assertStringIncludes(html, 'd="M6 3l5 5-5 5"');
});

Deno.test("Sidebar: the collapsed Logout carries a rail tooltip label", () => {
  const html = render();
  assertStringIncludes(html, 'aria-label="Logout"');
  assertStringIncludes(html, 'data-tooltip="Logout"');
});

Deno.test("Sidebar: Logout opens a confirm instead of logging out", () => {
  const idle = render();
  assert(!idle.includes("sidebar-logout-confirm"), "no confirm until asked");

  const html = render({ logoutStep: "confirming" });
  assertStringIncludes(html, 'aria-label="Confirm logout"');
  assertStringIncludes(html, "Log out of the dashboard?");
  const keep = html.indexOf(">Keep</button>");
  const logOut = html.indexOf(">Log out</button>");
  assert(keep !== -1 && logOut !== -1, "both choices are labelled");
  assert(keep < logOut, "Keep comes before Log out");
  // Confirming hides the hover label so it can't cover the flyout.
  assert(!html.includes('data-tooltip="Logout"'));
});

Deno.test("Sidebar: the local dashboard has no Logout", () => {
  const html = render({ local: true, logoutStep: "confirming" });
  assert(!html.includes('aria-label="Logout"'));
  assert(!html.includes("sidebar-logout-confirm"));
});

Deno.test("Sidebar: Agent sessions is hidden, not Off, until the viewer can read a session", () => {
  const hidden = render({ local: true });
  assert(!hidden.includes("Agent sessions"), "no item, faded or otherwise");
  const shown = render({ local: true, agentSessionsVisible: true });
  assertStringIncludes(shown, "Agent sessions");
  // Shown items are never marked Off.
  const at = shown.indexOf("Agent sessions");
  assert(!shown.slice(at, at + 200).includes("Needs swamp serve"));
});
