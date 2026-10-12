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
import { SearchBar, type SearchFacet } from "./SearchBar.tsx";

const facets = (selected: readonly string[]): SearchFacet[] => [{
  key: "prefix",
  label: "Prefix",
  description: "Name prefix",
  values: [
    { value: "deploy", label: "deploy", hint: "12" },
    { value: "sync", label: "sync", hint: "10" },
  ],
  selected,
  onSelect: () => {},
}];

Deno.test("SearchBar: one search box, no selects, a / shortcut when idle", () => {
  const html = renderToStaticMarkup(
    <SearchBar
      query=""
      onQuery={() => {}}
      facets={facets([])}
      onClear={() => {}}
    />,
  );
  assertStringIncludes(html, 'role="search"');
  assertStringIncludes(html, 'role="combobox"');
  assertStringIncludes(html, 'aria-expanded="false"');
  assertStringIncludes(html, "<kbd");
  assert(!html.includes("<select"));
  assert(!html.includes("qchip"));
});

Deno.test("SearchBar: applied filters show as removable chips", () => {
  const html = renderToStaticMarkup(
    <SearchBar
      query=""
      onQuery={() => {}}
      facets={facets(["deploy", "sync"])}
      onClear={() => {}}
      shown={3}
      total={141}
      noun="workflows"
    />,
  );
  assertStringIncludes(html, '<span class="qchip-key">Prefix</span>');
  // Several values of one filter read as OR.
  assertStringIncludes(html, '<span class="qchip-val">deploy or sync</span>');
  assertStringIncludes(html, 'aria-label="Remove Prefix: deploy or sync"');
  assertStringIncludes(html, "3 of 141 workflows");
  assertStringIncludes(html, "Clear");
});
