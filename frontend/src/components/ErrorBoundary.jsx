import React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

/**
 * Catches uncaught React render/lifecycle errors so users see a clear
 * recovery screen instead of a blank white page. Production crashes are
 * logged to console.error so you can grab them from browser devtools.
 */
export default class ErrorBoundary extends React.Component {
  state = { error: null, info: null };

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
    // Hard reload as fallback — clears any stuck UI state.
    if (typeof window !== "undefined") window.location.reload();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        className="min-h-screen flex items-center justify-center p-6 bg-slate-50"
        data-testid="error-boundary"
      >
        <div className="iu-card max-w-md w-full p-7 text-center">
          <div className="mx-auto w-14 h-14 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center mb-4">
            <AlertTriangle size={26} />
          </div>
          <h1 className="text-2xl font-extrabold text-slate-900">Something went wrong</h1>
          <p className="text-sm text-slate-500 mt-2">
            The app hit an unexpected error. Refreshing usually fixes it. If it keeps happening,
            share this screen with your admin and try the GPS check-in instead of QR scan.
          </p>
          {error?.message && (
            <pre
              data-testid="error-boundary-detail"
              className="text-left text-[11px] mt-4 p-3 rounded-lg bg-slate-900 text-slate-200 overflow-auto max-h-32"
            >
              {String(error.message).slice(0, 400)}
            </pre>
          )}
          <button
            data-testid="error-boundary-refresh"
            onClick={this.handleReset}
            className="iu-btn-primary mt-5 mx-auto"
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>
    );
  }
}
