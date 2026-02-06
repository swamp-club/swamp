import type { OutputMode } from "./output.ts";

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
 * Renders the type description in either log or JSON mode.
 */
export function renderTypeDescribe(
  data: TypeDescribeData,
  mode: OutputMode,
): void {
  if (mode === "json") {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}
