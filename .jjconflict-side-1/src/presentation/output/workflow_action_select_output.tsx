// deno-lint-ignore verbatim-module-syntax
import React, { useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import type { OutputMode } from "./output.ts";

/**
 * Available actions after selecting a workflow from search.
 */
export type WorkflowAction = "view" | "run";

/**
 * Data for displaying workflow action selection.
 */
export interface WorkflowActionSelectData {
  workflowName: string;
  workflowDescription?: string;
  hasInputs: boolean;
}

interface ActionOption {
  action: WorkflowAction;
  label: string;
  description: string;
}

const ACTION_OPTIONS: ActionOption[] = [
  {
    action: "view",
    label: "View Details",
    description: "Show workflow definition and jobs",
  },
  {
    action: "run",
    label: "Run Workflow",
    description: "Execute this workflow",
  },
];

/**
 * Renders workflow action selection in either interactive or JSON mode.
 *
 * @param data - The workflow data for action selection
 * @param mode - The output mode (interactive or json)
 * @returns A promise that resolves with the selected action, or undefined if cancelled
 */
export async function renderWorkflowActionSelect(
  data: WorkflowActionSelectData,
  mode: OutputMode,
): Promise<WorkflowAction | undefined> {
  if (mode === "json") {
    // In JSON mode, default to "view" behavior (no action selection)
    return "view";
  } else {
    return await renderInteractiveWorkflowActionSelect(data);
  }
}

/**
 * Renders an interactive workflow action selection UI.
 */
function renderInteractiveWorkflowActionSelect(
  data: WorkflowActionSelectData,
): Promise<WorkflowAction | undefined> {
  return new Promise<WorkflowAction | undefined>((resolve) => {
    const { waitUntilExit } = render(
      <WorkflowActionSelectUI
        workflowName={data.workflowName}
        workflowDescription={data.workflowDescription}
        hasInputs={data.hasInputs}
        onSelect={(action) => resolve(action)}
        onCancel={() => resolve(undefined)}
      />,
    );
    waitUntilExit();
  });
}

interface WorkflowActionSelectUIProps {
  workflowName: string;
  workflowDescription?: string;
  hasInputs: boolean;
  onSelect: (action: WorkflowAction) => void;
  onCancel: () => void;
}

/**
 * Interactive workflow action selection component.
 */
export function WorkflowActionSelectUI(
  props: WorkflowActionSelectUIProps,
): React.ReactElement {
  const { workflowName, workflowDescription, onSelect, onCancel } = props;
  const { exit } = useApp();

  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      exit();
      onCancel();
      return;
    }

    if (key.return) {
      const selected = ACTION_OPTIONS[selectedIndex];
      exit();
      onSelect(selected.action);
      return;
    }

    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }

    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(ACTION_OPTIONS.length - 1, i + 1));
      return;
    }
  });

  return (
    <Box flexDirection="column">
      {/* Workflow info */}
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text color="cyan" bold>
            Workflow:{" "}
          </Text>
          <Text bold>{workflowName}</Text>
        </Box>
        {workflowDescription && (
          <Box>
            <Text dimColor>{workflowDescription}</Text>
          </Box>
        )}
      </Box>

      {/* Action options */}
      <Box flexDirection="column">
        <Text dimColor>Select an action:</Text>
        <Box flexDirection="column" marginTop={1}>
          {ACTION_OPTIONS.map((option, index) => (
            <ActionOptionItem
              key={option.action}
              option={option}
              isSelected={index === selectedIndex}
            />
          ))}
        </Box>
      </Box>

      {/* Help text */}
      <Box marginTop={1}>
        <Text dimColor>
          ↑/↓: Navigate | Enter: Select | Esc: Back to search
        </Text>
      </Box>
    </Box>
  );
}

interface ActionOptionItemProps {
  option: ActionOption;
  isSelected: boolean;
}

function ActionOptionItem(props: ActionOptionItemProps): React.ReactElement {
  const { option, isSelected } = props;

  return (
    <Box>
      <Text color={isSelected ? "green" : undefined} bold={isSelected}>
        {isSelected ? "▶ " : "  "}
        {option.label}
      </Text>
      <Text dimColor>- {option.description}</Text>
    </Box>
  );
}
