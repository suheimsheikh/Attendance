import React from "react";
import { Link } from "react-router-dom";
import { Construction, ArrowLeft } from "lucide-react";

export default function DisabledFeature({ title = "Feature disabled", reason }) {
  return (
    <div className="min-h-[70vh] flex items-center justify-center p-6">
      <div className="iu-card max-w-md w-full p-7 text-center" data-testid="disabled-feature">
        <div className="mx-auto w-14 h-14 rounded-full bg-slate-100 text-slate-600 flex items-center justify-center mb-4">
          <Construction size={26} />
        </div>
        <h1 className="text-2xl font-extrabold text-slate-900">{title}</h1>
        <p className="text-sm text-slate-500 mt-2">
          {reason || "This feature is temporarily turned off."}
        </p>
        <p className="text-sm text-slate-500 mt-3">
          Coaches and admins should use <b>Muster Roll</b> to record attendance.
        </p>
        <Link to="/" className="iu-btn-primary mt-5 mx-auto inline-flex">
          <ArrowLeft size={14} /> Back to Presence
        </Link>
      </div>
    </div>
  );
}
