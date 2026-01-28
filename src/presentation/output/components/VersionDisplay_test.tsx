// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { assertStringIncludes } from "@std/assert";
import { render } from "ink-testing-library";
import { VersionDisplay } from "./VersionDisplay.tsx";

// Ink testing library creates signal listeners that Deno detects as leaks
const inkTestOptions = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  name: "VersionDisplay renders version with prefix",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <VersionDisplay version="1.0.0" haiku="test haiku" />,
    );

    const output = lastFrame() ?? "";
    assertStringIncludes(output, "swamp v1.0.0");
  },
});

Deno.test({
  name: "VersionDisplay renders haiku text",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <VersionDisplay version="1.0.0" haiku="line one\nline two\nline three" />,
    );

    const output = lastFrame() ?? "";
    assertStringIncludes(output, "line one");
    assertStringIncludes(output, "line two");
    assertStringIncludes(output, "line three");
  },
});

Deno.test({
  name: "VersionDisplay renders multi-line haiku with indentation",
  ...inkTestOptions,
  fn: () => {
    const { lastFrame } = render(
      <VersionDisplay version="1.0.0" haiku="test line" />,
    );

    const output = lastFrame() ?? "";
    // Box paddingLeft={2} adds 2 spaces of indentation
    assertStringIncludes(output, "  test line");
  },
});
