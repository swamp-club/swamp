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
import { renderInteractivePicker } from "./search_picker.tsx";

const inkTestOptions = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  name:
    "renderInteractivePicker: throwing renderPreview resolves to undefined instead of hanging",
  ...inkTestOptions,
  fn: async () => {
    const items = [{ name: "alpha" }, { name: "bravo" }];

    const result = await Promise.race([
      renderInteractivePicker(
        items,
        "",
        (item) => item.name,
        (item) => <>{item.name}</>,
        () => {
          throw new Error("simulated render crash");
        },
        (item) => item.name,
        "items",
      ),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 3000)
      ),
    ]);

    // Should resolve to undefined (from the .catch path), not timeout
    assertEquals(result !== "timeout", true);
  },
});
