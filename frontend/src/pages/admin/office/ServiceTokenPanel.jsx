import React, { useEffect, useState } from "react";
import { Loader2, KeyRound, RefreshCw, Copy, Trash2, Check } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../../api";

/**
 * ServiceTokenPanel — generate a single, non-expiring, READ-ONLY API token
 * for background/programmatic GET access. The secret is shown ONCE on
 * creation (only a hash is stored). Regenerating replaces the previous token;
 * Revoke disables it immediately. Admins only.
 */
export function ServiceTokenPanel() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState(null);   // plaintext, shown once
  const [copied, setCopied] = useState(false);

  const loadStatus = () => api.get("/auth/service-token")
    .then(setStatus)
    .catch((err) => toast.error(err?.message || "Failed to load token status"))
    .finally(() => setLoading(false));
  useEffect(() => { loadStatus(); }, []);

  const generate = async () => {
    if (status?.exists && !window.confirm("Regenerate the API token? The current token will stop working immediately.")) return;
    setBusy(true);
    try {
      const res = await api.post("/auth/service-token", {});
      setToken(res.token);
      setCopied(false);
      await loadStatus();
      toast.success("API token generated — copy it now");
    } catch (err) {
      toast.error(err?.message || "Generation failed");
    } finally { setBusy(false); }
  };

  const revoke = async () => {
    if (!window.confirm("Revoke the API token? Any background script using it will stop working.")) return;
    setBusy(true);
    try {
      await api.del("/auth/service-token");
      setToken(null);
      await loadStatus();
      toast.success("API token revoked");
    } catch (err) {
      toast.error(err?.message || "Revoke failed");
    } finally { setBusy(false); }
  };

  const copy = () => {
    if (!token) return;
    navigator.clipboard?.writeText(token);
    setCopied(true);
    toast.success("Copied to clipboard");
  };

  return (
    <div className="iu-card p-4 sm:p-6 mt-6" data-testid="service-token-panel">
      <div className="mb-4">
        <h2 className="text-xl font-extrabold tracking-tight flex items-center gap-2">
          <KeyRound size={18} className="text-slate-700" /> API Access Token
        </h2>
        <p className="text-xs text-slate-500 mt-1">
          A single, non-expiring, <b>read-only</b> token for background/automation access. Send it as
          an <code className="px-1 bg-slate-100 rounded">Authorization: Bearer &lt;token&gt;</code> header.
          It can only call read (GET) endpoints. Keep it secret — treat it like a password.
        </p>
      </div>

      {loading ? (
        <Loader2 className="animate-spin text-slate-400" size={18} />
      ) : (
        <>
          <div className="text-sm text-slate-600 mb-3" data-testid="service-token-status">
            {status?.exists ? (
              <span>
                Active token <span className="font-mono font-semibold">{status.prefix}…{status.last4}</span>
                {" · "}created {String(status.created_at || "").slice(0, 10)}
                {status.last_used_at ? ` · last used ${String(status.last_used_at).slice(0, 16).replace("T", " ")}` : " · never used yet"}
              </span>
            ) : (
              <span className="text-slate-400">No API token yet.</span>
            )}
          </div>

          {token && (
            <div className="mb-3 p-3 rounded-lg border border-amber-300 bg-amber-50" data-testid="service-token-reveal">
              <p className="text-[11px] font-bold text-amber-800 mb-1">
                Copy this now — it is shown only once and cannot be retrieved again.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 min-w-0 break-all select-all text-xs bg-white border border-amber-200 rounded p-2 font-mono" data-testid="service-token-value">
                  {token}
                </code>
                <button type="button" onClick={copy} className="iu-btn-secondary shrink-0" data-testid="service-token-copy">
                  {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={generate} disabled={busy} className="iu-btn-primary" data-testid="service-token-generate">
              {busy ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={15} />}
              {status?.exists ? "Regenerate token" : "Generate token"}
            </button>
            {status?.exists && (
              <button type="button" onClick={revoke} disabled={busy} className="iu-btn-secondary !text-rose-600 !border-rose-200 hover:!bg-rose-50" data-testid="service-token-revoke">
                <Trash2 size={15} /> Revoke
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
