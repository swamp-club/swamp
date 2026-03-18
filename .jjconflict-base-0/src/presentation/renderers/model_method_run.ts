// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import type { EventHandlers, ModelMethodRunEvent } from "../../libswamp/mod.ts";
import type { Renderer } from "../renderer.ts";
import type { OutputMode } from "../output/output.ts";
import { getRunLogger } from "../../infrastructure/logging/logger.ts";
import { UserError } from "../../domain/errors.ts";

export interface ModelMethodRunRenderOpts {
  modelName: string;
  methodName: string;
}

export interface ModelMethodRunRenderer extends Renderer<ModelMethodRunEvent> {
  runFailed(): boolean;
}

class LogModelMethodRunRenderer implements ModelMethodRunRenderer {
  private modelName: string;
  private methodName: string;
  private _failed = false;

  constructor(opts: ModelMethodRunRenderOpts) {
    this.modelName = opts.modelName;
    this.methodName = opts.methodName;
  }

  handlers(): EventHandlers<ModelMethodRunEvent> {
    return {
      validating_inputs: () => {},
      resolving_model: () => {},
      model_resolved: (e) => {
        this.modelName = e.modelName;
        this.methodName = e.methodName;
        getRunLogger(e.modelName, e.methodName).info(
          "Found model {name} ({type})",
          { name: e.modelName, type: e.modelType },
        );
      },
      evaluating_expressions: (e) => {
        const logger = getRunLogger(this.modelName, this.methodName);
        if (e.lastEvaluated) {
          logger.info("Loading last evaluated definition");
        } else {
          logger.info("Evaluating expressions");
        }
      },
      executing: (e) => {
        getRunLogger(e.modelName, e.methodName).info(
          "Executing method {method}",
          { method: e.methodName },
        );
      },
      method_output: (e) => {
        const logger = getRunLogger(e.modelName, e.methodName);
        if (e.stream === "stderr") {
          logger.warn(e.line);
        } else {
          logger.info(e.line);
        }
      },
      method_event: (e) => {
        const logger = getRunLogger(e.modelName, e.methodName);
        switch (e.event.type) {
          case "vault_secret_stored":
            logger.info(
              "Stored sensitive field '{fieldPath}' in vault '{vaultName}'",
              {
                fieldPath: e.event.fieldPath,
                vaultName: e.event.vaultName,
              },
            );
            break;
          case "schema_validation_warning":
            logger.warn(
              "Resource '{specName}' (instance '{instanceName}') data does not match schema: {error}",
              {
                specName: e.event.specName,
                instanceName: e.event.instanceName,
                error: e.event.error,
              },
            );
            break;
        }
      },
      data_artifact_saved: (e) => {
        getRunLogger(this.modelName, this.methodName).info(
          "Data saved to {path}",
          { path: e.path, name: e.name },
        );
      },
      completed: (e) => {
        if (e.run.status === "failed") {
          this._failed = true;
        } else {
          getRunLogger(e.run.modelName, e.run.methodName)
            .with({ summary: true })
            .info("Method {method} completed on {model}", {
              method: e.run.methodName,
              model: e.run.modelName,
              artifacts: e.run.dataArtifacts.length,
            });
        }
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }

  runFailed(): boolean {
    return this._failed;
  }
}

class JsonModelMethodRunRenderer implements ModelMethodRunRenderer {
  private _failed = false;

  handlers(): EventHandlers<ModelMethodRunEvent> {
    return {
      validating_inputs: () => {},
      resolving_model: () => {},
      model_resolved: () => {},
      evaluating_expressions: () => {},
      executing: () => {},
      method_output: () => {},
      method_event: () => {},
      data_artifact_saved: () => {},
      completed: (e) => {
        if (e.run.status === "failed") this._failed = true;
        console.log(JSON.stringify(e.run, null, 2));
      },
      error: (e) => {
        throw new UserError(e.error.message);
      },
    };
  }

  runFailed(): boolean {
    return this._failed;
  }
}

export function createModelMethodRunRenderer(
  mode: OutputMode,
  opts: ModelMethodRunRenderOpts,
): ModelMethodRunRenderer {
  switch (mode) {
    case "json":
      return new JsonModelMethodRunRenderer();
    case "log":
      return new LogModelMethodRunRenderer(opts);
  }
}
