import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type { OutputMode } from "./output.ts";

export interface ValidationItemData {
  name: string;
  passed: boolean;
  error?: string;
}

export interface ModelValidateData {
  modelId: string;
  modelName: string;
  type: string;
  validations: ValidationItemData[];
  passed: boolean;
}

export interface ModelValidateAllData {
  models: ModelValidateData[];
  totalPassed: number;
  totalFailed: number;
  passed: boolean;
}

export function renderModelValidate(
  data: ModelValidateData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const logger = getSwampLogger(["model", "validate"]);
    const checkmark = "\u2713";
    const cross = "\u2717";
    const arrow = "\u2192";

    logger.info("Validating model: {modelName} ({type})", {
      modelName: data.modelName,
      type: data.type,
    });

    for (const v of data.validations) {
      const icon = v.passed ? checkmark : cross;
      if (v.passed) {
        logger.info("  {icon} {name}", { icon, name: v.name });
      } else {
        logger.warn("  {icon} {name}", { icon, name: v.name });
        if (v.error) {
          logger.warn("    {arrow} {error}", { arrow, error: v.error });
        }
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
      logger.warn("Result: FAILED");
    }
  }
}

export function renderModelValidateAll(
  models: ModelValidateData[],
  mode: OutputMode,
): void {
  const totalPassed = models.filter((m) => m.passed).length;
  const totalFailed = models.length - totalPassed;
  const passed = totalFailed === 0;

  const data: ModelValidateAllData = {
    models,
    totalPassed,
    totalFailed,
    passed,
  };

  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const logger = getSwampLogger(["model", "validate"]);
    const checkmark = "\u2713";
    const cross = "\u2717";
    const arrow = "\u2192";

    logger.info("Validating all models...");

    for (const model of models) {
      logger.info("{modelName} ({type})", {
        modelName: model.modelName,
        type: model.type,
      });

      for (const v of model.validations) {
        const icon = v.passed ? checkmark : cross;
        if (v.passed) {
          logger.info("  {icon} {name}", { icon, name: v.name });
        } else {
          logger.warn("  {icon} {name}", { icon, name: v.name });
          if (v.error) {
            logger.warn("    {arrow} {error}", { arrow, error: v.error });
          }
        }
      }

      if (model.passed) {
        logger.info("Result: PASSED");
      } else {
        logger.warn("Result: FAILED");
      }
    }

    logger.info("Summary: {totalPassed}/{total} models passed", {
      totalPassed,
      total: models.length,
    });
    if (passed) {
      logger.info("Overall: PASSED");
    } else {
      logger.warn("Overall: FAILED");
    }
  }
}
