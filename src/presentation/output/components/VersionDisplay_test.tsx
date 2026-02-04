// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { assertStringIncludes } from "@std/assert";
import { render } from "ink-testing-library";
import { VersionDisplay } from "./VersionDisplay.tsx";

// Ink testing library creates signal listeners that Deno detects as leaks
const inkTestOptions = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  name: "VersionDisplay renders version",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(<VersionDisplay version="1.0.0" />);
    const output = lastFrame() ?? "";
    assertStringIncludes(output, "swamp 1.0.0");
  },
});
