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
import { Select } from "./Select.tsx";

const options = [
  { value: "", label: "All prefixes" },
  { value: "deploy", label: "deploy", hint: "12" },
];

Deno.test("Select: a closed combobox showing the chosen label", () => {
  const html = renderToStaticMarkup(
    <Select
      value="deploy"
      onChange={() => {}}
      options={options}
      ariaLabel="Prefix"
    />,
  );
  assertStringIncludes(html, 'role="combobox"');
  assertStringIncludes(html, 'aria-haspopup="listbox"');
  assertStringIncludes(html, 'aria-expanded="false"');
  assertStringIncludes(html, 'aria-label="Prefix"');
  assertStringIncludes(html, ">deploy</span>");
  // The menu isn't rendered until it opens, and nothing is a native select.
  assert(!html.includes('role="listbox"'));
  assert(!html.includes("<select"));
});

Deno.test("Select: placeholder when the value matches no option", () => {
  const html = renderToStaticMarkup(
    <Select
      value="gone"
      onChange={() => {}}
      options={options}
      ariaLabel="Prefix"
      placeholder="Pick one"
    />,
  );
  assertStringIncludes(html, "is-placeholder");
  assertStringIncludes(html, "Pick one");
});

Deno.test("Select: labelled by a visible label when given one", () => {
  const html = renderToStaticMarkup(
    <Select value="" onChange={() => {}} options={options} labelledBy="lbl" />,
  );
  assertStringIncludes(html, 'aria-labelledby="lbl ');
  assert(!html.includes("aria-label="));
});
