import React, { useState, useCallback } from "react";
import { View, Text, StyleSheet, FlatList, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { api } from "@/src/api/client";
import { useToast } from "@/src/context/ToastContext";
import { colors, spacing, radius, font } from "@/src/theme";

type Leave = {
  id: string;
  type: "leave" | "tour";
  start_date: string;
  end_date: string;
  reason: string;
  location?: string | null;
  status: string;
  member_name: string;
  member_rank?: string | null;
};

export default function LeaveApprovals() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const [tab, setTab] = useState<"pending" | "approved" | "rejected">("pending");
  const [leaves, setLeaves] = useState<Leave[]>([]);

  const load = useCallback(async () => {
    try {
      setLeaves(await api.get<Leave[]>(`/leaves?status_filter=${tab}`));
    } catch {}
  }, [tab]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const decide = async (l: Leave, status: "approved" | "rejected") => {
    try {
      await api.patch(`/leaves/${l.id}`, { status });
      toast.show(`${l.member_name}'s ${l.type} ${status}`, "success");
      load();
    } catch {
      toast.show("Action failed", "error");
    }
  };

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={() => router.back()} testID="back-button">
          <Ionicons name="chevron-back" size={26} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>Leave Approvals</Text>
        <View style={{ width: 26 }} />
      </View>

      <View style={styles.tabs}>
        {(["pending", "approved", "rejected"] as const).map((t) => (
          <Pressable key={t} onPress={() => setTab(t)} style={[styles.tab, tab === t && styles.tabActive]} testID={`tab-${t}`}>
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </Text>
          </Pressable>
        ))}
      </View>

      <FlatList
        data={leaves}
        keyExtractor={(l) => l.id}
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing["3xl"] }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="checkmark-done-circle-outline" size={44} color={colors.muted} />
            <Text style={styles.emptyText}>No {tab} applications</Text>
          </View>
        }
        renderItem={({ item }) => (
          <View style={styles.card} testID={`approval-${item.id}`}>
            <View style={styles.cardTop}>
              <View style={styles.typeRow}>
                <Ionicons name={item.type === "leave" ? "bed-outline" : "airplane-outline"} size={18} color={colors.brandSecondary} />
                <Text style={styles.member}>{item.member_name}</Text>
              </View>
              <Text style={styles.typeTag}>{item.type === "leave" ? "Leave" : "Tour"}</Text>
            </View>
            {!!item.member_rank && <Text style={styles.rank}>{item.member_rank}</Text>}
            <Text style={styles.dates}>{item.start_date} → {item.end_date}</Text>
            {!!item.location && <Text style={styles.loc}>📍 {item.location}</Text>}
            <Text style={styles.reason}>{item.reason}</Text>

            {item.status === "pending" && (
              <View style={styles.actions}>
                <Pressable style={[styles.actBtn, styles.reject]} onPress={() => decide(item, "rejected")} testID={`reject-${item.id}`}>
                  <Ionicons name="close" size={18} color={colors.error} />
                  <Text style={[styles.actText, { color: colors.error }]}>Reject</Text>
                </Pressable>
                <Pressable style={[styles.actBtn, styles.approve]} onPress={() => decide(item, "approved")} testID={`approve-${item.id}`}>
                  <Ionicons name="checkmark" size={18} color="#fff" />
                  <Text style={[styles.actText, { color: "#fff" }]}>Approve</Text>
                </Pressable>
              </View>
            )}
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    backgroundColor: colors.surfaceSecondary,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTitle: { fontSize: font.lg, fontWeight: "800", color: colors.onSurface },
  tabs: { flexDirection: "row", gap: spacing.sm, padding: spacing.lg, paddingBottom: 0 },
  tab: { flex: 1, height: 40, borderRadius: radius.md, backgroundColor: colors.surfaceTertiary, alignItems: "center", justifyContent: "center" },
  tabActive: { backgroundColor: colors.brandPrimary },
  tabText: { fontSize: font.base, fontWeight: "700", color: colors.onSurfaceTertiary },
  tabTextActive: { color: "#fff" },
  empty: { alignItems: "center", gap: spacing.sm, paddingTop: spacing["3xl"] },
  emptyText: { fontSize: font.base, color: colors.muted },
  card: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.sm,
  },
  cardTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  typeRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  member: { fontSize: font.lg, fontWeight: "800", color: colors.onSurface },
  typeTag: { fontSize: font.sm, fontWeight: "700", color: colors.muted },
  rank: { fontSize: font.sm, color: colors.muted, marginTop: 2 },
  dates: { fontSize: font.base, fontWeight: "600", color: colors.onSurfaceTertiary, marginTop: spacing.sm },
  loc: { fontSize: font.sm, color: colors.muted, marginTop: 4 },
  reason: { fontSize: font.base, color: colors.muted, marginTop: spacing.sm, lineHeight: 20 },
  actions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.lg },
  actBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, height: 46, borderRadius: radius.md },
  reject: { backgroundColor: "#FEE2E2" },
  approve: { backgroundColor: colors.success },
  actText: { fontSize: font.base, fontWeight: "700" },
});
