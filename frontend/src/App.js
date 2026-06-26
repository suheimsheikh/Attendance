import React, { Suspense, lazy } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider, useAuth } from "./auth";
import ErrorBoundary from "./components/ErrorBoundary";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import SelfCheckIn from "./pages/SelfCheckIn";
import { Loader2 } from "lucide-react";

// Admin and seldom-used routes are code-split — keeps the athlete bundle
// (login + self check-in) trim. The chunks are fetched on first navigation.
const Presence = lazy(() => import("./pages/Presence"));
const Profile = lazy(() => import("./pages/Profile"));
const MyLeaves = lazy(() => import("./pages/MyLeaves"));
const Muster = lazy(() => import("./pages/Muster"));
const Members = lazy(() => import("./pages/admin/Members"));
const AdminLeaves = lazy(() => import("./pages/admin/Leaves"));
const Devices = lazy(() => import("./pages/admin/Devices"));
const OfficeSettings = lazy(() => import("./pages/admin/Office"));
const Reports = lazy(() => import("./pages/admin/Reports"));
const Overtime = lazy(() => import("./pages/admin/Overtime"));
const Approvals = lazy(() => import("./pages/admin/Approvals"));
const LeaveBalances = lazy(() => import("./pages/admin/LeaveBalances"));
const Holidays = lazy(() => import("./pages/admin/Holidays"));
const Payroll = lazy(() => import("./pages/admin/Payroll"));
const Institutions = lazy(() => import("./pages/admin/Institutions"));
const Fleets = lazy(() => import("./pages/admin/Fleets"));
const Calendar = lazy(() => import("./pages/admin/Calendar"));
const BackupRestore = lazy(() => import("./pages/admin/BackupRestore"));
const ImportMembers = lazy(() => import("./pages/admin/ImportMembers"));
const SmsLog = lazy(() => import("./pages/admin/SmsLog"));
const WhatsNew = lazy(() => import("./pages/WhatsNew"));
const Cards = lazy(() => import("./pages/admin/Cards"));

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
        <Suspense fallback={<FullPageSpinner />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<RequireAuth><Layout /></RequireAuth>}>
            <Route index element={<SelfCheckIn />} />
            <Route path="check-in" element={<SelfCheckIn />} />
            <Route path="presence" element={<RequireMuster><Presence /></RequireMuster>} />
            <Route path="muster" element={<RequireMuster><Muster /></RequireMuster>} />
            <Route path="my-leaves" element={<MyLeaves />} />
            <Route path="whats-new" element={<WhatsNew />} />
            <Route path="profile" element={<Profile />} />
            <Route path="admin" element={<Navigate to="/presence" replace />} />
            <Route path="admin/members" element={<RequireAdmin><Members /></RequireAdmin>} />
            <Route path="admin/approvals" element={<RequireAdmin><Approvals /></RequireAdmin>} />
            {/* Legacy direct links — keep deep-links working but funnel into Approvals. */}
            <Route path="admin/leaves" element={<Navigate to="/admin/approvals?tab=leaves" replace />} />
            <Route path="admin/overtime" element={<Navigate to="/admin/approvals?tab=overtime" replace />} />
            {/* Internal pages still mounted at their old paths for fallback / tests. */}
            <Route path="admin/leaves-page" element={<RequireAdmin><AdminLeaves /></RequireAdmin>} />
            <Route path="admin/overtime-page" element={<RequireAdmin><Overtime /></RequireAdmin>} />
            <Route path="admin/devices" element={<RequireAdmin><Devices /></RequireAdmin>} />
            <Route path="admin/office" element={<RequireAdmin><OfficeSettings /></RequireAdmin>} />
            <Route path="admin/sms-log" element={<RequireAdmin><SmsLog /></RequireAdmin>} />
            <Route path="admin/reports" element={<RequireAdmin><Reports /></RequireAdmin>} />
            <Route path="admin/payroll" element={<RequireAdmin><Payroll /></RequireAdmin>} />
            <Route path="admin/sessions" element={<Navigate to="/presence" replace />} />
            <Route path="admin/leave-balances" element={<RequireAdmin><LeaveBalances /></RequireAdmin>} />
            <Route path="admin/holidays" element={<RequireAdmin><Holidays /></RequireAdmin>} />
            <Route path="admin/group-leave" element={<Navigate to="/admin/leaves" replace />} />
            <Route path="admin/institutions" element={<RequireAdmin><Institutions /></RequireAdmin>} />
            <Route path="admin/fleets" element={<RequireAdmin><Fleets /></RequireAdmin>} />
            <Route path="admin/cards" element={<RequireAdmin><Cards /></RequireAdmin>} />
            <Route path="admin/camps" element={<Navigate to="/admin/calendar" replace />} />
            <Route path="admin/calendar" element={<RequireAdmin><Calendar /></RequireAdmin>} />
            <Route path="admin/backup" element={<RequireAdmin><BackupRestore /></RequireAdmin>} />
            <Route path="admin/import" element={<RequireAdmin><ImportMembers /></RequireAdmin>} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
      </BrowserRouter>
    </AuthProvider>
    </ErrorBoundary>
  );
}

export default App;
