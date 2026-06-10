import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  RefreshControl,
  ActivityIndicator,
} from "react-native";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { api } from "@/src/api/client";
import { colors, spacing, radius, font, statusConfig, categoryLabel } from "@/src/theme";
import { Avatar, StatusBadge } from "@/src/components/ui";

type PMember = {
  id: string;
  full_name: string;
  role: string;
  category: string;
  rank?: string | null;
  status: string;
  detail: string;
  photo?: string | null;
};
type Presence = {
  members: PMember[];
  counts: Record<string, number>;
  date: string;
};

const FILTERS = [
  { key: "all", label: "All" },
  { key: "on_campus", label: "On Campus" },
  { key: "exited", label: "Exited" },
  { key: "on_tour", label: "On Tour" },
  { key: "on_leave", label: "On Leave" },
];

const EMPTY_IMG =
  "https://images.unsplash.com/photo-1774990044517-cff3f41a6ad9?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NjA1OTN8MHwxfHNlYXJjaHwxfHxlbXB0eSUyMG1hcmluYSUyMGRvY2t8ZW58MHx8fHwxNzgxMDU4MDk0fDA&ixlib=rb-4.1.0&q=85";

export default function Board() {
  const insets = useSafeAreaInsets();
  const [data, setData] = useState<Presence | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState("all");

  const load = useCallback(async () => {
    try {
      setError(false);
      const res = await api.get<Presence>("/presence");
      setData(res);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
      const t = setInterval(load, 15000);
      return () => clearInterval(t);
    }, [load])
  );

  const onRefresh = () => {
    setRefreshing(true);
    load();
  };

  const members = (data?.members || []).filter((m) => filter === "all" || m.status === filter);
  const counts = data?.counts || {};

  const renderHeader = () => (
    <View>
      <View style={styles.statsRow}>
        <StatCard label="On Campus" value={counts.on_campus || 0} color={colors.success} icon="checkmark-circle" />
        <StatCard label="On Tour" value={counts.on_tour || 0} color={colors.info} icon="airplane" />
        <StatCard label="On Leave" value={counts.on_leave || 0} color={colors.warning} icon="bed" />
      </View>
    </View>
  );

  return (
    <View style={styles.container}>
      {/* Sticky header */}
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <View style={styles.headerTop}>
          <View>
            <Text style={styles.headerTitle}>Presence Board</Text>
            <Text style={styles.headerDate}>
              {data ? formatDate(data.date) : "Live campus roster"}
            </Text>
          </View>
          <View style={styles.totalPill}>
            <View style={styles.liveDot} />
            <Text style={styles.totalText}>{counts.total || 0} members</Text>
          </View>
        </View>

        {/* Chip filter row — single horizontal scroller */}
        <FlatList
          data={FILTERS}
          horizontal
          showsHorizontalScrollIndicator={false}
          keyExtractor={(i) => i.key}
          style={styles.chipRow}
          contentContainerStyle={styles.chipContent}
          renderItem={({ item }) => {
            const active = filter === item.key;
            const c = counts[item.key === "all" ? "total" : item.key] ?? 0;
            return (
              <Pressable
                testID={`filter-chip-${item.key}`}
                onPress={() => setFilter(item.key)}
                style={[styles.chip, active && styles.chipActive]}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>
                  {item.label} {item.key !== "all" || filter === "all" ? "" : ""}
                </Text>
                <View style={[styles.chipCount, active && styles.chipCountActive]}>
                  <Text style={[styles.chipCountText, active && styles.chipCountTextActive]}>{c}</Text>
                </View>
              </Pressable>
            );
          }}
        />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.brandPrimary} />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Ionicons name="cloud-offline-outline" size={48} color={colors.muted} />
          <Text style={styles.emptyTitle}>Failed to load presence</Text>
          <Pressable onPress={load} style={styles.retryBtn} testID="retry-presence">
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={members}
          keyExtractor={(m) => m.id}
          ListHeaderComponent={renderHeader}
          contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing["3xl"] }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brandPrimary} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Image source={{ uri: EMPTY_IMG }} style={styles.emptyImg} contentFit="cover" />
              <Text style={styles.emptyTitle}>No one here</Text>
              <Text style={styles.emptySub}>Nobody matches this filter right now.</Text>
            </View>
          }
          renderItem={({ item }) => <MemberRow m={item} />}
        />
      )}
    </View>
  );
}

const StatCard: React.FC<{ label: string; value: number; color: string; icon: string }> = ({
  label,
  value,
  color,
  icon,
}) => (
  <View style={styles.statCard}>
    <View style={[styles.statIcon, { backgroundColor: color + "22" }]}>
      <Ionicons name={icon as never} size={16} color={color} />
    </View>
    <Text style={styles.statValue}>{value}</Text>
    <Text style={styles.statLabel}>{label}</Text>
  </View>
);

const MemberRow: React.FC<{ m: PMember }> = ({ m }) => {
  const cfg = statusConfig[m.status] || statusConfig.exited;
  return (
    <View style={styles.row} testID={`presence-row-${m.id}`}>
      <Avatar name={m.full_name} photo={m.photo} size={52} ring={m.status === "on_campus" ? colors.success : undefined} />
      <View style={styles.rowMid}>
        <Text style={styles.rowName} numberOfLines={1}>
          {m.full_name}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {m.rank ? `${m.rank} · ` : ""}
          {categoryLabel[m.category] || m.category}
        </Text>
        <View style={styles.detailRow}>
          <View style={[styles.dot, { backgroundColor: cfg.color }]} />
          <Text style={styles.rowDetail} numberOfLines={1}>
            {m.detail}
          </Text>
        </View>
      </View>
      <StatusBadge status={m.status} />
    </View>
  );
};

function formatDate(iso: string): string {
  try {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface },
  header: {
    backgroundColor: colors.surfaceSecondary,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTop: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" },
  headerTitle: { fontSize: font["2xl"], fontWeight: "800", color: colors.onSurface, letterSpacing: -0.5 },
  headerDate: { fontSize: font.base, color: colors.muted, marginTop: 2 },
  totalPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.surfaceTertiary,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
  },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.success },
  totalText: { fontSize: font.sm, fontWeight: "700", color: colors.onSurfaceTertiary },
  chipRow: { marginTop: spacing.md, height: 56 },
  chipContent: { gap: spacing.sm, paddingRight: spacing.lg, alignItems: "center" },
  chip: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 36,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceTertiary,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  chipText: { fontSize: font.base, fontWeight: "600", color: colors.onSurfaceTertiary },
  chipTextActive: { color: "#fff" },
  chipCount: {
    minWidth: 20,
    paddingHorizontal: 5,
    height: 20,
    borderRadius: 10,
    backgroundColor: colors.surfaceSecondary,
    alignItems: "center",
    justifyContent: "center",
  },
  chipCountActive: { backgroundColor: "rgba(255,255,255,0.22)" },
  chipCountText: { fontSize: 11, fontWeight: "700", color: colors.muted },
  chipCountTextActive: { color: "#fff" },
  statsRow: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.lg },
  statCard: {
    flex: 1,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  statIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.sm,
  },
  statValue: { fontSize: font.xl, fontWeight: "800", color: colors.onSurface },
  statLabel: { fontSize: font.sm, color: colors.muted, marginTop: 2 },
  row: {
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
  rowMid: { flex: 1 },
  rowName: { fontSize: font.lg, fontWeight: "700", color: colors.onSurface },
  rowMeta: { fontSize: font.sm, color: colors.muted, marginTop: 1 },
  detailRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 4 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  rowDetail: { fontSize: font.sm, color: colors.onSurfaceTertiary, flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md, padding: spacing.xl },
  empty: { alignItems: "center", paddingTop: spacing["3xl"] },
  emptyImg: { width: 160, height: 120, borderRadius: radius.lg, marginBottom: spacing.lg, opacity: 0.85 },
  emptyTitle: { fontSize: font.lg, fontWeight: "700", color: colors.onSurface },
  emptySub: { fontSize: font.base, color: colors.muted, marginTop: 4 },
  retryBtn: {
    backgroundColor: colors.brandPrimary,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  },
  retryText: { color: "#fff", fontWeight: "700" },
});
