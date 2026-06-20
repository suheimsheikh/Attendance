import React, { useState, useEffect } from "react";
import { initials } from "../utils";

export default function Avatar({ name, photo, size = 40, ring = null }) {
  const dim = `${size}px`;
  // Track whether the provided photo URL/data URL failed to load. If yes, we
  // gracefully fall back to the initials block — broken-image glyphs look bad
  // on the Presence board.
  const [broken, setBroken] = useState(false);
  // Reset broken state when the photo prop changes (e.g. after admin uploads
  // a replacement) so we don't get stuck showing initials forever.
  useEffect(() => { setBroken(false); }, [photo]);

  if (photo && !broken) {
    return (
      <img
        src={photo}
        alt={name || ""}
        onError={() => setBroken(true)}
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
