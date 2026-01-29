// deno-lint-ignore-file verbatim-module-syntax
import React, { useCallback, useEffect, useReducer } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { WorkflowHeader } from "./WorkflowHeader.tsx";
import { JobsPanel } from "./JobsPanel.tsx";
import { StepsPanel } from "./StepsPanel.tsx";
import { HotkeyBar } from "./HotkeyBar.tsx";
import { YamlOverlay } from "./YamlOverlay.tsx";
import {
  createInitialState,
  type ExecutionAction,
  executionReducer,
} from "./execution_reducer.ts";
import type { WorkflowData } from "../../../../domain/workflows/workflow.ts";
import type { JobRunData } from "../../workflow_run_output.tsx";
import { useTerminalSize } from "../../hooks/mod.ts";

/**
 * Computes pending dependencies (ones that haven't succeeded yet).
 */
function getPendingDependencies(
  allDeps: string[],
  statuses: Map<string, string>,
): string[] {
  return allDeps.filter((dep) => {
    const status = statuses.get(dep);
    return status !== "succeeded" && status !== "skipped";
  });
}

interface WorkflowExecutionUIProps {
  workflow: WorkflowData;
  workflowYaml: string;
  onExit: () => void;
  registerDispatch: (dispatch: React.Dispatch<ExecutionAction>) => void;
}

/**
 * Main interactive workflow execution UI component.
 */
export function WorkflowExecutionUI(
  { workflow, workflowYaml, onExit, registerDispatch }:
    WorkflowExecutionUIProps,
): React.ReactElement {
  const { exit } = useApp();
  const { width: terminalWidth, height: terminalHeight } = useTerminalSize();

  const [state, dispatch] = useReducer(
    executionReducer,
    createInitialState(workflow, workflowYaml),
  );

  // Register dispatch with parent for event handling
  useEffect(() => {
    registerDispatch(dispatch);
  }, [dispatch, registerDispatch]);

  const handleExit = useCallback(() => {
    exit();
    onExit();
  }, [exit, onExit]);

  // Handle keyboard input - disabled when overlay is shown
  useInput(
    (input, key) => {
      // Tab switches between panels
      if (key.tab) {
        dispatch({ type: "SWITCH_PANEL" });
        return;
      }

      // Navigation based on active panel
      if (key.upArrow) {
        if (state.activePanel === "jobs") {
          dispatch({ type: "SELECT_PREV_JOB" });
        } else {
          dispatch({ type: "SELECT_PREV_STEP" });
        }
        return;
      }

      if (key.downArrow) {
        if (state.activePanel === "jobs") {
          dispatch({ type: "SELECT_NEXT_JOB" });
        } else {
          dispatch({ type: "SELECT_NEXT_STEP" });
        }
        return;
      }

      // Toggle YAML overlay
      if (input === "l") {
        dispatch({ type: "TOGGLE_YAML_OVERLAY" });
        return;
      }

      // Quit (only when complete)
      if (input === "q" && state.isComplete) {
        handleExit();
        return;
      }
    },
    { isActive: !state.showYamlOverlay },
  );

  // If showing YAML overlay, render it fullscreen
  if (state.showYamlOverlay) {
    return (
      <YamlOverlay
        yaml={workflowYaml}
        workflowName={workflow.name}
        onClose={() => dispatch({ type: "CLOSE_YAML_OVERLAY" })}
        isActive={state.showYamlOverlay}
      />
    );
  }

  // Get current data for display
  const jobs: JobRunData[] = state.workflowRun?.jobs ??
    workflow.jobs.map((job) => ({
      name: job.name,
      status: "pending" as const,
      steps: job.steps.map((step) => ({
        name: step.name,
        status: "pending" as const,
      })),
    }));

  const selectedJob = jobs[state.selectedJobIndex];
  const workflowStatus = state.workflowRun?.status ?? "pending";

  // Compute pending dependencies for jobs
  const jobStatuses = new Map(jobs.map((j) => [j.name, j.status]));
  const jobPendingDeps = new Map<string, string[]>();
  for (const job of workflow.jobs) {
    const allDeps = job.dependsOn.map((d) => d.job);
    const pendingDeps = getPendingDependencies(allDeps, jobStatuses);
    jobPendingDeps.set(job.name, pendingDeps);
  }

  // Compute pending dependencies for steps of selected job
  const stepPendingDeps = new Map<string, string[]>();
  if (selectedJob) {
    const stepStatuses = new Map(
      selectedJob.steps.map((s) => [s.name, s.status]),
    );
    const workflowJob = workflow.jobs[state.selectedJobIndex];
    if (workflowJob) {
      for (const step of workflowJob.steps) {
        const allDeps = step.dependsOn.map((d) => d.step);
        const pendingDeps = getPendingDependencies(allDeps, stepStatuses);
        stepPendingDeps.set(step.name, pendingDeps);
      }
    }
  }

  // Calculate available height for panels
  // Total height minus: outer border (2) + header (3) + hotkey bar (1)
  const availableContentHeight = terminalHeight - 6;

  // Split evenly between JobsPanel and StepsPanel
  const panelHeight = Math.floor(availableContentHeight / 2);

  // Show warning if terminal is too small
  const minWidth = 60;
  const minHeight = 15;
  if (terminalWidth < minWidth || terminalHeight < minHeight) {
    return (
      <Box
        flexDirection="column"
        width={terminalWidth}
        height={terminalHeight}
        borderStyle="round"
        borderColor="yellow"
        alignItems="center"
        justifyContent="center"
      >
        <Text color="yellow" bold>Terminal too small</Text>
        <Text dimColor>
          Minimum: {minWidth}x{minHeight}, Current: {terminalWidth}x
          {terminalHeight}
        </Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      width={terminalWidth}
      height={terminalHeight}
      borderStyle="round"
      borderColor="gray"
      overflow="hidden"
    >
      {/* Header */}
      <WorkflowHeader
        workflowName={workflow.name}
        runId={state.workflowRun?.id ?? null}
        status={workflowStatus}
      />

      {/* Jobs Panel */}
      <JobsPanel
        jobs={jobs}
        selectedIndex={state.selectedJobIndex}
        isFocused={state.activePanel === "jobs"}
        pendingDependencies={jobPendingDeps}
        availableHeight={panelHeight}
      />

      {/* Steps Panel */}
      {selectedJob && (
        <StepsPanel
          jobName={selectedJob.name}
          steps={selectedJob.steps}
          isFocused={state.activePanel === "steps"}
          selectedIndex={state.selectedStepIndex}
          pendingDependencies={stepPendingDeps}
          availableHeight={panelHeight}
        />
      )}

      {/* Hotkey Bar */}
      <HotkeyBar
        isComplete={state.isComplete}
        showYamlOverlay={state.showYamlOverlay}
        activePanel={state.activePanel}
      />
    </Box>
  );
}
