export function Logo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const fontSize = size === "lg" ? "2rem" : size === "md" ? "1.4rem" : "1rem";

  return (
    <span
      style={{
        fontFamily: "'Orbitron', sans-serif",
        fontWeight: 900,
        fontSize,
        letterSpacing: "0.1em",
        lineHeight: 1,
        userSelect: "none",
      }}
    >
      <span style={{ color: "#22d3ee" }}>S</span>
      <span style={{ color: "#ec4899" }}>C</span>
    </span>
  );
}
