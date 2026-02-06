/**
 * HTTP handlers for model outputs API endpoints.
 */

import type { RouteContext } from "../router.ts";
import { errorResponse, jsonResponse } from "../router.ts";
import type { OutputRepository } from "../../../../src/domain/models/repositories.ts";
import type { DefinitionRepository } from "../../../../src/domain/definitions/repositories.ts";
import type { UnifiedDataRepository } from "../../../../src/infrastructure/persistence/unified_data_repository.ts";
import type { DefinitionId } from "../../../../src/domain/definitions/definition.ts";
import {
  isPartialId,
  matchByPartialId,
} from "../../../../src/domain/models/model_lookup.ts";

export function createOutputsHandlers(
  outputRepository: OutputRepository,
  definitionRepository: DefinitionRepository,
  dataRepository: UnifiedDataRepository,
) {
  async function listOutputs(_ctx: RouteContext): Promise<Response> {
    const allOutputs = await outputRepository.findAllGlobal();

    // Get model names for each output
    const outputsWithNames = await Promise.all(
      allOutputs.map(async ({ output, type }) => {
        let modelName: string | undefined;
        const definition = await definitionRepository.findById(
          type,
          output.definitionId as DefinitionId,
        );
        if (definition) {
          modelName = definition.name;
        }

        return {
          id: output.id,
          definitionId: output.definitionId,
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
    const definition = await definitionRepository.findById(
      type,
      output.definitionId as DefinitionId,
    );
    if (definition) {
      modelName = definition.name;
    }

    return jsonResponse({
      id: output.id,
      definitionId: output.definitionId,
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

    // Get data from artifacts (find first data artifact with type "data")
    const dataArtifact = output.artifacts.dataArtifacts.find(
      (a) => a.tags.type === "data",
    );
    if (!dataArtifact) {
      return errorResponse(
        `Output ${output.id} has no data artifact. Status: ${output.status}, Method: ${output.methodName}`,
        404,
      );
    }

    // Fetch the data using unified data repository
    const content = await dataRepository.getContent(
      type,
      output.definitionId,
      dataArtifact.name,
    );

    if (!content) {
      return errorResponse(
        `Data artifact ${dataArtifact.name} not found for output ${output.id}`,
        404,
      );
    }

    // Parse the content as JSON
    const text = new TextDecoder().decode(content);
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text);
    } catch {
      // If not JSON, return as string
      data = { content: text };
    }

    // If a specific field is requested, extract it
    let displayData: unknown = data;
    if (fieldParam) {
      const fieldValue = data[fieldParam];
      if (fieldValue === undefined) {
        const availableFields = Object.keys(data).join(", ");
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
      dataName: dataArtifact.name,
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

    // Get log artifacts (find all artifacts with type "log")
    const logArtifacts = output.artifacts.dataArtifacts.filter(
      (a) => a.tags.type === "log",
    );
    if (logArtifacts.length === 0) {
      return errorResponse(
        `Output ${output.id} has no log artifacts. Status: ${output.status}, Method: ${output.methodName}`,
        404,
      );
    }

    // Fetch and collect all log entries using unified data repository
    const allEntries: string[] = [];

    for (const artifact of logArtifacts) {
      const content = await dataRepository.getContent(
        type,
        output.definitionId,
        artifact.name,
      );
      if (content) {
        const text = new TextDecoder().decode(content);
        const lines = text.split("\n").filter((line) => line.length > 0);
        allEntries.push(...lines);
      }
    }

    // Apply --tail if specified
    const entriesToShow = tail !== undefined
      ? allEntries.slice(-tail)
      : allEntries;

    return jsonResponse({
      outputId: output.id,
      methodName: output.methodName,
      logArtifacts: logArtifacts.map((a) => a.name),
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
