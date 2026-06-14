import React, { useState, useCallback } from "react";
import { View, Text, StyleSheet, Pressable, ScrollView, RefreshControl, Modal, TextInput } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { api, ApiError } from "@/src/api/client";
import { useToast } from "@/src/context/ToastContext";
import { colors, spacing, radius, font, categoryLabel } from "@/src/theme";
import { Button } from "@/src/components/ui";

const CATS = ["sailor", "staff", "coach"] as const;
const TABS = [
  { k: "pending", label: "Pending" },
  { k: "approved", label: "Approved" },
  { k: "all", label: "All" },
] as const;

const STATUS_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  pending: { bg: "#FEF3C7", fg: "#92400E", label: "Pending" },
  approved: { bg: "#DCFCE7", fg: "#166534", label: "Approved" },
  rejected: { bg: "#F3F4F6", fg: "#6B7280", label: "Rejected" },
  revoked: { bg: "#FEE2E2", fg: "#991B1B", label: "Revoked" },
};

export default function AccessRequests() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const [tab, setTab] = useState<(typeof TABS)[number]["k"]>("pending");
  const [devices, setDevices] = useState<any[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [reviewing, setReviewing] = useState<any | null>(null);

  const load = useCallback(async () => {
    try {
      const q = tab === "all" ? "" : `?status_filter=${tab}`;
      setDevices(await api.get<any[]>(`/admin/devices${q}`));
    } catch {}
    setRefreshing(false);
  }, [tab]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const act = async (d: any, action: string, body?: any) => {
    try {
      await api.post(`/admin/devices/${d.id}/${action}`, body || {});
      toast.show(action === "approve" ? "Approved" : action === "reject" ? "Rejected" : "Revoked", "success");
      load();
    } catch (e) {
      toast.show(e instanceof ApiError ? e.message : "Failed", "error");
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} testID="close-access">
          <Ionicons name="arrow-back" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>Access Requests</Text>
        <View style={{ width: 24 }} />
      </View>

      <View style={styles.tabRow}>
        {TABS.map((t) => (
          <Pressable key={t.k} onPress={() => setTab(t.k)} style={[styles.tab, tab === t.k && styles.tabActive]} testID={`tab-${t.k}`}>
            <Text style={[styles.tabText, tab === t.k && styles.tabTextActive]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>

      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing["3xl"] }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
      >
        {devices.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="phone-portrait-outline" size={40} color={colors.muted} />
            <Text style={styles.emptyText}>No {tab === "all" ? "" : tab} device requests</Text>
          </View>
        ) : (
          devices.map((d) => {
            const sc = STATUS_STYLE[d.status] || STATUS_STYLE.rejected;
            return (
              <View key={d.id} style={styles.card} testID={`device-${d.id}`}>
                <View style={styles.cardTop}>
                  <View style={styles.devIcon}>
                    <Ionicons name="phone-portrait" size={18} color={colors.brandSecondary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.devName}>{d.device_name || d.model || "Unknown device"}</Text>
                    <Text style={styles.devMeta}>{[d.model, d.platform].filter(Boolean).join(" · ") || "—"}</Text>
                  </View>
                  <View style={[styles.pill, { backgroundColor: sc.bg }]}>
                    <Text style={[styles.pillText, { color: sc.fg }]}>{sc.label}</Text>
                  </View>
                </View>
                <View style={styles.cardInfo}>
                  <Ionicons name="call-outline" size={14} color={colors.muted} />
                  <Text style={styles.infoText}>{d.phone || "—"}</Text>
                  {d.member_name ? (
                    <>
                      <Ionicons name="person-outline" size={14} color={colors.muted} style={{ marginLeft: spacing.md }} />
                      <Text style={styles.infoText}>{d.member_name} · {d.member_role === "admin" ? "Admin" : categoryLabel[d.member_category] || "Member"}</Text>
                    </>
                  ) : (
                    <Text style={[styles.infoText, { marginLeft: spacing.md, fontStyle: "italic" }]}>New — not in system</Text>
                  )}
                </View>
                {d.status === "pending" && (
                  <View style={styles.actions}>
                    <Pressable style={styles.rejectBtn} onPress={() => act(d, "reject")} testID={`reject-${d.id}`}>
                      <Text style={styles.rejectText}>Reject</Text>
                    </Pressable>
                    {d.member_name ? (
                      <Pressable style={styles.approveBtn} onPress={() => act(d, "approve", { role: d.member_role || "member", category: d.member_category || "sailor", full_name: d.member_name })} testID={`approve-${d.id}`}>
                        <Ionicons name="checkmark" size={16} color="#fff" />
                        <Text style={styles.approveText}>Approve</Text>
                      </Pressable>
                    ) : (
                      <Pressable style={styles.approveBtn} onPress={() => setReviewing(d)} testID={`review-${d.id}`}>
                        <Ionicons name="person-add" size={16} color="#fff" />
                        <Text style={styles.approveText}>Review</Text>
                      </Pressable>
                    )}
                  </View>
                )}
                {d.status === "approved" && (
                  <View style={styles.actions}>
                    <Pressable style={styles.revokeBtn} onPress={() => act(d, "revoke")} testID={`revoke-${d.id}`}>
                      <Ionicons name="close" size={16} color={colors.error} />
                      <Text style={styles.revokeText}>Revoke access</Text>
                    </Pressable>
                  </View>
                )}
              </View>
            );
          })
        )}
      </ScrollView>

      {reviewing && (
        <ReviewModal
          device={reviewing}
          onClose={() => setReviewing(null)}
          onDone={() => { setReviewing(null); load(); }}
        />
      )}
    </View>
  );
}

const ReviewModal: React.FC<{ device: any; onClose: () => void; onDone: () => void }> = ({ device, onClose, onDone }) => {
  const toast = useToast();
  const [name, setName] = useState("");
  const [rank, setRank] = useState("");
  const [category, setCategory] = useState<(typeof CATS)[number]>("sailor");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!name.trim()) return toast.show("Enter the person's name", "error");
    setSaving(true);
    try {
      await api.post(`/admin/devices/${device.id}/approve`, { full_name: name.trim(), role, category, rank: rank.trim() || null });
      toast.show("Approved & member created", "success");
      onDone();
    } catch (e) {
      toast.show(e instanceof ApiError ? e.message : "Failed", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal transparent animationType="slide" visible onRequestClose={onClose}>
      <View style={styles.modalOverlay}>
        <View style={styles.modalSheet}>
          <Text style={styles.modalTitle}>Approve new device</Text>
          <Text style={styles.devMeta}>{device.device_name || device.model} · {device.phone}</Text>

          <Text style={styles.label}>Full Name</Text>
          <TextInput value={name} onChangeText={setName} placeholder="e.g. Arjun Nair" placeholderTextColor={colors.muted} style={styles.input} testID="review-name" />
          <Text style={styles.label}>Rank / Title</Text>
          <TextInput value={rank} onChangeText={setRank} placeholder="e.g. Coach" placeholderTextColor={colors.muted} style={styles.input} testID="review-rank" />

          <Text style={styles.label}>Category</Text>
          <View style={styles.segRow}>
            {CATS.map((c) => (
              <Pressable key={c} onPress={() => setCategory(c)} style={[styles.seg, category === c && styles.segActive]} testID={`review-cat-${c}`}>
                <Text style={[styles.segText, category === c && styles.segTextActive]}>{categoryLabel[c]}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.label}>Access Level</Text>
          <View style={styles.segRow}>
            {(["member", "admin"] as const).map((r) => (
              <Pressable key={r} onPress={() => setRole(r)} style={[styles.seg, role === r && styles.segActive]} testID={`review-role-${r}`}>
                <Text style={[styles.segText, role === r && styles.segTextActive]}>{r === "member" ? "Member" : "Admin"}</Text>
              </Pressable>
            ))}
          </View>

          <View style={{ height: spacing.lg }} />
          <Button title="Approve & Create" icon="checkmark" loading={saving} onPress={save} testID="confirm-review" />
          <Pressable onPress={onClose} style={{ alignItems: "center", paddingVertical: spacing.md }} testID="cancel-review">
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  headerTitle: { fontSize: font.lg, fontWeight: "800", color: colors.onSurface },
  tabRow: { flexDirection: "row", gap: spacing.sm, paddingHorizontal: spacing.lg, marginBottom: spacing.sm },
  tab: { paddingHorizontal: spacing.lg, height: 36, borderRadius: radius.pill, backgroundColor: colors.surfaceTertiary, alignItems: "center", justifyContent: "center" },
  tabActive: { backgroundColor: colors.brandPrimary },
  tabText: { fontSize: font.sm, fontWeight: "700", color: colors.onSurfaceTertiary },
  tabTextActive: { color: "#fff" },
  empty: { alignItems: "center", gap: spacing.md, paddingVertical: spacing["3xl"] },
  emptyText: { fontSize: font.base, color: colors.muted },
  card: { backgroundColor: colors.surfaceSecondary, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginBottom: spacing.md },
  cardTop: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  devIcon: { width: 40, height: 40, borderRadius: radius.sm, backgroundColor: colors.surfaceTertiary, alignItems: "center", justifyContent: "center" },
  devName: { fontSize: font.base, fontWeight: "700", color: colors.onSurface },
  devMeta: { fontSize: font.sm, color: colors.muted, marginTop: 1 },
  pill: { paddingHorizontal: spacing.sm, paddingVertical: 3, borderRadius: radius.pill },
  pillText: { fontSize: font.sm, fontWeight: "700" },
  cardInfo: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: spacing.md, flexWrap: "wrap" },
  infoText: { fontSize: font.sm, color: colors.onSurfaceTertiary },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm, marginTop: spacing.md },
  rejectBtn: { paddingHorizontal: spacing.lg, height: 40, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  rejectText: { fontSize: font.base, fontWeight: "700", color: colors.onSurfaceTertiary },
  approveBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: spacing.lg, height: 40, borderRadius: radius.sm, backgroundColor: colors.success },
  approveText: { fontSize: font.base, fontWeight: "700", color: "#fff" },
  revokeBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: spacing.lg, height: 40, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.error },
  revokeText: { fontSize: font.base, fontWeight: "700", color: colors.error },
  modalOverlay: { flex: 1, backgroundColor: "rgba(17,24,39,0.45)", justifyContent: "flex-end" },
  modalSheet: { backgroundColor: colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: spacing.xl, paddingBottom: spacing["3xl"] },
  modalTitle: { fontSize: font.xl, fontWeight: "800", color: colors.onSurface },
  label: { fontSize: font.sm, fontWeight: "700", color: colors.onSurfaceTertiary, marginBottom: spacing.sm, marginTop: spacing.lg },
  input: { backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: spacing.lg, height: 50, fontSize: font.base, color: colors.onSurface },
  segRow: { flexDirection: "row", gap: spacing.sm },
  seg: { flex: 1, height: 44, borderRadius: radius.sm, backgroundColor: colors.surfaceTertiary, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  segActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  segText: { fontSize: font.sm, fontWeight: "700", color: colors.onSurfaceTertiary },
  segTextActive: { color: "#fff" },
  cancelText: { fontSize: font.base, fontWeight: "600", color: colors.muted },
});
