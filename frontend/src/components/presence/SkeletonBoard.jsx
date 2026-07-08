import React from "react";
import { COLUMNS } from "./constants";

export function SkeletonBoard() {
  return (
    <div className="grid gap-3 md:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      {COLUMNS.map((col) => (
        <div key={col.key} className={`rounded-2xl ${col.soft} border border-slate-200 overflow-hidden`}>
          <div className="px-4 py-3 bg-white/70 border-b border-slate-200 h-12" />
          <div className="bg-white divide-y divide-slate-100">
            {[...Array(4)].map((_, i) => (
              <div key={`sk-${col.key}-${i}`} className="px-3 py-3 flex items-start gap-2.5">
                <div className="w-9 h-9 rounded-full bg-slate-200 animate-pulse" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-2.5 bg-slate-200 rounded w-3/4 animate-pulse" />
                  <div className="h-2 bg-slate-200 rounded w-1/2 animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
