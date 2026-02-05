// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import type { OutputMode } from "./output.tsx";

/**
 * Data structure for model edit output.
 */
export interface ModelEditData {
  path: string;
  editor?: string;
  status: "opened" | "updated";
  name: string;
  type: string;
  editType: "input" | "resource" | "definition";
}

/**
 * Renders model edit output in either interactive or JSON mode.
 */
export function renderModelEdit(data: ModelEditData, mode: OutputMode): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderInteractiveModelEdit(data);
  }
}

function renderInteractiveModelEdit(data: ModelEditData): void {
  const { lastFrame } = render(<ModelEditDisplay {...data} />);
  console.log(lastFrame());
}

interface ModelEditDisplayProps {
  path: string;
  editor?: string;
  status: "opened" | "updated";
  name: string;
  type: string;
  editType: "input" | "resource" | "definition";
}

/**
 * Interactive display component for model edit output.
 */
export function ModelEditDisplay(
  props: ModelEditDisplayProps,
): React.ReactElement {
  const fileTypeLabel = props.editType === "resource"
    ? "resource"
    : props.editType === "definition"
    ? "definition"
    : "input";

  const header = props.status === "updated"
    ? `Updated ${fileTypeLabel} from stdin:`
    : `Opening ${fileTypeLabel} file in ${props.editor}:`;

  return (
    <Box flexDirection="column">
      <Text color="green">{header}</Text>
      <Box marginLeft={2} flexDirection="column">
        <Text>
          <Text color="cyan">Name:</Text>
          <Text>{props.name}</Text>
        </Text>
        <Text>
          <Text color="cyan">Type:</Text>
          <Text>{props.type}</Text>
        </Text>
        <Text>
          <Text color="cyan">Path:</Text>
          <Text dimColor>{props.path}</Text>
        </Text>
      </Box>
    </Box>
  );
}
