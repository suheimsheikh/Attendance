import React, { useState, useCallback } from "react";
import { View, Text, StyleSheet, ScrollView, Pressable, RefreshControl } from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { api } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import { colors, spacing, radius, font, categoryLabel, statusConfig } from "@/src/theme";
import { Avatar } from "@/src/components/ui";

const BANNER =
  "https://images.unsplash.com/photo-1689846136233-de0717f3675c?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NjA2MTJ8MHwxfHNlYXJjaHwxfHx5YWNodCUyMGNsdWIlMjBidWlsZGluZ3xlbnwwfHx8fDE3ODEwNTgwOTl8MA&ixlib=rb-4.1.0&q=85";

export default function ProfileOrAdmin() {
  const { user } = useAuth();
  if (user?.role === "admin") return <AdminDashboard />;
  return <MemberProfile />;
}

/* ----------------------------- MEMBER PROFILE ----------------------------- */
type Stats = {
  week_hours: number;
  month_hours: number;
  days_this_week: number;
  checked_in: boolean;
  pending_leaves: number;
  recent: { id: string; date: string; check_in_at: string; check_out_at: string | null; hours: number | null }[];
};

function MemberProfile() {
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();
  const router = useRouter();
  const [stats, setStats] = useState<Stats | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await api.get<Stats>("/me/stats");
      setStats(s);
    } catch {}
    setRefreshing(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const status = stats?.checked_in ? "on_campus" : "exited";
  const cfg = statusConfig[status];

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingBottom: spacing["3xl"] }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
    >
      <View style={styles.banner}>
        <Image source={{ uri: BANNER }} style={StyleSheet.absoluteFill} contentFit="cover" />
        <LinearGradient
          colors={["rgba(17,24,39,0.2)", "rgba(17,24,39,0.55)", "#F9F9FB"]}
          style={StyleSheet.absoluteFill}
        />
        <Pressable onPress={logout} style={[styles.logoutBtn, { top: insets.top + spacing.sm }]} testID="logout-button">
          <Ionicons name="log-out-outline" size={22} color="#fff" />
        </Pressable>
      </View>

      <View style={styles.profileHead}>
        <Avatar name={user?.full_name || ""} photo={user?.photo} size={88} ring="#fff" />
        <Text style={styles.profileName}>{user?.full_name}</Text>
        <Text style={styles.profileRole}>
          {user?.rank ? `${user.rank} · ` : ""}
          {categoryLabel[user?.category || ""] || user?.category}
        </Text>
        <View style={[styles.statusChip, { backgroundColor: cfg.bg }]}>
          <Ionicons name={cfg.icon as never} size={14} color={cfg.color} />
          <Text style={[styles.statusChipText, { color: cfg.color }]}>{cfg.label}</Text>
        </View>
      </View>

      <View style={styles.metricsRow}>
        <Metric label="Hours this week" value={`${stats?.week_hours ?? 0}h`} icon="time-outline" />
        <Metric label="Days present" value={`${stats?.days_this_week ?? 0}`} icon="calendar-outline" />
        <Metric label="This month" value={`${stats?.month_hours ?? 0}h`} icon="trending-up-outline" />
      </View>

      <View style={styles.section}>
        <Pressable style={styles.actionBtn} onPress={() => router.push("/leave-apply")} testID="apply-leave-button">
          <View style={styles.actionLeft}>
            <View style={[styles.actionIcon, { backgroundColor: "#FEF3C7" }]}>
              <Ionicons name="add" size={20} color={colors.warning} />
            </View>
            <Text style={styles.actionText}>Apply for Leave / Tour</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.muted} />
        </Pressable>
        <Pressable style={styles.actionBtn} onPress={() => router.push("/my-leaves")} testID="my-leaves-button">
          <View style={styles.actionLeft}>
            <View style={[styles.actionIcon, { backgroundColor: "#E0E7FF" }]}>
              <Ionicons name="document-text-outline" size={20} color="#4B5563" />
            </View>
            <Text style={styles.actionText}>My Leave Applications</Text>
          </View>
          <View style={styles.rowEnd}>
            {!!stats?.pending_leaves && (
              <View style={styles.pendBadge}>
                <Text style={styles.pendText}>{stats.pending_leaves}</Text>
              </View>
            )}
            <Ionicons name="chevron-forward" size={20} color={colors.muted} />
          </View>
        </Pressable>
      </View>

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Recent Activity</Text>
      </View>
      <View style={{ paddingHorizontal: spacing.lg }}>
        {!stats?.recent?.length ? (
          <View style={styles.emptyLogs}>
            <Ionicons name="boat-outline" size={36} color={colors.muted} />
            <Text style={styles.emptyLogsText}>No attendance yet. Check in to start logging hours.</Text>
          </View>
        ) : (
          stats.recent.map((r) => (
            <View key={r.id} style={styles.logRow}>
              <View style={styles.logDateBox}>
                <Text style={styles.logDay}>{new Date(r.date + "T00:00:00").getDate()}</Text>
                <Text style={styles.logMonth}>
                  {new Date(r.date + "T00:00:00").toLocaleString(undefined, { month: "short" })}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.logTime}>
                  {new Date(r.check_in_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  {" → "}
                  {r.check_out_at
                    ? new Date(r.check_out_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                    : "—"}
                </Text>
                <Text style={styles.logMeta}>{r.hours != null ? `${r.hours}h on campus` : "In progress"}</Text>
              </View>
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}

const Metric: React.FC<{ label: string; value: string; icon: string }> = ({ label, value, icon }) => (
  <View style={styles.metric}>
    <Ionicons name={icon as never} size={18} color={colors.brandSecondary} />
    <Text style={styles.metricValue}>{value}</Text>
    <Text style={styles.metricLabel}>{label}</Text>
  </View>
);

/* ----------------------------- ADMIN DASHBOARD ----------------------------- */
type Summary = { total_members: number; on_campus: number; pending_leaves: number; on_leave_tour: number };

function AdminDashboard() {
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();
  const router = useRouter();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await api.get<Summary>("/admin/summary");
      setSummary(s);
    } catch {}
    setRefreshing(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const actions = [
    { icon: "people-outline", label: "Manage Members", sub: "Add, edit, remove", route: "/manage-members", color: "#374151" },
    { icon: "checkmark-done-outline", label: "Leave Approvals", sub: "Review requests", route: "/leave-approvals", color: colors.warning, badge: summary?.pending_leaves },
    { icon: "bar-chart-outline", label: "Reports & Export", sub: "Hours, daily, CSV/PDF", route: "/reports", color: colors.info },
    { icon: "qr-code-outline", label: "Office Station QR", sub: "Display / regenerate", route: "/office-qr", color: "#111827" },
  ];

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingBottom: spacing["3xl"] }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
    >
      <View style={[styles.adminHeader, { paddingTop: insets.top + spacing.lg }]}>
        <View style={styles.adminHeaderTop}>
          <View>
            <Text style={styles.adminHi}>Admin Console</Text>
            <Text style={styles.adminName}>{user?.full_name}</Text>
          </View>
          <Pressable onPress={logout} style={styles.adminLogout} testID="logout-button">
            <Ionicons name="log-out-outline" size={22} color={colors.onSurface} />
          </Pressable>
        </View>

        <View style={styles.summaryGrid}>
          <SummaryCard label="On Campus" value={summary?.on_campus ?? 0} color={colors.success} icon="people" />
          <SummaryCard label="Pending Leaves" value={summary?.pending_leaves ?? 0} color={colors.warning} icon="hourglass" />
          <SummaryCard label="Leave / Tour" value={summary?.on_leave_tour ?? 0} color={colors.info} icon="airplane" />
          <SummaryCard label="Total Members" value={summary?.total_members ?? 0} color={colors.brandSecondary} icon="id-card" />
        </View>
      </View>

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Quick Actions</Text>
      </View>
      <View style={{ paddingHorizontal: spacing.lg, gap: spacing.sm }}>
        {actions.map((a) => (
          <Pressable
            key={a.route}
            style={styles.actionBtn}
            onPress={() => router.push(a.route as never)}
            testID={`admin-action-${a.route.replace("/", "")}`}
          >
            <View style={styles.actionLeft}>
              <View style={[styles.actionIcon, { backgroundColor: a.color + "22" }]}>
                <Ionicons name={a.icon as never} size={20} color={a.color} />
              </View>
              <View>
                <Text style={styles.actionText}>{a.label}</Text>
                <Text style={styles.actionSub}>{a.sub}</Text>
              </View>
            </View>
            <View style={styles.rowEnd}>
              {!!a.badge && (
                <View style={styles.pendBadge}>
                  <Text style={styles.pendText}>{a.badge}</Text>
                </View>
              )}
              <Ionicons name="chevron-forward" size={20} color={colors.muted} />
            </View>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

const SummaryCard: React.FC<{ label: string; value: number; color: string; icon: string }> = ({
  label,
  value,
  color,
  icon,
}) => (
  <View style={styles.summaryCard}>
    <View style={[styles.summaryIcon, { backgroundColor: color + "22" }]}>
      <Ionicons name={icon as never} size={18} color={color} />
    </View>
    <View>
      <Text style={styles.summaryValue}>{value}</Text>
      <Text style={styles.summaryLabel}>{label}</Text>
    </View>
  </View>
);

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface },
  banner: { height: 150, backgroundColor: colors.brandPrimary },
  logoutBtn: {
    position: "absolute",
    right: spacing.lg,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.3)",
    alignItems: "center",
    justifyContent: "center",
  },
  profileHead: { alignItems: "center", marginTop: -50, paddingHorizontal: spacing.lg },
  profileName: { fontSize: font["2xl"], fontWeight: "800", color: colors.onSurface, marginTop: spacing.sm },
  profileRole: { fontSize: font.base, color: colors.muted, marginTop: 2 },
  statusChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    marginTop: spacing.md,
  },
  statusChipText: { fontSize: font.sm, fontWeight: "700" },
  metricsRow: { flexDirection: "row", gap: spacing.sm, padding: spacing.lg },
  metric: {
    flex: 1,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: 4,
  },
  metricValue: { fontSize: font.xl, fontWeight: "800", color: colors.onSurface, marginTop: spacing.xs },
  metricLabel: { fontSize: font.sm, color: colors.muted },
  section: { paddingHorizontal: spacing.lg, gap: spacing.sm },
  sectionHeader: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.sm },
  sectionTitle: { fontSize: font.lg, fontWeight: "800", color: colors.onSurface },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  actionLeft: { flexDirection: "row", alignItems: "center", gap: spacing.md, flex: 1 },
  actionIcon: { width: 40, height: 40, borderRadius: radius.sm, alignItems: "center", justifyContent: "center" },
  actionText: { fontSize: font.lg, fontWeight: "700", color: colors.onSurface },
  actionSub: { fontSize: font.sm, color: colors.muted, marginTop: 1 },
  rowEnd: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  pendBadge: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: 6,
    borderRadius: 11,
    backgroundColor: colors.error,
    alignItems: "center",
    justifyContent: "center",
  },
  pendText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  emptyLogs: { alignItems: "center", gap: spacing.sm, padding: spacing.xl },
  emptyLogsText: { fontSize: font.base, color: colors.muted, textAlign: "center" },
  logRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  logDateBox: {
    width: 46,
    height: 46,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceTertiary,
    alignItems: "center",
    justifyContent: "center",
  },
  logDay: { fontSize: font.lg, fontWeight: "800", color: colors.onSurface },
  logMonth: { fontSize: 10, color: colors.muted, textTransform: "uppercase" },
  logTime: { fontSize: font.base, fontWeight: "600", color: colors.onSurface },
  logMeta: { fontSize: font.sm, color: colors.muted, marginTop: 1 },
  adminHeader: {
    backgroundColor: colors.surfaceSecondary,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  adminHeaderTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  adminHi: { fontSize: font.base, color: colors.muted },
  adminName: { fontSize: font["2xl"], fontWeight: "800", color: colors.onSurface, letterSpacing: -0.5 },
  adminLogout: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surfaceTertiary,
    alignItems: "center",
    justifyContent: "center",
  },
  summaryGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.lg },
  summaryCard: {
    width: "48%",
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  summaryIcon: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  summaryValue: { fontSize: font.xl, fontWeight: "800", color: colors.onSurface },
  summaryLabel: { fontSize: font.sm, color: colors.muted },
});
