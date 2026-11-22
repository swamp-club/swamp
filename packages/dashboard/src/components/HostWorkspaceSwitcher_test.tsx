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
import { HostWorkspaceSelect } from "./HostWorkspaceSwitcher.tsx";

const LISTED = {
  kind: "listed" as const,
  workspaces: [
    { name: "edge-dns", state: "ready" as const },
    { name: "cost", state: "stopped" as const },
    { name: "zeta", state: "backoff" as const },
  ],
};

function options(html: string): string[] {
  return [...html.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)]
    .map(([, value, label]) => `${value}=${label}`);
}

Deno.test("HostWorkspaceSelect: lists the root and every workspace with its state, the page's own selected", () => {
  const html = renderToStaticMarkup(
    <HostWorkspaceSelect current="edge-dns" view={LISTED} />,
  );
  assert(
    JSON.stringify(options(html)) === JSON.stringify([
      "=Host root",
      "cost=cost (stopped)",
      "edge-dns=edge-dns",
      "zeta=zeta (starting)",
    ]),
    options(html).join(", "),
  );
  assertStringIncludes(html, '<option value="edge-dns" selected="">');
  assert(!html.includes("Sign in to the host"));
});

Deno.test("HostWorkspaceSelect: on the root page the root is selected", () => {
  const html = renderToStaticMarkup(
    <HostWorkspaceSelect current={null} view={LISTED} />,
  );
  assertStringIncludes(html, '<option value="" selected="">Host root</option>');
});

Deno.test("HostWorkspaceSelect: not signed in to the root, it shows the page's workspace and a link to sign in to the host", () => {
  const html = renderToStaticMarkup(
    <HostWorkspaceSelect current="edge-dns" view={{ kind: "sign-in" }} />,
  );
  assert(
    JSON.stringify(options(html)) ===
      JSON.stringify(["=Host root", "edge-dns=edge-dns"]),
    options(html).join(", "),
  );
  assertStringIncludes(html, 'href="/dashboard/"');
  assertStringIncludes(html, "Sign in to the host to see its workspaces");
});

Deno.test("HostWorkspaceSelect: before the list arrives, or when it cannot be read, the page's workspace is still shown", () => {
  for (
    const view of [
      { kind: "loading" as const },
      { kind: "listed" as const, workspaces: null },
    ]
  ) {
    const html = renderToStaticMarkup(
      <HostWorkspaceSelect current="edge-dns" view={view} />,
    );
    assertStringIncludes(html, '<option value="edge-dns" selected="">');
    assert(!html.includes("Sign in to the host"));
  }
});
