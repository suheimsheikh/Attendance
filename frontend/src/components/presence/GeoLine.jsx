import React from "react";
import { MapPin } from "lucide-react";

export function formatDist(m) {
  if (m == null) return null;
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

export function describeGeo(g) {
  if (!g || !g.method) return null;
  // GPS truly missing → "GPS unavailable", with the muster verifier as a
  // separate field so the UI can bold their name.
  if (g.geo_unavailable) {
    return {
      label: "GPS unavailable",
      verifierName: g.method === "muster" ? g.by || null : null,
      tone: "amber",
    };
  }
  const d = formatDist(g.distance_m);
  if (d == null) {
    if (g.method === "muster") {
      return { label: g.by ? "" : "Muster · no GPS", verifierName: g.by || null, tone: "slate" };
    }
    return { label: "distance not captured", verifierName: null, tone: "amber" };
  }
  // Distance present — always lead with it. For muster check-ins, hand the
  // verifier's name to the UI separately so it can render it in bold.
  const siteTag = g.out_of_geofence ? "off-site" : "on-site";
  return {
    label: `${d} ${siteTag}`,
    verifierName: g.method === "muster" ? g.by || null : null,
    tone: g.out_of_geofence ? "amber" : "emerald",
  };
}

function GeoChip({ label, tone, ...rest }) {
  const colour = tone === "amber" ? "text-amber-600" : tone === "emerald" ? "text-emerald-600" : "text-slate-500";
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400">{label}</span>
      <MapPin size={9} className={colour} />
      {rest.label && <span className={colour}>{rest.label}</span>}
      {rest.verifierName && (
        <span className={`font-bold ${colour}`}>{rest.verifierName}</span>
      )}
    </span>
  );
}

export function GeoLine({ geoIn, geoOut, status }) {
  const inInfo = describeGeo(geoIn);
  // Show check-out distance whenever it's recorded. Today we only render
  // it for "exited" to keep the row tight.
  const outInfo = status === "exited" ? describeGeo(geoOut) : null;
  if (!inInfo && !outInfo) return null;
  return (
    <div className="text-[10px] text-slate-500 mt-1 flex flex-col gap-0.5">
      {inInfo && <GeoChip label="IN" {...inInfo} />}
      {outInfo && <GeoChip label="OUT" {...outInfo} />}
    </div>
  );
}
