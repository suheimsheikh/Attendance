import React, { useState, useCallback } from "react";
import { View, Text, StyleSheet, FlatList, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { api } from "@/src/api/client";
import { colors, spacing, radius, font } from "@/src/theme";

type Leave = {
  id: string;
  type: "leave" | "tour";
  start_date: string;
  end_date: string;
  reason: string;
  location?: string | null;
  status: "pending" | "approved" | "rejected";
};

const STATUS_CFG: Record<string, { color: string; bg: string; label: string }> = {
  pending: { color: "#B45309", bg: "#FEF3C7", label: "Pending" },
  approved: { color: "#047857", bg: "#D1FAE5", label: "Approved" },
  rejected: { color: "#B91C1C", bg: "#FEE2E2", label: "Rejected" },
};

export default function MyLeaves() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [leaves, setLeaves] = useState<Leave[]>([]);

  const load = useCallback(async () => {
    try {
      setLeaves(await api.get<Leave[]>("/leaves/mine"));
    } catch {}
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={() => router.back()} testID="back-button">
          <Ionicons name="chevron-back" size={26} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>My Applications</Text>
        <Pressable onPress={() => router.push("/leave-apply")} testID="add-leave-button">
          <Ionicons name="add" size={26} color={colors.brandPrimary} />
        </Pressable>
      </View>

      <FlatList
        data={leaves}
        keyExtractor={(l) => l.id}
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing["3xl"] }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="document-text-outline" size={44} color={colors.muted} />
            <Text style={styles.emptyText}>No applications yet</Text>
          </View>
        }
        renderItem={({ item }) => {
          const sc = STATUS_CFG[item.status];
          return (
            <View style={styles.card} testID={`leave-${item.id}`}>
              <View style={styles.cardTop}>
                <View style={styles.typeRow}>
                  <Ionicons
                    name={item.type === "leave" ? "bed-outline" : "airplane-outline"}
                    size={18}
                    color={colors.brandSecondary}
                  />
                  <Text style={styles.cardType}>{item.type === "leave" ? "Leave" : "Tour"}</Text>
                </View>
                <View style={[styles.statusPill, { backgroundColor: sc.bg }]}>
                  <Text style={[styles.statusText, { color: sc.color }]}>{sc.label}</Text>
                </View>
              </View>
              <Text style={styles.dates}>
                {item.start_date} → {item.end_date}
              </Text>
              {!!item.location && <Text style={styles.loc}>📍 {item.location}</Text>}
              <Text style={styles.reason}>{item.reason}</Text>
            </View>
          );
        }}
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
  cardType: { fontSize: font.lg, fontWeight: "700", color: colors.onSurface },
  statusPill: { paddingHorizontal: spacing.md, paddingVertical: 5, borderRadius: radius.pill },
  statusText: { fontSize: font.sm, fontWeight: "700" },
  dates: { fontSize: font.base, fontWeight: "600", color: colors.onSurfaceTertiary, marginTop: spacing.sm },
  loc: { fontSize: font.sm, color: colors.muted, marginTop: 4 },
  reason: { fontSize: font.base, color: colors.muted, marginTop: spacing.sm, lineHeight: 20 },
});
