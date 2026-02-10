import type { WorkflowData } from "../../../../domain/workflows/workflow.ts";
import type { WorkflowRunData } from "../../workflow_run_output.ts";
import type { LogStreamTarget } from "./LogStreamService.ts";

/**
 * Active panel for focus management.
 */
export type ActivePanel = "jobs" | "steps";

/**
 * Implicit dependency mapping: jobName -> stepName -> implicitDeps[]
 */
export type ImplicitDependencyMap = Map<string, Map<string, string[]>>;

/**
 * View state for the workflow execution UI.
 */
export interface WorkflowExecutionViewState {
  // Display data (derived from domain)
  workflow: WorkflowData;
  workflowRun: WorkflowRunData | null;
  workflowYaml: string;

  // Execution status
  isRunning: boolean;
  isComplete: boolean;

  // Implicit dependencies from expressions (jobName -> stepName -> deps[])
  implicitDependencies: ImplicitDependencyMap;

  // UI-only state
  selectedJobIndex: number;
  showYamlOverlay: boolean;
  showLogOverlay: boolean;
  logStreamTarget: LogStreamTarget | null;

  // Panel focus and scrolling
  activePanel: ActivePanel;
  jobsScrollOffset: number;
  stepsScrollOffset: number;
  selectedStepIndex: number;
}

/**
 * Actions that can be dispatched to update the view state.
 */
export type ExecutionAction =
  | { type: "WORKFLOW_START"; run: WorkflowRunData }
  | { type: "WORKFLOW_UPDATE"; run: WorkflowRunData }
  | { type: "WORKFLOW_COMPLETE"; run: WorkflowRunData }
  | { type: "SET_IMPLICIT_DEPENDENCIES"; deps: ImplicitDependencyMap }
  | { type: "SELECT_JOB"; index: number }
  | { type: "SELECT_NEXT_JOB" }
  | { type: "SELECT_PREV_JOB" }
  | { type: "TOGGLE_YAML_OVERLAY" }
  | { type: "CLOSE_YAML_OVERLAY" }
  | { type: "SHOW_LOG_STREAM"; target: LogStreamTarget }
  | { type: "CLOSE_LOG_STREAM" }
  | { type: "SWITCH_PANEL" }
  | { type: "SCROLL_JOBS"; direction: "up" | "down" }
  | { type: "SCROLL_STEPS"; direction: "up" | "down" }
  | { type: "SELECT_NEXT_STEP" }
  | { type: "SELECT_PREV_STEP" };

/**
 * Creates the initial view state.
 */
export function createInitialState(
  workflow: WorkflowData,
  workflowYaml: string,
): WorkflowExecutionViewState {
  return {
    workflow,
    workflowRun: null,
    workflowYaml,
    isRunning: false,
    isComplete: false,
    implicitDependencies: new Map(),
    selectedJobIndex: 0,
    showYamlOverlay: false,
    showLogOverlay: false,
    logStreamTarget: null,
    activePanel: "jobs",
    jobsScrollOffset: 0,
    stepsScrollOffset: 0,
    selectedStepIndex: 0,
  };
}

/**
 * Reducer function for the execution view state.
 */
export function executionReducer(
  state: WorkflowExecutionViewState,
  action: ExecutionAction,
): WorkflowExecutionViewState {
  switch (action.type) {
    case "WORKFLOW_START":
      return {
        ...state,
        workflowRun: action.run,
        isRunning: true,
        isComplete: false,
      };

    case "WORKFLOW_UPDATE":
      return {
        ...state,
        workflowRun: action.run,
      };

    case "WORKFLOW_COMPLETE":
      return {
        ...state,
        workflowRun: action.run,
        isRunning: false,
        isComplete: true,
      };

    case "SET_IMPLICIT_DEPENDENCIES":
      return {
        ...state,
        implicitDependencies: action.deps,
      };

    case "SELECT_JOB":
      return {
        ...state,
        selectedJobIndex: action.index,
        selectedStepIndex: 0,
        stepsScrollOffset: 0,
      };

    case "SELECT_NEXT_JOB": {
      const jobCount = state.workflowRun?.jobs.length ??
        state.workflow.jobs.length;
      const nextIndex = Math.min(state.selectedJobIndex + 1, jobCount - 1);
      const jobChanged = nextIndex !== state.selectedJobIndex;
      return {
        ...state,
        selectedJobIndex: nextIndex,
        selectedStepIndex: jobChanged ? 0 : state.selectedStepIndex,
        stepsScrollOffset: jobChanged ? 0 : state.stepsScrollOffset,
      };
    }

    case "SELECT_PREV_JOB": {
      const prevIndex = Math.max(state.selectedJobIndex - 1, 0);
      const jobChanged = prevIndex !== state.selectedJobIndex;
      return {
        ...state,
        selectedJobIndex: prevIndex,
        selectedStepIndex: jobChanged ? 0 : state.selectedStepIndex,
        stepsScrollOffset: jobChanged ? 0 : state.stepsScrollOffset,
      };
    }

    case "TOGGLE_YAML_OVERLAY":
      return {
        ...state,
        showYamlOverlay: !state.showYamlOverlay,
      };

    case "CLOSE_YAML_OVERLAY":
      return {
        ...state,
        showYamlOverlay: false,
      };

    case "SHOW_LOG_STREAM":
      return {
        ...state,
        showLogOverlay: true,
        logStreamTarget: action.target,
      };

    case "CLOSE_LOG_STREAM":
      return {
        ...state,
        showLogOverlay: false,
        logStreamTarget: null,
      };

    case "SWITCH_PANEL":
      return {
        ...state,
        activePanel: state.activePanel === "jobs" ? "steps" : "jobs",
      };

    case "SCROLL_JOBS": {
      const jobCount = state.workflowRun?.jobs.length ??
        state.workflow.jobs.length;
      const newOffset = action.direction === "up"
        ? Math.max(0, state.jobsScrollOffset - 1)
        : Math.min(Math.max(0, jobCount - 1), state.jobsScrollOffset + 1);
      return {
        ...state,
        jobsScrollOffset: newOffset,
      };
    }

    case "SCROLL_STEPS": {
      const selectedJob = state.workflowRun?.jobs[state.selectedJobIndex] ??
        { steps: state.workflow.jobs[state.selectedJobIndex]?.steps ?? [] };
      const stepCount = selectedJob.steps.length;
      const newOffset = action.direction === "up"
        ? Math.max(0, state.stepsScrollOffset - 1)
        : Math.min(Math.max(0, stepCount - 1), state.stepsScrollOffset + 1);
      return {
        ...state,
        stepsScrollOffset: newOffset,
      };
    }

    case "SELECT_NEXT_STEP": {
      const selectedJob = state.workflowRun?.jobs[state.selectedJobIndex] ??
        { steps: state.workflow.jobs[state.selectedJobIndex]?.steps ?? [] };
      const stepCount = selectedJob.steps.length;
      const nextIndex = Math.min(state.selectedStepIndex + 1, stepCount - 1);
      return {
        ...state,
        selectedStepIndex: nextIndex,
      };
    }

    case "SELECT_PREV_STEP": {
      const prevIndex = Math.max(state.selectedStepIndex - 1, 0);
      return {
        ...state,
        selectedStepIndex: prevIndex,
      };
    }

    default:
      return state;
  }
}
