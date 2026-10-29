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

// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { assertEquals } from "@std/assert";
import { render } from "ink-testing-library";
import { HelpBar } from "./help_bar.tsx";

const inkTestOptions = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  name: "HelpBar: without keys, the picker's hints are unchanged",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <HelpBar
        hasPreview
        actions={[{ key: "i", label: "Install", action: "install" }]}
      />,
    );

    assertEquals(
      lastFrame(),
      "↑/↓ navigate  Ctrl-u/d scroll preview  Ctrl-i install  Enter select  Esc cancel",
    );
  },
});

Deno.test({
  name: "HelpBar: keys replace every default hint",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <HelpBar hasPreview keys={["Enter open", "Esc quit"]} />,
    );

    assertEquals(lastFrame(), "Enter open  Esc quit");
  },
});
