/**
 * Type of model reference in an expression.
 */
export type DependencyType =
  | "input"
  | "resource"
  | "data"
  | "file"
  | "execution"
  | "definition";

/**
 * Artifact types that create implicit workflow dependencies.
 */
export const ArtifactDependencyTypes: readonly DependencyType[] = [
  "resource",
  "data",
  "file",
] as const;

/**
 * Represents a dependency extracted from an expression.
 */
export interface ExpressionDependency {
  /** The model reference (name or UUID) */
  modelRef: string;
  /** Whether the dependency is on input or resource data */
  type: DependencyType;
}

/**
 * Pattern to match model references in CEL expressions.
 * Matches: model.<name-or-uuid>.(input|resource|file|execution|definition)
 */
const MODEL_REF_PATTERN =
  /model\.([a-zA-Z0-9_-]+)\.(input|resource|file|execution|definition)/g;

/**
 * Pattern to match data function calls in CEL expressions.
 * Matches: data.version('model', 'data', N), data.latest('model', 'data'), data.listVersions('model', 'data')
 */
const DATA_FUNCTION_PATTERN =
  /data\.(version|latest|listVersions)\s*\(\s*['"]([^'"]+)['"]/g;

/**
 * Extracts model dependencies from a CEL expression.
 *
 * @param expression - The CEL expression to analyze
 * @returns Array of dependencies found in the expression
 */
export function extractDependencies(
  expression: string,
): ExpressionDependency[] {
  const dependencies: ExpressionDependency[] = [];
  const seen = new Set<string>();

  const matches = expression.matchAll(MODEL_REF_PATTERN);
  for (const match of matches) {
    const modelRef = match[1];
    const type = match[2] as DependencyType;
    const key = `${modelRef}:${type}`;

    // Deduplicate
    if (!seen.has(key)) {
      seen.add(key);
      dependencies.push({ modelRef, type });
    }
  }

  return dependencies;
}

/**
 * Extracts all model references from a CEL expression (both input and resource).
 * Also extracts model references from data function calls.
 *
 * @param expression - The CEL expression to analyze
 * @returns Array of unique model references
 */
export function extractModelRefs(expression: string): string[] {
  const refs = new Set<string>();

  // Extract from model.X.property patterns
  const modelMatches = expression.matchAll(MODEL_REF_PATTERN);
  for (const match of modelMatches) {
    refs.add(match[1]);
  }

  // Extract from data.version('model', ...), data.latest('model', ...), etc.
  const dataMatches = expression.matchAll(DATA_FUNCTION_PATTERN);
  for (const match of dataMatches) {
    refs.add(match[2]);
  }

  return [...refs];
}

/**
 * Checks if an expression has any artifact dependencies (resource, file).
 * Artifact dependencies create implicit workflow step dependencies.
 *
 * @param expression - The CEL expression to check
 * @returns True if the expression references any model artifacts
 */
export function hasArtifactDependency(expression: string): boolean {
  return /model\.[a-zA-Z0-9_-]+\.(resource|file)/.test(expression);
}

/**
 * Checks if an expression has any resource dependencies.
 * Resource dependencies create implicit workflow step dependencies.
 *
 * @param expression - The CEL expression to check
 * @returns True if the expression references any model resources
 */
export function hasResourceDependency(expression: string): boolean {
  return /model\.[a-zA-Z0-9_-]+\.resource/.test(expression);
}

/**
 * Extracts all artifact dependencies from a CEL expression.
 * These create implicit workflow step dependencies.
 * Includes both model.X.resource/file patterns and data.version/latest/listVersions function calls.
 *
 * @param expression - The CEL expression to analyze
 * @returns Array of dependencies with artifact types (resource, data, file)
 */
export function extractArtifactDependencies(
  expression: string,
): ExpressionDependency[] {
  const dependencies: ExpressionDependency[] = [];
  const seen = new Set<string>();

  // Extract from model.X.property patterns
  const pattern = /model\.([a-zA-Z0-9_-]+)\.(resource|file)/g;
  const matches = expression.matchAll(pattern);
  for (const match of matches) {
    const modelRef = match[1];
    const type = match[2] as DependencyType;
    const key = `${modelRef}:${type}`;

    if (!seen.has(key)) {
      seen.add(key);
      dependencies.push({ modelRef, type });
    }
  }

  // Extract from data function calls (all data functions create data dependencies)
  const dataMatches = expression.matchAll(DATA_FUNCTION_PATTERN);
  for (const match of dataMatches) {
    const modelRef = match[2];
    const key = `${modelRef}:data`;

    if (!seen.has(key)) {
      seen.add(key);
      dependencies.push({ modelRef, type: "data" });
    }
  }

  return dependencies;
}

/**
 * Extracts only resource dependencies from a CEL expression.
 * These create implicit workflow step dependencies.
 *
 * @param expression - The CEL expression to analyze
 * @returns Array of model references that have resource dependencies
 */
export function extractResourceDependencies(expression: string): string[] {
  const refs = new Set<string>();

  const matches = expression.matchAll(/model\.([a-zA-Z0-9_-]+)\.resource/g);
  for (const match of matches) {
    refs.add(match[1]);
  }

  return [...refs];
}

/**
 * Checks if an expression contains a self-reference.
 *
 * @param expression - The CEL expression to check
 * @returns True if the expression references 'self'
 */
export function hasSelfReference(expression: string): boolean {
  return /\bself\b/.test(expression);
}

/**
 * Extracts model references from data function calls.
 *
 * @param expression - The CEL expression to analyze
 * @returns Array of model references from data.version/latest/listVersions calls
 */
export function extractDataFunctionDependencies(expression: string): string[] {
  const refs = new Set<string>();

  const dataMatches = expression.matchAll(DATA_FUNCTION_PATTERN);
  for (const match of dataMatches) {
    refs.add(match[2]);
  }

  return [...refs];
}

/**
 * Checks if an expression has any data function calls.
 *
 * @param expression - The CEL expression to check
 * @returns True if the expression contains data.version, data.latest, or data.listVersions
 */
export function hasDataFunctionDependency(expression: string): boolean {
  return /data\.(version|latest|listVersions)\s*\(/.test(expression);
}
