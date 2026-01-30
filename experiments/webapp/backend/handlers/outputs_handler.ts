/**
 * HTTP handlers for model outputs API endpoints.
 */

import type { RouteContext } from "../router.ts";
import { errorResponse, jsonResponse } from "../router.ts";
import type {
  DataRepository,
  InputRepository,
  LogRepository,
  OutputRepository,
} from "../../../../src/domain/models/repositories.ts";
import { createModelDataId } from "../../../../src/domain/models/model_data.ts";
import { createModelLogId } from "../../../../src/domain/models/model_log.ts";
import {
  isPartialId,
  matchByPartialId,
} from "../../../../src/domain/models/model_lookup.ts";

export function createOutputsHandlers(
  outputRepository: OutputRepository,
  inputRepository: InputRepository,
  dataRepository: DataRepository,
  logRepository: LogRepository,
) {
  async function listOutputs(_ctx: RouteContext): Promise<Response> {
    const allOutputs = await outputRepository.findAllGlobal();

    // Get model names for each output
    const outputsWithNames = await Promise.all(
      allOutputs.map(async ({ output, type }) => {
        let modelName: string | undefined;
        const input = await inputRepository.findById(type, output.modelInputId);
        if (input) {
          modelName = input.name;
        }

        return {
          id: output.id,
          modelInputId: output.modelInputId,
          modelName,
          type: type.normalized,
          methodName: output.methodName,
          status: output.status,
          startedAt: output.startedAt.toISOString(),
          completedAt: output.completedAt?.toISOString(),
          durationMs: output.durationMs,
        };
      }),
    );

    // Sort by startedAt descending (most recent first)
    outputsWithNames.sort(
      (a, b) =>
        new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );

    return jsonResponse({ outputs: outputsWithNames });
  }

  async function getOutput(ctx: RouteContext): Promise<Response> {
    const idParam = ctx.params.id;

    if (!isPartialId(idParam)) {
      return errorResponse(
        `Invalid output ID format: ${idParam}. Expected a UUID or partial ID (3+ hex characters).`,
        400,
      );
    }

    const allOutputs = await outputRepository.findAllGlobal();
    const matchResult = matchByPartialId(
      allOutputs.map((o) => ({ id: o.output.id, item: o })),
      idParam,
    );

    if (matchResult.status === "not_found") {
      return errorResponse(`Output not found: ${idParam}`, 404);
    }

    if (matchResult.status === "ambiguous") {
      return errorResponse(
        `Ambiguous ID prefix "${idParam}" matches multiple outputs: ${
          matchResult.matches.map((m) => m.id).join(", ")
        }`,
        400,
      );
    }

    const { output, type } = matchResult.match;

    // Get model name
    let modelName: string | undefined;
    const input = await inputRepository.findById(type, output.modelInputId);
    if (input) {
      modelName = input.name;
    }

    return jsonResponse({
      id: output.id,
      modelInputId: output.modelInputId,
      modelName,
      type: type.normalized,
      methodName: output.methodName,
      status: output.status,
      startedAt: output.startedAt.toISOString(),
      completedAt: output.completedAt?.toISOString(),
      durationMs: output.durationMs,
      retryCount: output.retryCount,
      provenance: output.provenance,
      artifacts: output.artifacts,
      error: output.error,
    });
  }

  async function getOutputData(ctx: RouteContext): Promise<Response> {
    const idParam = ctx.params.id;
    const url = new URL(ctx.request.url);
    const fieldParam = url.searchParams.get("field");

    if (!isPartialId(idParam)) {
      return errorResponse(
        `Invalid output ID format: ${idParam}. Expected a UUID or partial ID (3+ hex characters).`,
        400,
      );
    }

    const allOutputs = await outputRepository.findAllGlobal();
    const matchResult = matchByPartialId(
      allOutputs.map((o) => ({ id: o.output.id, item: o })),
      idParam,
    );

    if (matchResult.status === "not_found") {
      return errorResponse(`Output not found: ${idParam}`, 404);
    }

    if (matchResult.status === "ambiguous") {
      return errorResponse(
        `Ambiguous ID prefix "${idParam}" matches multiple outputs: ${
          matchResult.matches.map((m) => m.id).join(", ")
        }`,
        400,
      );
    }

    const { output, type } = matchResult.match;

    // Get data ID from artifacts
    const dataId = output.artifacts?.dataId;
    if (!dataId) {
      return errorResponse(
        `Output ${output.id} has no data artifact. Status: ${output.status}, Method: ${output.methodName}`,
        404,
      );
    }

    // Fetch the data artifact
    const data = await dataRepository.findById(type, createModelDataId(dataId));
    if (!data) {
      return errorResponse(
        `Data artifact ${dataId} not found for output ${output.id}`,
        404,
      );
    }

    // Get the attributes to display
    let displayData: unknown = data.attributes;

    // If a specific field is requested, extract it
    if (fieldParam) {
      const fieldValue = data.attributes[fieldParam];
      if (fieldValue === undefined) {
        const availableFields = Object.keys(data.attributes).join(", ");
        return errorResponse(
          `Field "${fieldParam}" not found in data artifact. Available fields: ${
            availableFields || "(none)"
          }`,
          404,
        );
      }
      displayData = fieldValue;
    }

    return jsonResponse({
      outputId: output.id,
      methodName: output.methodName,
      dataId,
      field: fieldParam ?? null,
      data: displayData,
    });
  }

  async function getOutputLogs(ctx: RouteContext): Promise<Response> {
    const idParam = ctx.params.id;
    const url = new URL(ctx.request.url);
    const tailParam = url.searchParams.get("tail");
    const tail = tailParam ? parseInt(tailParam, 10) : undefined;

    if (tailParam && (isNaN(tail!) || tail! < 0)) {
      return errorResponse(
        `Invalid tail parameter: ${tailParam}. Expected a positive integer.`,
        400,
      );
    }

    if (!isPartialId(idParam)) {
      return errorResponse(
        `Invalid output ID format: ${idParam}. Expected a UUID or partial ID (3+ hex characters).`,
        400,
      );
    }

    const allOutputs = await outputRepository.findAllGlobal();
    const matchResult = matchByPartialId(
      allOutputs.map((o) => ({ id: o.output.id, item: o })),
      idParam,
    );

    if (matchResult.status === "not_found") {
      return errorResponse(`Output not found: ${idParam}`, 404);
    }

    if (matchResult.status === "ambiguous") {
      return errorResponse(
        `Ambiguous ID prefix "${idParam}" matches multiple outputs: ${
          matchResult.matches.map((m) => m.id).join(", ")
        }`,
        400,
      );
    }

    const { output, type } = matchResult.match;

    // Get log IDs from artifacts
    const logIds = output.artifacts?.logIds;
    if (!logIds || logIds.length === 0) {
      return errorResponse(
        `Output ${output.id} has no log artifacts. Status: ${output.status}, Method: ${output.methodName}`,
        404,
      );
    }

    // Fetch and collect all log entries
    const allEntries: string[] = [];

    for (const logId of logIds) {
      const log = await logRepository.findById(type, createModelLogId(logId));
      if (log) {
        for (const entry of log.entries) {
          allEntries.push(entry.message);
        }
      }
    }

    // Apply --tail if specified
    const entriesToShow = tail !== undefined
      ? allEntries.slice(-tail)
      : allEntries;

    return jsonResponse({
      outputId: output.id,
      methodName: output.methodName,
      logIds,
      lines: entriesToShow,
      totalLines: allEntries.length,
      showingLines: entriesToShow.length,
    });
  }

  return {
    listOutputs,
    getOutput,
    getOutputData,
    getOutputLogs,
  };
}
