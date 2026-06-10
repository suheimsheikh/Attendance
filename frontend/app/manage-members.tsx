import React, { useState, useCallback } from "react";
import { View, Text, StyleSheet, FlatList, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { api } from "@/src/api/client";
import { useToast } from "@/src/context/ToastContext";
import { colors, spacing, radius, font, categoryLabel } from "@/src/theme";
import { Avatar } from "@/src/components/ui";

type Member = {
  id: string;
  full_name: string;
  email: string;
  role: string;
  category: string;
  rank?: string | null;
  photo?: string | null;
};

export default function ManageMembers() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const [members, setMembers] = useState<Member[]>([]);

  const load = useCallback(async () => {
    try {
      setMembers(await api.get<Member[]>("/members"));
    } catch {}
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const remove = async (m: Member) => {
    try {
      await api.del(`/members/${m.id}`);
      toast.show(`Removed ${m.full_name}`, "success");
      load();
    } catch {
      toast.show("Couldn't remove member", "error");
    }
  };

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={() => router.back()} testID="back-button">
          <Ionicons name="chevron-back" size={26} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>Members ({members.length})</Text>
        <Pressable onPress={() => router.push("/member-form")} testID="add-member-button">
          <Ionicons name="person-add" size={24} color={colors.brandPrimary} />
        </Pressable>
      </View>

      <FlatList
        data={members}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing["3xl"] }}
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() => router.push({ pathname: "/member-form", params: { id: item.id } })}
            testID={`member-row-${item.id}`}
          >
            <Avatar name={item.full_name} photo={item.photo} size={48} />
            <View style={{ flex: 1 }}>
              <View style={styles.nameRow}>
                <Text style={styles.name}>{item.full_name}</Text>
                {item.role === "admin" && (
                  <View style={styles.adminTag}>
                    <Text style={styles.adminTagText}>ADMIN</Text>
                  </View>
                )}
              </View>
              <Text style={styles.meta}>
                {item.rank ? `${item.rank} · ` : ""}
                {categoryLabel[item.category] || item.category}
              </Text>
              <Text style={styles.email}>{item.email}</Text>
            </View>
            {item.role !== "admin" && (
              <Pressable onPress={() => remove(item)} hitSlop={10} testID={`delete-member-${item.id}`}>
                <Ionicons name="trash-outline" size={20} color={colors.error} />
              </Pressable>
            )}
          </Pressable>
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
  nameRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  name: { fontSize: font.lg, fontWeight: "700", color: colors.onSurface },
  adminTag: { backgroundColor: colors.brandPrimary, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  adminTagText: { color: "#fff", fontSize: 9, fontWeight: "800" },
  meta: { fontSize: font.sm, color: colors.muted, marginTop: 1 },
  email: { fontSize: font.sm, color: colors.brandSecondary, marginTop: 1 },
});
