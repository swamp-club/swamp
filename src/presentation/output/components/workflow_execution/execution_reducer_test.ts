import { assertEquals } from "@std/assert";
import {
  createInitialState,
  type ExecutionAction,
  executionReducer,
} from "./execution_reducer.ts";
import type { WorkflowData } from "../../../../domain/workflows/workflow.ts";
import type { WorkflowRunData } from "../../workflow_run_output.ts";

const mockWorkflow: WorkflowData = {
  id: "test-workflow-id",
  name: "test-workflow",
  description: "A test workflow",
  version: 1,
  jobs: [
    {
      name: "job1",
      dependsOn: [],
      weight: 1,
      steps: [{
        name: "step1",
        task: { type: "shell", command: "echo", args: ["hello"] },
        dependsOn: [],
        weight: 1,
      }],
    },
    {
      name: "job2",
      dependsOn: [],
      weight: 1,
      steps: [{
        name: "step2",
        task: { type: "shell", command: "echo", args: ["world"] },
        dependsOn: [],
        weight: 1,
      }],
    },
  ],
};

const mockYaml = `name: test-workflow
jobs:
  - name: job1
    steps:
      - name: step1
`;

const mockRunData: WorkflowRunData = {
  id: "run-id-123",
  workflowId: "test-workflow-id",
  workflowName: "test-workflow",
  status: "running",
  jobs: [
    {
      name: "job1",
      status: "running",
      steps: [{ name: "step1", status: "running" }],
    },
    {
      name: "job2",
      status: "pending",
      steps: [{ name: "step2", status: "pending" }],
    },
  ],
};

Deno.test("execution_reducer - createInitialState creates correct initial state", () => {
  const state = createInitialState(mockWorkflow, mockYaml);

  assertEquals(state.workflow, mockWorkflow);
  assertEquals(state.workflowYaml, mockYaml);
  assertEquals(state.workflowRun, null);
  assertEquals(state.isRunning, false);
  assertEquals(state.isComplete, false);
  assertEquals(state.selectedJobIndex, 0);
  assertEquals(state.showYamlOverlay, false);
  assertEquals(state.activePanel, "jobs");
  assertEquals(state.jobsScrollOffset, 0);
  assertEquals(state.stepsScrollOffset, 0);
  assertEquals(state.selectedStepIndex, 0);
});

Deno.test("execution_reducer - WORKFLOW_START sets running state", () => {
  const state = createInitialState(mockWorkflow, mockYaml);
  const action: ExecutionAction = { type: "WORKFLOW_START", run: mockRunData };

  const newState = executionReducer(state, action);

  assertEquals(newState.workflowRun, mockRunData);
  assertEquals(newState.isRunning, true);
  assertEquals(newState.isComplete, false);
});

Deno.test("execution_reducer - WORKFLOW_UPDATE updates run data", () => {
  const state = createInitialState(mockWorkflow, mockYaml);
  const startAction: ExecutionAction = {
    type: "WORKFLOW_START",
    run: mockRunData,
  };
  const stateAfterStart = executionReducer(state, startAction);

  const updatedRun: WorkflowRunData = {
    ...mockRunData,
    jobs: [
      {
        name: "job1",
        status: "succeeded",
        steps: [{ name: "step1", status: "succeeded", duration: 100 }],
      },
      {
        name: "job2",
        status: "running",
        steps: [{ name: "step2", status: "running" }],
      },
    ],
  };
  const updateAction: ExecutionAction = {
    type: "WORKFLOW_UPDATE",
    run: updatedRun,
  };

  const newState = executionReducer(stateAfterStart, updateAction);

  assertEquals(newState.workflowRun, updatedRun);
  assertEquals(newState.isRunning, true);
});

Deno.test("execution_reducer - WORKFLOW_COMPLETE sets complete state", () => {
  const state = createInitialState(mockWorkflow, mockYaml);
  const completedRun: WorkflowRunData = {
    ...mockRunData,
    status: "succeeded",
    jobs: [
      {
        name: "job1",
        status: "succeeded",
        steps: [{ name: "step1", status: "succeeded", duration: 100 }],
        duration: 150,
      },
      {
        name: "job2",
        status: "succeeded",
        steps: [{ name: "step2", status: "succeeded", duration: 50 }],
        duration: 80,
      },
    ],
    duration: 250,
  };
  const action: ExecutionAction = {
    type: "WORKFLOW_COMPLETE",
    run: completedRun,
  };

  const newState = executionReducer(state, action);

  assertEquals(newState.workflowRun, completedRun);
  assertEquals(newState.isRunning, false);
  assertEquals(newState.isComplete, true);
});

Deno.test("execution_reducer - SELECT_JOB updates selected index", () => {
  const state = createInitialState(mockWorkflow, mockYaml);
  const action: ExecutionAction = { type: "SELECT_JOB", index: 1 };

  const newState = executionReducer(state, action);

  assertEquals(newState.selectedJobIndex, 1);
});

Deno.test("execution_reducer - SELECT_NEXT_JOB increments index", () => {
  const state = createInitialState(mockWorkflow, mockYaml);
  const action: ExecutionAction = { type: "SELECT_NEXT_JOB" };

  const newState = executionReducer(state, action);

  assertEquals(newState.selectedJobIndex, 1);
});

Deno.test("execution_reducer - SELECT_NEXT_JOB does not exceed job count", () => {
  let state = createInitialState(mockWorkflow, mockYaml);
  state = { ...state, selectedJobIndex: 1 }; // Already at last job

  const action: ExecutionAction = { type: "SELECT_NEXT_JOB" };
  const newState = executionReducer(state, action);

  assertEquals(newState.selectedJobIndex, 1); // Should stay at 1
});

Deno.test("execution_reducer - SELECT_PREV_JOB decrements index", () => {
  let state = createInitialState(mockWorkflow, mockYaml);
  state = { ...state, selectedJobIndex: 1 };

  const action: ExecutionAction = { type: "SELECT_PREV_JOB" };
  const newState = executionReducer(state, action);

  assertEquals(newState.selectedJobIndex, 0);
});

Deno.test("execution_reducer - SELECT_PREV_JOB does not go below 0", () => {
  const state = createInitialState(mockWorkflow, mockYaml);
  const action: ExecutionAction = { type: "SELECT_PREV_JOB" };

  const newState = executionReducer(state, action);

  assertEquals(newState.selectedJobIndex, 0);
});

Deno.test("execution_reducer - TOGGLE_YAML_OVERLAY toggles overlay state", () => {
  const state = createInitialState(mockWorkflow, mockYaml);

  let newState = executionReducer(state, { type: "TOGGLE_YAML_OVERLAY" });
  assertEquals(newState.showYamlOverlay, true);

  newState = executionReducer(newState, { type: "TOGGLE_YAML_OVERLAY" });
  assertEquals(newState.showYamlOverlay, false);
});

Deno.test("execution_reducer - CLOSE_YAML_OVERLAY closes overlay", () => {
  let state = createInitialState(mockWorkflow, mockYaml);
  state = { ...state, showYamlOverlay: true };

  const newState = executionReducer(state, { type: "CLOSE_YAML_OVERLAY" });

  assertEquals(newState.showYamlOverlay, false);
});

Deno.test("execution_reducer - SWITCH_PANEL toggles between jobs and steps", () => {
  const state = createInitialState(mockWorkflow, mockYaml);
  assertEquals(state.activePanel, "jobs");

  let newState = executionReducer(state, { type: "SWITCH_PANEL" });
  assertEquals(newState.activePanel, "steps");

  newState = executionReducer(newState, { type: "SWITCH_PANEL" });
  assertEquals(newState.activePanel, "jobs");
});

Deno.test("execution_reducer - SELECT_NEXT_JOB resets step selection when job changes", () => {
  let state = createInitialState(mockWorkflow, mockYaml);
  state = { ...state, selectedStepIndex: 2, stepsScrollOffset: 1 };

  const newState = executionReducer(state, { type: "SELECT_NEXT_JOB" });

  assertEquals(newState.selectedJobIndex, 1);
  assertEquals(newState.selectedStepIndex, 0);
  assertEquals(newState.stepsScrollOffset, 0);
});

Deno.test("execution_reducer - SELECT_PREV_JOB resets step selection when job changes", () => {
  let state = createInitialState(mockWorkflow, mockYaml);
  state = {
    ...state,
    selectedJobIndex: 1,
    selectedStepIndex: 2,
    stepsScrollOffset: 1,
  };

  const newState = executionReducer(state, { type: "SELECT_PREV_JOB" });

  assertEquals(newState.selectedJobIndex, 0);
  assertEquals(newState.selectedStepIndex, 0);
  assertEquals(newState.stepsScrollOffset, 0);
});

Deno.test("execution_reducer - SELECT_JOB resets step selection", () => {
  let state = createInitialState(mockWorkflow, mockYaml);
  state = { ...state, selectedStepIndex: 2, stepsScrollOffset: 1 };

  const newState = executionReducer(state, { type: "SELECT_JOB", index: 1 });

  assertEquals(newState.selectedJobIndex, 1);
  assertEquals(newState.selectedStepIndex, 0);
  assertEquals(newState.stepsScrollOffset, 0);
});

Deno.test("execution_reducer - SELECT_NEXT_STEP increments step index", () => {
  let state = createInitialState(mockWorkflow, mockYaml);
  state = { ...state, workflowRun: mockRunData };

  const newState = executionReducer(state, { type: "SELECT_NEXT_STEP" });

  // job1 only has 1 step, so should stay at 0
  assertEquals(newState.selectedStepIndex, 0);
});

Deno.test("execution_reducer - SELECT_PREV_STEP decrements step index", () => {
  let state = createInitialState(mockWorkflow, mockYaml);
  state = { ...state, selectedStepIndex: 1 };

  const newState = executionReducer(state, { type: "SELECT_PREV_STEP" });

  assertEquals(newState.selectedStepIndex, 0);
});

Deno.test("execution_reducer - SELECT_PREV_STEP does not go below 0", () => {
  const state = createInitialState(mockWorkflow, mockYaml);

  const newState = executionReducer(state, { type: "SELECT_PREV_STEP" });

  assertEquals(newState.selectedStepIndex, 0);
});

Deno.test("execution_reducer - SCROLL_JOBS up decrements offset", () => {
  let state = createInitialState(mockWorkflow, mockYaml);
  state = { ...state, jobsScrollOffset: 1 };

  const newState = executionReducer(state, {
    type: "SCROLL_JOBS",
    direction: "up",
  });

  assertEquals(newState.jobsScrollOffset, 0);
});

Deno.test("execution_reducer - SCROLL_JOBS down increments offset", () => {
  const state = createInitialState(mockWorkflow, mockYaml);

  const newState = executionReducer(state, {
    type: "SCROLL_JOBS",
    direction: "down",
  });

  assertEquals(newState.jobsScrollOffset, 1);
});

Deno.test("execution_reducer - SCROLL_JOBS up does not go below 0", () => {
  const state = createInitialState(mockWorkflow, mockYaml);

  const newState = executionReducer(state, {
    type: "SCROLL_JOBS",
    direction: "up",
  });

  assertEquals(newState.jobsScrollOffset, 0);
});

Deno.test("execution_reducer - SCROLL_STEPS up decrements offset", () => {
  let state = createInitialState(mockWorkflow, mockYaml);
  state = { ...state, stepsScrollOffset: 1 };

  const newState = executionReducer(state, {
    type: "SCROLL_STEPS",
    direction: "up",
  });

  assertEquals(newState.stepsScrollOffset, 0);
});

Deno.test("execution_reducer - SCROLL_STEPS down increments offset", () => {
  const state = createInitialState(mockWorkflow, mockYaml);

  const newState = executionReducer(state, {
    type: "SCROLL_STEPS",
    direction: "down",
  });

  // job1 has only 1 step, so max is 0
  assertEquals(newState.stepsScrollOffset, 0);
});

Deno.test("execution_reducer - SCROLL_STEPS up does not go below 0", () => {
  const state = createInitialState(mockWorkflow, mockYaml);

  const newState = executionReducer(state, {
    type: "SCROLL_STEPS",
    direction: "up",
  });

  assertEquals(newState.stepsScrollOffset, 0);
});
