// deno-lint-ignore verbatim-module-syntax
import React from "react";
import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import type { OutputMode } from "./output.tsx";

/**
 * Data structure for a method's description.
 */
export interface MethodDescribeData {
  name: string;
  description: string;
  inputAttributesSchema: object;
  dataOutputSpecs?: Array<{
    specType: string;
    description?: string;
    contentType?: string;
    lifetime?: string;
    garbageCollection?: number | string;
    streaming?: boolean;
    tags?: Record<string, string>;
  }>;
}

/**
 * Data structure for the type describe output.
 */
export interface TypeDescribeData {
  type: {
    raw: string;
    normalized: string;
  };
  version: number;
  inputAttributesSchema: object;
  methods: MethodDescribeData[];
}

/**
 * Renders the type description in either interactive or JSON mode.
 */
export function renderTypeDescribe(
  data: TypeDescribeData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderInteractiveTypeDescribe(data);
  }
}

function renderInteractiveTypeDescribe(data: TypeDescribeData): void {
  const { lastFrame } = render(<TypeDescribeDisplay data={data} />);
  console.log(lastFrame());
}

interface TypeDescribeDisplayProps {
  data: TypeDescribeData;
}

/**
 * Formats a JSON schema object as a string with indentation.
 */
function formatSchema(schema: object): string {
  return JSON.stringify(schema, null, 2);
}

/**
 * Component to display a schema section with a header.
 */
function SchemaSection({
  title,
  schema,
}: {
  title: string;
  schema: object;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="cyan" bold>
        ## {title}
      </Text>
      <Box marginTop={1}>
        <Text dimColor>{formatSchema(schema)}</Text>
      </Box>
    </Box>
  );
}

/**
 * Component to display data output specs.
 */
function DataOutputSpecsDisplay({
  specs,
}: {
  specs: MethodDescribeData["dataOutputSpecs"];
}): React.ReactElement | null {
  if (!specs || specs.length === 0) return null;

  return (
    <Box marginTop={1} marginLeft={2} flexDirection="column">
      <Text color="cyan">Data Output Specs:</Text>
      {specs.map((spec) => (
        <Box key={spec.specType} marginLeft={2} flexDirection="column">
          <Text>
            • <Text color="magenta">{spec.specType}</Text>
          </Text>
          {spec.description && (
            <Box marginLeft={2}>
              <Text dimColor>{spec.description}</Text>
            </Box>
          )}
          <Box marginLeft={2}>
            <Text dimColor>
              {spec.contentType ?? "application/json"} |{" "}
              {spec.lifetime ?? "infinite"} | GC: {spec.garbageCollection ?? 10}
              {spec.streaming && " | streaming"}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}

/**
 * Component to display a single method.
 */
function MethodDisplay({
  method,
}: {
  method: MethodDescribeData;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="yellow" bold>
        ### {method.name}
      </Text>
      <Box marginLeft={2}>
        <Text>{method.description}</Text>
      </Box>
      <Box marginTop={1} marginLeft={2} flexDirection="column">
        <Text color="cyan">Input Schema:</Text>
        <Text dimColor>{formatSchema(method.inputAttributesSchema)}</Text>
      </Box>
      <DataOutputSpecsDisplay specs={method.dataOutputSpecs} />
    </Box>
  );
}

/**
 * Interactive display component for type description.
 */
export function TypeDescribeDisplay(
  props: TypeDescribeDisplayProps,
): React.ReactElement {
  const { data } = props;

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Text color="green" bold>
        # {data.type.normalized}
      </Text>

      {/* Metadata */}
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text color="cyan">Normalized:</Text>
          <Text>{data.type.normalized}</Text>
        </Text>
        <Text>
          <Text color="cyan">Version:</Text>
          <Text>{data.version}</Text>
        </Text>
      </Box>

      {/* Input Attributes Schema */}
      <SchemaSection
        title="Input Attributes Schema"
        schema={data.inputAttributesSchema}
      />

      {/* Methods */}
      <Box flexDirection="column" marginTop={1}>
        <Text color="cyan" bold>
          ## Methods
        </Text>
        {data.methods.map((method) => (
          <MethodDisplay key={method.name} method={method} />
        ))}
      </Box>
    </Box>
  );
}
