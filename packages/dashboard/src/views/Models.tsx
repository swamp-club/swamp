import { useRequest } from "../client/useRequest";
import { extractArray } from "../client/extract";

interface ModelDef {
  id: string;
  name: string;
  type: string;
  methods?: string[];
}

interface ModelsProps {
  onOpenModel?: (modelName: string) => void;
}

export function Models({ onOpenModel }: ModelsProps) {
  const { data } = useRequest("model.search");

  const models = extractArray<ModelDef>(data);

  return (
    <>
      <div className="page-header">
        <h1>Models</h1>
        <div className="header-right">
          <div
            className="health-pill"
            style={{
              background: "var(--surface)",
              color: "var(--text-2)",
              border: "1px solid var(--border)",
            }}
          >
            {models.length} definitions
          </div>
        </div>
      </div>

      <div className="card-grid">
        {models.map((m) => (
          <div
            className="card"
            key={m.id}
            onClick={() => onOpenModel?.(m.name)}
          >
            <div className="card-header">
              <span className="card-name">{m.name}</span>
              <span
                className="mono"
                style={{ fontSize: "0.75rem", color: "var(--text-3)" }}
              >
                {m.type}
              </span>
            </div>
            {m.methods && (
              <div className="card-meta">
                <span>Methods: {m.methods.join(", ")}</span>
              </div>
            )}
          </div>
        ))}
        {models.length === 0 && (
          <div className="loading">
            No models defined
          </div>
        )}
      </div>
    </>
  );
}
