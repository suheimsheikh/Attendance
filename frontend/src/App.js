import React, { Suspense, lazy } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import { AuthProvider, useAuth } from "./auth";
import ErrorBoundary from "./components/ErrorBoundary";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import SelfCheckIn from "./pages/SelfCheckIn";
import VersionPoller from "./components/VersionPoller";
import { Loader2 } from "lucide-react";

// Admin and seldom-used routes are code-split — keeps the athlete bundle
// (login + self check-in) trim. The chunks are fetched on first navigation.
const Presence = lazy(() => import("./pages/Presence"));
const Profile = lazy(() => import("./pages/Profile"));
const MyLeaves = lazy(() => import("./pages/MyLeaves"));
const Muster = lazy(() => import("./pages/Muster"));
const Meals = lazy(() => import("./pages/Meals"));
const MealsReport = lazy(() => import("./pages/admin/MealsReport"));
const MealsCalendar = lazy(() => import("./pages/admin/MealsCalendar"));
const Members = lazy(() => import("./pages/admin/Members"));
const AdminLeaves = lazy(() => import("./pages/admin/Leaves"));
const Devices = lazy(() => import("./pages/admin/Devices"));
const OfficeSettings = lazy(() => import("./pages/admin/Office"));
const Reports = lazy(() => import("./pages/admin/Reports"));
// Overtime page removed 15 Feb 2026 — OT approval workflow deprecated;
// OT hours are now surfaced via The Grid and the OT ledger.
const Approvals = lazy(() => import("./pages/admin/ApprovalsUnified"));
const LeaveBalances = lazy(() => import("./pages/admin/LeaveBalances"));
const Institutions = lazy(() => import("./pages/admin/Institutions"));
const Fleets = lazy(() => import("./pages/admin/Fleets"));
const Sites = lazy(() => import("./pages/admin/Sites"));
const Calendar = lazy(() => import("./pages/admin/Calendar"));
const BackupRestore = lazy(() => import("./pages/admin/BackupRestore"));
const ImportMembers = lazy(() => import("./pages/admin/ImportMembers"));
const SmsLog = lazy(() => import("./pages/admin/SmsLog"));
const WhatsNew = lazy(() => import("./pages/WhatsNew"));
const Cards = lazy(() => import("./pages/admin/Cards"));
const EscortCheckIn = lazy(() => import("./pages/EscortCheckIn"));
const EscortPhotoCleanup = lazy(() => import("./pages/admin/EscortPhotoCleanup"));
const AuditLog = lazy(() => import("./pages/admin/AuditLog"));
const DataQuality = lazy(() => import("./pages/admin/DataQuality"));
const Dashboard = lazy(() => import("./pages/admin/Dashboard"));
const ChefsView = lazy(() => import("./pages/admin/ChefsView"));
const Categories = lazy(() => import("./pages/admin/Categories"));
const CategoryHealth = lazy(() => import("./pages/admin/CategoryHealth"));
const Roles = lazy(() => import("./pages/admin/Roles"));
const MyCorrections = lazy(() => import("./pages/MyCorrections"));

function RequireAuth({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <FullPageSpinner />;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

/**
 * RequireMember — gates member-only routes against escort tokens.
 * Escorts have no payroll / profile / leave entity, so we redirect them
 * straight to their kiosk. Used for the SelfCheckIn home, MyLeaves,
 * Profile and any other route that derives from a `users` row.
 */
function RequireMember({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <FullPageSpinner />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.is_escort) return <Navigate to="/escort-checkin" replace />;
  return children;
}

function RequireAdmin({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <FullPageSpinner />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== "admin") return <Navigate to="/" replace />;
  return children;
}

function RequireChefOrAdmin({ children }) {
  // Chef's View — 4 Feb 2026 accessible to users with role="chef" and
  // to coaches (category="coach") so on-the-ground staff can plan
  // meal counts alongside Muster / Presence.
  const { user, loading } = useAuth();
  if (loading) return <FullPageSpinner />;
  if (!user) return <Navigate to="/login" replace />;
  const allow = user.role === "admin" || user.role === "chef" || user.category === "coach";
  if (!allow) return <Navigate to="/" replace />;
  return children;
}

function RequireMuster({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <FullPageSpinner />;
  if (!user) return <Navigate to="/login" replace />;
  // Admins, coaches, chefs, and active escorts can run muster. Escorts
  // are scoped to their own institution server-side (see _can_muster
  // + the bulk endpoints) — the frontend doesn't enforce additional limits.
  const canMuster = user.role === "admin" || user.role === "chef"
    || user.category === "coach" || user.is_escort;
  if (!canMuster) return <Navigate to="/" replace />;
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
        <VersionPoller />
        <Suspense fallback={<FullPageSpinner />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<RequireAuth><Layout /></RequireAuth>}>
            <Route index element={<RequireMember><SelfCheckIn /></RequireMember>} />
            <Route path="check-in" element={<RequireMember><SelfCheckIn /></RequireMember>} />
            <Route path="presence" element={<RequireMuster><Presence /></RequireMuster>} />
            <Route path="muster" element={<RequireMuster><Muster /></RequireMuster>} />
            <Route path="meals" element={<RequireChefOrAdmin><Meals /></RequireChefOrAdmin>} />
            <Route path="admin/meals-report" element={<RequireChefOrAdmin><MealsReport /></RequireChefOrAdmin>} />
            <Route path="admin/meals-calendar" element={<RequireChefOrAdmin><MealsCalendar /></RequireChefOrAdmin>} />
            <Route path="my-leaves" element={<RequireMember><MyLeaves /></RequireMember>} />
            <Route path="my-corrections" element={<RequireMember><MyCorrections /></RequireMember>} />
            <Route path="escort-checkin" element={<EscortCheckIn />} />
            <Route path="whats-new" element={<WhatsNew />} />
            <Route path="profile" element={<RequireMember><Profile /></RequireMember>} />
            <Route path="admin" element={<Navigate to="/admin/dashboard" replace />} />
            <Route path="admin/dashboard" element={<RequireAdmin><Dashboard /></RequireAdmin>} />
            <Route path="admin/chefs-view" element={<RequireChefOrAdmin><ChefsView /></RequireChefOrAdmin>} />
            <Route path="admin/categories" element={<RequireAdmin><Categories /></RequireAdmin>} />
            <Route path="admin/category-health" element={<RequireAdmin><CategoryHealth /></RequireAdmin>} />
            <Route path="admin/roles" element={<RequireAdmin><Roles /></RequireAdmin>} />
            <Route path="admin/members" element={<RequireAdmin><Members /></RequireAdmin>} />
            <Route path="admin/approvals" element={<RequireAdmin><Approvals /></RequireAdmin>} />
            {/* Legacy direct links — keep deep-links working but funnel into Approvals.
                Overtime routes redirect to The Grid where OT hours now live as a
                calculated column (approval workflow removed 15 Feb 2026). */}
            <Route path="admin/leaves" element={<Navigate to="/admin/approvals?tab=leaves" replace />} />
            <Route path="admin/overtime" element={<Navigate to="/admin/reports?tab=grid" replace />} />
            <Route path="admin/overtime-page" element={<Navigate to="/admin/reports?tab=grid" replace />} />
            {/* Internal pages still mounted at their old paths for fallback / tests. */}
            <Route path="admin/leaves-page" element={<RequireAdmin><AdminLeaves /></RequireAdmin>} />
            <Route path="admin/devices" element={<RequireAdmin><Devices /></RequireAdmin>} />
            <Route path="admin/office" element={<RequireAdmin><OfficeSettings /></RequireAdmin>} />
            <Route path="admin/sms-log" element={<RequireAdmin><SmsLog /></RequireAdmin>} />
            <Route path="admin/reports" element={<RequireAdmin><Reports /></RequireAdmin>} />
            {/* Payroll merged into Reports as a tab (1 Feb 2026). Keep deep-links alive. */}
            <Route path="admin/payroll" element={<Navigate to="/admin/reports?tab=payroll" replace />} />
            <Route path="admin/sessions" element={<Navigate to="/presence" replace />} />
            <Route path="admin/leave-balances" element={<RequireAdmin><LeaveBalances /></RequireAdmin>} />
            <Route path="admin/group-leave" element={<Navigate to="/admin/leaves" replace />} />
            <Route path="admin/institutions" element={<RequireAdmin><Institutions /></RequireAdmin>} />
            <Route path="admin/fleets" element={<RequireAdmin><Fleets /></RequireAdmin>} />
            <Route path="admin/sites" element={<RequireAdmin><Sites /></RequireAdmin>} />
            <Route path="admin/cards" element={<RequireAdmin><Cards /></RequireAdmin>} />
            <Route path="admin/camps" element={<Navigate to="/admin/calendar" replace />} />
            <Route path="admin/calendar" element={<RequireAdmin><Calendar /></RequireAdmin>} />
            <Route path="admin/backup" element={<RequireAdmin><BackupRestore /></RequireAdmin>} />
            <Route path="admin/import" element={<RequireAdmin><ImportMembers /></RequireAdmin>} />
            <Route path="admin/escort-photos" element={<RequireAdmin><EscortPhotoCleanup /></RequireAdmin>} />
            <Route path="admin/audit-log" element={<RequireAdmin><AuditLog /></RequireAdmin>} />
            <Route path="admin/data-quality" element={<RequireAdmin><DataQuality /></RequireAdmin>} />
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
