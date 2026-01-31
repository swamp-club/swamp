// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { render } from "ink-testing-library";
import { VersionDisplay } from "./components/VersionDisplay.tsx";

export type OutputMode = "interactive" | "json" | "stream";

export interface VersionData {
  version: string;
  haiku: string;
}

export function renderVersion(data: VersionData, mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderInteractiveVersion(data);
  }
}

function renderInteractiveVersion(data: VersionData): void {
  const { lastFrame } = render(
    <VersionDisplay version={data.version} haiku={data.haiku} />,
  );
  console.log(lastFrame());
}
