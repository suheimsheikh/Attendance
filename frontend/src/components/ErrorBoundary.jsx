import React from "react";
import { AlertTriangle, RefreshCw, Copy } from "lucide-react";

/**
 * Catches uncaught React render/lifecycle errors so users see a clear
 * recovery screen instead of a blank white page. Production crashes are
 * logged to console.error so you can grab them from browser devtools.
 */
export default class ErrorBoundary extends React.Component {
  state = { error: null, info: null, copied: false };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error("App crash caught by ErrorBoundary:", error, info?.componentStack);
    this.setState({ info });
  }

  handleReset = () => {
    this.setState({ error: null, info: null });
    if (typeof window !== "undefined") window.location.reload();
  };

  handleCopy = () => {
    const text = this._diagnostic();
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => this.setState({ copied: true }));
    }
  };

  _diagnostic() {
    const { error, info } = this.state;
    const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "?";
    const url = (typeof window !== "undefined" && window.location.href) || "?";
    const msg = error?.message || String(error) || "(no message)";
    const stack = error?.stack || "(no stack)";
    const tree = info?.componentStack || "";
    return `URL: ${url}\nUA: ${ua}\n\nMessage: ${msg}\n\nStack:\n${stack}\n\nReact tree:\n${tree}`;
  }

  render() {
    const { error, copied } = this.state;
    if (!error) return this.props.children;
    const diag = this._diagnostic();

    return (
      <div
        className="min-h-screen flex items-center justify-center p-6 bg-slate-50"
        data-testid="error-boundary"
      >
        <div className="iu-card max-w-lg w-full p-6 text-center">
          <div className="mx-auto w-14 h-14 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center mb-4">
            <AlertTriangle size={26} />
          </div>
          <h1 className="text-2xl font-extrabold text-slate-900">Something went wrong</h1>
          <p className="text-sm text-slate-500 mt-2">
            The app hit an unexpected error. Refresh to recover. If it keeps happening,
            please <b>copy this error</b> and share with your admin, or use GPS check-in instead of QR scan.
          </p>

          <pre
            data-testid="error-boundary-detail"
            className="text-left text-[10px] leading-snug mt-4 p-3 rounded-lg bg-slate-900 text-slate-200 overflow-auto max-h-56 whitespace-pre-wrap break-words"
          >
            {diag.slice(0, 1500)}
          </pre>

          <div className="flex gap-2 mt-4">
            <button
              data-testid="error-boundary-copy"
              onClick={this.handleCopy}
              className="iu-btn-secondary flex-1"
            >
              <Copy size={14} /> {copied ? "Copied!" : "Copy error"}
            </button>
            <button
              data-testid="error-boundary-refresh"
              onClick={this.handleReset}
              className="iu-btn-primary flex-1"
            >
              <RefreshCw size={14} /> Refresh
            </button>
          </div>
        </div>
      </div>
    );
  }
}
