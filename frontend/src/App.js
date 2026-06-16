import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider, useAuth } from "./auth";
import ErrorBoundary from "./components/ErrorBoundary";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Presence from "./pages/Presence";
import CheckIn from "./pages/CheckIn";
import Profile from "./pages/Profile";
import DisabledFeature from "./pages/DisabledFeature";
import MyLeaves from "./pages/MyLeaves";
import Muster from "./pages/Muster";
import AdminConsole from "./pages/admin/Console";
import Members from "./pages/admin/Members";
import AdminLeaves from "./pages/admin/Leaves";
import Devices from "./pages/admin/Devices";
import OfficeSettings from "./pages/admin/Office";
import OfficeQR from "./pages/admin/OfficeQR";
import Reports from "./pages/admin/Reports";
import Sessions from "./pages/admin/Sessions";
import ImportMembers from "./pages/admin/ImportMembers";
import Cards from "./pages/admin/Cards";
import { Loader2 } from "lucide-react";

function RequireAuth({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <FullPageSpinner />;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function RequireAdmin({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <FullPageSpinner />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== "admin") return <Navigate to="/" replace />;
  return children;
}

function RequireMuster({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <FullPageSpinner />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== "admin" && user.category !== "coach") return <Navigate to="/" replace />;
  return children;
}

function FullPageSpinner() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50" data-testid="app-loading">
      <Loader2 className="animate-spin text-slate-400" size={28} />
    </div>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <BrowserRouter>
        <Toaster position="top-center" richColors closeButton />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<RequireAuth><Layout /></RequireAuth>}>
            <Route index element={<Presence />} />
            <Route path="check-in" element={<DisabledFeature title="QR & GPS check-in disabled" reason="Use Muster Roll instead — your coach will check you in." />} />
            <Route path="muster" element={<RequireMuster><Muster /></RequireMuster>} />
            <Route path="my-leaves" element={<MyLeaves />} />
            <Route path="profile" element={<Profile />} />
            <Route path="admin" element={<RequireAdmin><AdminConsole /></RequireAdmin>} />
            <Route path="admin/members" element={<RequireAdmin><Members /></RequireAdmin>} />
            <Route path="admin/leaves" element={<RequireAdmin><AdminLeaves /></RequireAdmin>} />
            <Route path="admin/devices" element={<RequireAdmin><Devices /></RequireAdmin>} />
            <Route path="admin/office" element={<RequireAdmin><OfficeSettings /></RequireAdmin>} />
            <Route path="admin/office-qr" element={<RequireAdmin><DisabledFeature title="Office QR disabled" reason="QR scanning is turned off — use Muster Roll." /></RequireAdmin>} />
            <Route path="admin/reports" element={<RequireAdmin><Reports /></RequireAdmin>} />
            <Route path="admin/sessions" element={<RequireAdmin><Sessions /></RequireAdmin>} />
            <Route path="admin/import" element={<RequireAdmin><ImportMembers /></RequireAdmin>} />
            <Route path="admin/cards" element={<RequireAdmin><DisabledFeature title="Member Cards disabled" reason="Personal QR cards are turned off for now — Muster Roll handles attendance." /></RequireAdmin>} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
    </ErrorBoundary>
  );
}

export default App;
