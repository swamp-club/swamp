import { useRequest } from "../client/useRequest";
import { extractObject } from "../client/extract";
import { CodeBlock } from "../components/CodeBlock";

interface ModelDetailProps {
  modelName: string;
  onBack: () => void;
}

interface ModelData {
  name: string;
  type: string;
  id: string;
  version?: number;
  tags?: Record<string, string>;
  globalArguments?: Record<string, unknown>;
  methods?: Record<string, unknown>;
  definition?: string;
  [key: string]: unknown;
}

export function ModelDetail({ modelName, onBack }: ModelDetailProps) {
  const { data, loading, error } = useRequest("model.get", {
    modelIdOrName: modelName,
  });

  const model = extractObject<ModelData>(data);

  return (
    <>
      <div className="page-header">
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button
            type="button"
            onClick={onBack}
            style={{
              border: "1px solid var(--border)",
              background: "var(--surface)",
              borderRadius: 6,
              padding: "4px 10px",
              cursor: "pointer",
              color: "var(--text-2)",
              fontFamily: "inherit",
              fontSize: "0.82rem",
            }}
          >
            &larr; Back
          </button>
          <h1>{modelName}</h1>
        </div>
        {model && (
          <div className="header-right">
            <span
              className="mono"
              style={{ fontSize: "0.78rem", color: "var(--text-3)" }}
            >
              {model.type}
            </span>
          </div>
        )}
      </div>

      {loading && <div className="loading">Loading model...</div>}
      {error && (
        <div className="loading" style={{ color: "var(--danger)" }}>
          {error}
        </div>
      )}

      {model && (
        <div className="panel">
          <div className="panel-header">
            <div className="panel-title">Definition</div>
            <span className="panel-count">{model.type}</span>
          </div>
          <CodeBlock
            code={model.definition ?? JSON.stringify(model, null, 2)}
          />
        </div>
      )}
    </>
  );
}
