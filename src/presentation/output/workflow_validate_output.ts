import type { OutputMode } from "./output.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

export interface ValidationItemData {
  name: string;
  passed: boolean;
  error?: string;
}

export interface WorkflowValidateData {
  workflowId: string;
  workflowName: string;
  validations: ValidationItemData[];
  passed: boolean;
}

export interface WorkflowValidateAllData {
  workflows: WorkflowValidateData[];
  totalPassed: number;
  totalFailed: number;
  passed: boolean;
}

export function renderWorkflowValidate(
  data: WorkflowValidateData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderLogWorkflowValidate(data);
  }
}

function renderLogWorkflowValidate(data: WorkflowValidateData): void {
  const logger = getSwampLogger(["workflow", "validate"]);
  const checkmark = "\u2713";
  const cross = "\u2717";

  logger.info("Validating workflow: {workflowName}", {
    workflowName: data.workflowName,
  });

  for (const v of data.validations) {
    const icon = v.passed ? checkmark : cross;
    logger.info("  {icon} {name}", { icon, name: v.name });
    if (v.error) {
      logger.error("    -> {error}", { error: v.error });
    }
  }

  const passedCount = data.validations.filter((v) => v.passed).length;
  const totalCount = data.validations.length;
  logger.info("Summary: {passedCount}/{totalCount} validations passed", {
    passedCount,
    totalCount,
  });

  if (data.passed) {
    logger.info("Result: PASSED");
  } else {
    logger.error("Result: FAILED");
  }
}

export function renderWorkflowValidateAll(
  workflows: WorkflowValidateData[],
  mode: OutputMode,
): void {
  const totalPassed = workflows.filter((w) => w.passed).length;
  const totalFailed = workflows.length - totalPassed;
  const passed = totalFailed === 0;

  const data: WorkflowValidateAllData = {
    workflows,
    totalPassed,
    totalFailed,
    passed,
  };

  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderLogWorkflowValidateAll(data);
  }
}

function renderLogWorkflowValidateAll(data: WorkflowValidateAllData): void {
  const logger = getSwampLogger(["workflow", "validate"]);
  const checkmark = "\u2713";
  const cross = "\u2717";

  logger.info("Validating all workflows...");

  for (const workflow of data.workflows) {
    logger.info("{workflowName}", { workflowName: workflow.workflowName });

    for (const v of workflow.validations) {
      const icon = v.passed ? checkmark : cross;
      logger.info("  {icon} {name}", { icon, name: v.name });
      if (v.error) {
        logger.error("    -> {error}", { error: v.error });
      }
    }

    if (workflow.passed) {
      logger.info("  Result: PASSED");
    } else {
      logger.error("  Result: FAILED");
    }
  }

  logger.info(
    "Summary: {totalPassed}/{total} workflows passed",
    { totalPassed: data.totalPassed, total: data.workflows.length },
  );

  if (data.passed) {
    logger.info("Overall: PASSED");
  } else {
    logger.error("Overall: FAILED");
  }
}
