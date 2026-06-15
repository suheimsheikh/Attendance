import React from "react";
import { initials } from "../utils";

export default function Avatar({ name, photo, size = 40, ring = null }) {
  const dim = `${size}px`;
  if (photo) {
    return (
      <img
        src={photo}
        alt={name || ""}
        style={{
          width: dim,
          height: dim,
          borderRadius: "50%",
          objectFit: "cover",
          boxShadow: ring ? `0 0 0 2px white, 0 0 0 4px ${ring}` : undefined,
        }}
      />
    );
  }
  // Initials avatar
  const colors = ["#1F2937", "#374151", "#4B5563", "#0F172A", "#1E293B"];
  const idx = (name || "?").charCodeAt(0) % colors.length;
  return (
    <div
      style={{
        width: dim,
        height: dim,
        borderRadius: "50%",
        background: colors[idx],
        color: "white",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: Math.max(11, size * 0.38),
        fontWeight: 700,
        letterSpacing: "0.02em",
        boxShadow: ring ? `0 0 0 2px white, 0 0 0 4px ${ring}` : undefined,
      }}
    >
      {initials(name)}
    </div>
  );
}
