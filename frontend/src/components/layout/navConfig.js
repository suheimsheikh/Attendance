import {
  LayoutDashboard, FileBarChart2, ScanLine, UserCog, CalendarCheck2, ClipboardCheck, CalendarDays, Settings,
  MessageSquare, Database, Sparkles, UserCheck, ShieldAlert, Gauge, ChefHat, PencilRuler, Utensils,
  CalendarRange, FileText, ScrollText, HeartPulse, BookOpen, Activity, Users, GraduationCap, ListTodo,
} from "lucide-react";

/** Map: route path → [reactQueryKey to prefetch, api-path, params].
 * When the admin hovers a sidebar link we start the fetch during the
 * ~300 ms hover-to-click window so the destination page opens
 * instantly. Only routes whose data is expensive-to-compute are
 * listed — cheap pages don't benefit and would just add background
 * network churn. Added 20 Feb 2026 (perf combo item B). */
export const PREFETCH_MAP = {
  "/admin/dashboard":   ["/admin/dashboard", null],
  "/admin/approvals":   ["/leaves", null],
  "/admin/members":     ["/members", null],
};

export const NAV_MEMBER = [
  { to: "/", label: "My Check In/Out", icon: ScanLine, end: true, hint: "Check yourself in or out with a selfie and location" },
  { to: "/my-leaves", label: "Leave/Tour/Late", icon: CalendarCheck2, hint: "Apply for leave, tour or late arrival and track approvals" },
  // Correction requests raised by the member (missed check-ins, wrong
  // times, leave changes). Badge count = personal pending corrections,
  // fetched from `/api/me/corrections?status=pending` in the polling
  // loop below (8 Jul 2026 user request "bring all correction requests
  // by a member under member in the main menu").
  { to: "/my-corrections", label: "My Corrections", icon: PencilRuler, badgeKey: "my_corrections", hint: "Request fixes for missed or wrong check-ins and see their status" },
  // Escort kiosk: visible to every signed-in user. Athletes/coaches/staff
  // help mark escorts in/out — escorts themselves land here after phone
  // login (auth.jsx forces the redirect when `is_escort=true`).
  { to: "/escort-checkin", label: "Escorts Check in/Out", icon: UserCheck, hint: "Mark escorts (parents/guardians) in and out of campus" },
  { to: "/rules", label: "Attendance Rules", icon: ScrollText, hint: "The numbered attendance rules every employee signs up to" },
  { to: "/suggestions", label: "Suggestions", icon: Sparkles, hint: "Share an idea to improve the app — anyone can suggest" },
  { to: "/profile", label: "My Profile", icon: UserCog, hint: "Your photo, contact details and login settings" },
];

// Coach live surfaces (kept for backwards-compat with existing role
// checks; the sections below actually render into the new
// Attendance / Kitchen split — see the sidebar body).
export const NAV_COACH_ATTENDANCE = [
  { to: "/muster", label: "Muster Roll", icon: ClipboardCheck, hint: "Roll-call: check members in/out in bulk with photos" },
  { to: "/presence", label: "Presence", icon: LayoutDashboard, hint: "Who is on campus right now" },
  { to: "/parent-notifications", label: "Parent Notifications", icon: MessageSquare, hint: "Message parents/guardians on WhatsApp about today's absent & late athletes — one tap each, Telugu + English" },
  { to: "/admin/notify-log", label: "Parent Notify Log", icon: MessageSquare, hint: "Proof of contact — every WhatsApp parent notification sent, with who sent it and when" },
];
export const NAV_COACH_KITCHEN = [
  { to: "/meals", label: "Meals Muster", icon: Utensils, hint: "Mark who is eating which meal today" },
  { to: "/admin/meals-calendar", label: "Consumption", icon: CalendarRange, hint: "Daily headcount log — Breakfast / Midmorning / Lunch / Afternoon Snack / Dinner totals per day" },
  { to: "/admin/meals-report", label: "Purchases & Issues", icon: FileBarChart2, hint: "Kitchen inventory: items, purchases, consumption, wastage and stock" },
  { to: "/admin/recipes", label: "Recipes", icon: BookOpen, hint: "Weekly menu recipes: Day → Meal → Dish → ingredients, with macros & AI-filled micronutrients" },
  { to: "/admin/chefs-view", label: "Chef's View", icon: ChefHat, hint: "Today's meal headcounts for the kitchen" },
  { to: "/admin/kitchen-audit", label: "Kitchen Audit Log", icon: ScrollText, hint: "Every change to kitchen data — who changed what and when" },
  { to: "/admin/kitchen-health", label: "Data Health & Fixes", icon: HeartPulse, hint: "Fix stock issues here: correct negative stock, backfill missing per-unit cost rates, see untracked & low stock" },
];

// ATTENDANCE system — pure operations + reporting. Masters, Data Quality
// and all configuration/diagnostics moved out to "Setup & Admin" (Oct 2026
// menu reorg) so this group reads as "the things you do & review day to day".
export const NAV_ATTENDANCE_LIVE = [
  { to: "/muster", label: "Muster Roll", icon: ClipboardCheck, hint: "Roll-call: check members in/out in bulk with photos" },
  { to: "/presence", label: "Presence", icon: LayoutDashboard, hint: "Who is on campus right now" },
  { to: "/parent-notifications", label: "Parent Notifications", icon: MessageSquare, hint: "Message parents/guardians on WhatsApp about today's absent & late athletes — one tap each, Telugu + English" },
  { to: "/admin/dashboard", label: "Dashboard", icon: Gauge, end: true, hint: "Single-glance summary: on campus, on leave, alerts", adminOnly: true },
  { to: "/admin/approvals", label: "Approvals", icon: ClipboardCheck, badgeKey: "approvals_page", hint: "Pending leaves, corrections, check-ins and device access requests in one queue", adminOnly: true },
  { to: "/admin/calendar", label: "Calendar", icon: CalendarDays, hint: "Holidays, weekly offs, camps and regattas at a glance", adminOnly: true },
  { to: "/admin/reports", label: "The Grid", icon: FileBarChart2, hint: "All-in-one 31-day attendance grid with drill-downs and exports", adminOnly: true },
  { to: "/admin/dar", label: "DAR Reports", icon: FileText, hint: "Daily Activity Reports filed at check-out — search, filter, missed-DAR payroll list", adminOnly: true },
  { to: "/admin/leave-balances", label: "Leave Balances", icon: CalendarCheck2, hint: "Paid leave, comp-off and tour balances for every member", adminOnly: true },
];

export const NAV_KITCHEN = [
  { to: "/meals", label: "Meals Muster", icon: Utensils, hint: "Mark who is eating which meal today" },
  { to: "/admin/meals-calendar", label: "Consumption", icon: CalendarRange, hint: "Daily headcount log — Breakfast / Midmorning / Lunch / Afternoon Snack / Dinner totals per day" },
  { to: "/admin/meals-report", label: "Purchases & Issues", icon: FileBarChart2, hint: "Kitchen inventory: items, purchases, consumption, wastage and stock" },
  { to: "/admin/recipes", label: "Recipes", icon: BookOpen, hint: "Weekly menu recipes: Day → Meal → Dish → ingredients, with macros & AI-filled micronutrients" },
  { to: "/admin/chefs-view", label: "Chef's View", icon: ChefHat, hint: "Today's meal headcounts for the kitchen" },
  { to: "/admin/kitchen-audit", label: "Kitchen Audit Log", icon: ScrollText, hint: "Every change to kitchen data — who changed what and when" },
  { to: "/admin/kitchen-health", label: "Data Health & Fixes", icon: HeartPulse, hint: "Fix stock issues here: correct negative stock, backfill missing per-unit cost rates, see untracked & low stock" },
];

// SETUP & ADMIN section — one home for everything configuration, master
// data, diagnostics and safety nets (Oct 2026 reorg). Pulls Masters +
// Data Quality out of Attendance, Education out of its own entry, and the
// three log pages collapse into one tabbed "Logs" screen.
export const NAV_SETUP = [
  { to: "/admin/masters", label: "Masters", icon: Users, hint: "Members, Institutions, Fleets, Categories and Roles — all in one place" },
  { to: "/admin/office", label: "Office Settings", icon: Settings, hint: "Working hours, geofence, training locations and app configuration" },
  { to: "/rules", label: "Attendance Rules", icon: ScrollText, hint: "The numbered attendance rules every employee signs up to" },
  { to: "/admin/education", label: "Education", icon: GraduationCap, hint: "Marksheets for athletes & coaches — scan, upload and track exams" },
  { to: "/admin/data-quality", label: "Data Quality", icon: ShieldAlert, hint: "Automatic checks that flag suspicious or missing data — fix it here" },
  { to: "/admin/logs", label: "Logs", icon: FileText, hint: "SMS, parent-notification and audit history — all in one tabbed view" },
  { to: "/admin/feature-usage", label: "Feature Usage", icon: Activity, superOnly: true, hint: "Which screens are used and when — spot dormant pages to retire" },
  { to: "/admin/backup", label: "Backup & Restore", icon: Database, hint: "Download backups or restore data" },
  { to: "/tasks", label: "Task Manager", icon: ListTodo, badgeKey: "tasks_today", hint: "Team to-dos with deadlines and your daily / weekly / monthly checklist" },
  { to: "/suggestions", label: "Suggestions", icon: Sparkles, hint: "Share an idea to improve the app — anyone can suggest" },
];
