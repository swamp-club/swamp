import React, { useCallback, useEffect, useReducer } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { WorkflowHeader } from "./WorkflowHeader.tsx";
import { JobsPanel } from "./JobsPanel.tsx";
import { StepsPanel } from "./StepsPanel.tsx";
import { HotkeyBar } from "./HotkeyBar.tsx";
import { YamlOverlay } from "./YamlOverlay.tsx";
import { LogStreamOverlay } from "./LogStreamOverlay.tsx";
import { LogStreamService } from "./LogStreamService.ts";
import {
  createInitialState,
  type ExecutionAction,
  executionReducer,
} from "./execution_reducer.ts";
import type { WorkflowData } from "../../../../domain/workflows/workflow.ts";
import type { JobRunData } from "../../workflow_run_output.ts";
import { useTerminalSize } from "../../hooks/mod.ts";

/**
 * A dependency with type information (explicit or implicit).
 */
export interface PendingDep {
  name: string;
  isImplicit: boolean;
}

/**
 * Computes pending dependencies (ones that haven't succeeded yet).
 * Returns dependencies with type info (explicit vs implicit).
 */
function getPendingDependencies(
  explicitDeps: string[],
  implicitDeps: string[],
  statuses: Map<string, string>,
): PendingDep[] {
  const result: PendingDep[] = [];

  for (const dep of explicitDeps) {
    const status = statuses.get(dep);
    if (status !== "succeeded" && status !== "skipped") {
      result.push({ name: dep, isImplicit: false });
    }
  }

  for (const dep of implicitDeps) {
    const status = statuses.get(dep);
    if (status !== "succeeded" && status !== "skipped") {
      // Avoid duplicates if already in explicit deps
      if (!explicitDeps.includes(dep)) {
        result.push({ name: dep, isImplicit: true });
      }
    }
  }

  return result;
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

  // Create log service instance
  const [logService] = React.useState(() => new LogStreamService());

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

      // Enter key opens log stream for selected item
      if (key.return) {
        const jobs = state.workflowRun?.jobs ?? workflow.jobs.map((job) => ({
          name: job.name,
          status: "pending" as const,
          steps: job.steps.map((step) => ({
            name: step.name,
            status: "pending" as const,
          })),
        }));

        const selectedJob = jobs[state.selectedJobIndex];
        const workflowRunId = state.workflowRun?.id ?? "unknown";

        if (state.activePanel === "steps") {
          // Open logs for the selected step
          const selectedStep = selectedJob.steps[state.selectedStepIndex];
          if (selectedStep) {
            dispatch({
              type: "SHOW_LOG_STREAM",
              target: {
                type: "step",
                jobName: selectedJob.name,
                stepName: selectedStep.name,
                workflowRunId,
                stepStatus: selectedStep.status,
              },
            });
          }
        }
        // Note: Job-level log streaming removed - users should view individual step logs
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
    { isActive: !state.showYamlOverlay && !state.showLogOverlay },
  );

  // If showing log overlay, render it fullscreen
  if (state.showLogOverlay && state.logStreamTarget) {
    return (
      <LogStreamOverlay
        target={state.logStreamTarget}
        logService={logService}
        onClose={() => dispatch({ type: "CLOSE_LOG_STREAM" })}
        isActive={state.showLogOverlay}
      />
    );
  }

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
  const jobPendingDeps = new Map<string, PendingDep[]>();
  for (const job of workflow.jobs) {
    const explicitDeps = job.dependsOn.map((d) => d.job);
    // Jobs don't have implicit deps (only steps do)
    const pendingDeps = getPendingDependencies(explicitDeps, [], jobStatuses);
    jobPendingDeps.set(job.name, pendingDeps);
  }

  // Compute pending dependencies for steps of selected job
  const stepPendingDeps = new Map<string, PendingDep[]>();
  if (selectedJob) {
    const stepStatuses = new Map(
      selectedJob.steps.map((s) => [s.name, s.status]),
    );
    const workflowJob = workflow.jobs[state.selectedJobIndex];
    if (workflowJob) {
      // Get implicit deps for this job from state
      const jobImplicitDeps = state.implicitDependencies.get(workflowJob.name);

      for (const step of workflowJob.steps) {
        const explicitDeps = step.dependsOn.map((d) => d.step);
        const implicitDeps = jobImplicitDeps?.get(step.name) ?? [];
        const pendingDeps = getPendingDependencies(
          explicitDeps,
          implicitDeps,
          stepStatuses,
        );
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
        logAvailability={new Map()} // TODO: Implement actual log availability checking
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
          logAvailability={new Map()} // TODO: Implement actual log availability checking
          availableHeight={panelHeight}
        />
      )}

      {/* Hotkey Bar */}
      <HotkeyBar
        isComplete={state.isComplete}
        showYamlOverlay={state.showYamlOverlay}
        showLogOverlay={state.showLogOverlay}
        activePanel={state.activePanel}
      />
    </Box>
  );
}
