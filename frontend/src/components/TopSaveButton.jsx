import React from "react";
import { Loader2, Save } from "lucide-react";

/** Top-of-modal Save button: submits `formId`, glows amber while the form is dirty. */
export default function TopSaveButton({ formId, dirty, saving, label = "Save", testId = "modal-top-save" }) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-dirty={dirty ? "true" : "false"}
      disabled={saving}
      onClick={() => document.getElementById(formId)?.requestSubmit()}
      title={dirty ? "You have unsaved changes — click to save (Esc discards)" : "Nothing changed yet"}
      className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-full text-sm font-semibold transition-colors ${
        dirty
          ? "bg-amber-500 hover:bg-amber-600 text-white shadow-md ring-2 ring-amber-200 animate-pulse"
          : "bg-slate-100 text-slate-500"
      }`}
    >
      {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
      {dirty ? `${label} · unsaved` : label}
    </button>
  );
}
