/**
 * Type of model reference in an expression.
 */
export type DependencyType =
  | "input"
  | "resource"
  | "data"
  | "file"
  | "log"
  | "execution";

/**
 * Artifact types that create implicit workflow dependencies.
 */
export const ArtifactDependencyTypes: readonly DependencyType[] = [
  "resource",
  "data",
  "file",
  "log",
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
 * Matches: model.<name-or-uuid>.(input|resource|data|file|log|execution)
 */
const MODEL_REF_PATTERN =
  /model\.([a-zA-Z0-9_-]+)\.(input|resource|data|file|log|execution)/g;

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
 *
 * @param expression - The CEL expression to analyze
 * @returns Array of unique model references
 */
export function extractModelRefs(expression: string): string[] {
  const refs = new Set<string>();

  const matches = expression.matchAll(MODEL_REF_PATTERN);
  for (const match of matches) {
    refs.add(match[1]);
  }

  return [...refs];
}

/**
 * Checks if an expression has any artifact dependencies (resource, data, file, log).
 * Artifact dependencies create implicit workflow step dependencies.
 *
 * @param expression - The CEL expression to check
 * @returns True if the expression references any model artifacts
 */
export function hasArtifactDependency(expression: string): boolean {
  return /model\.[a-zA-Z0-9_-]+\.(resource|data|file|log)/.test(expression);
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
 *
 * @param expression - The CEL expression to analyze
 * @returns Array of dependencies with artifact types (resource, data, file, log)
 */
export function extractArtifactDependencies(
  expression: string,
): ExpressionDependency[] {
  const dependencies: ExpressionDependency[] = [];
  const seen = new Set<string>();

  const pattern = /model\.([a-zA-Z0-9_-]+)\.(resource|data|file|log)/g;
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
