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
import { Text } from "ink";
import { renderMarkdownToTerminal } from "../../../markdown_renderer.ts";

const SEPARATOR_WIDTH = 60;

interface ReportBlockProps {
  name: string;
  markdown: string;
}

export function ReportBlock({ name, markdown }: ReportBlockProps) {
  const separator = "\u2500".repeat(SEPARATOR_WIDTH);
  const headerSep = `\u2500\u2500 ${name} ` +
    "\u2500".repeat(Math.max(0, SEPARATOR_WIDTH - name.length - 4));
  const rendered = renderMarkdownToTerminal(markdown);

  return (
    <>
      <Text dimColor>{headerSep}</Text>
      <Text>{rendered}</Text>
      <Text dimColor>{separator}</Text>
    </>
  );
}

interface ReportErrorBlockProps {
  name: string;
  error: string;
}

export function ReportErrorBlock({ name, error }: ReportErrorBlockProps) {
  return (
    <Text color="red">
      Report {name} failed: {error}
    </Text>
  );
}
