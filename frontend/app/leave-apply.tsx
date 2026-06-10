import React, { useState } from "react";
import { View, Text, StyleSheet, TextInput, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useRouter } from "expo-router";
import { api, ApiError } from "@/src/api/client";
import { useToast } from "@/src/context/ToastContext";
import { colors, spacing, radius, font } from "@/src/theme";
import { Button } from "@/src/components/ui";

function todayISO(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

export default function LeaveApply() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const [type, setType] = useState<"leave" | "tour">("leave");
  const [start, setStart] = useState(todayISO());
  const [end, setEnd] = useState(todayISO());
  const [location, setLocation] = useState("");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);

  const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));

  const submit = async () => {
    if (!validDate(start) || !validDate(end)) {
      toast.show("Use date format YYYY-MM-DD", "error");
      return;
    }
    if (end < start) {
      toast.show("End date can't be before start", "error");
      return;
    }
    if (type === "tour" && !location.trim()) {
      toast.show("Enter tour location", "error");
      return;
    }
    if (!reason.trim()) {
      toast.show("Enter a reason", "error");
      return;
    }
    setLoading(true);
    try {
      await api.post("/leaves", {
        type,
        start_date: start,
        end_date: end,
        reason: reason.trim(),
        location: type === "tour" ? location.trim() : null,
      });
      toast.show("Application submitted for approval", "success");
      router.back();
    } catch (e) {
      toast.show(e instanceof ApiError ? e.message : "Failed to submit", "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} testID="close-leave-form">
          <Ionicons name="close" size={26} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>Apply Leave / Tour</Text>
        <View style={{ width: 26 }} />
      </View>

      <KeyboardAwareScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing["3xl"] }}
        bottomOffset={24}
      >
        <Text style={styles.label}>Type</Text>
        <View style={styles.segment}>
          {(["leave", "tour"] as const).map((t) => (
            <Pressable
              key={t}
              onPress={() => setType(t)}
              style={[styles.segBtn, type === t && styles.segBtnActive]}
              testID={`type-${t}`}
            >
              <Ionicons
                name={t === "leave" ? "bed-outline" : "airplane-outline"}
                size={18}
                color={type === t ? "#fff" : colors.onSurfaceTertiary}
              />
              <Text style={[styles.segText, type === t && styles.segTextActive]}>
                {t === "leave" ? "Leave" : "Tour / Duty"}
              </Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.quickRow}>
          <QuickDate label="Today" onPress={() => { setStart(todayISO()); setEnd(todayISO()); }} />
          <QuickDate label="Tomorrow" onPress={() => { setStart(todayISO(1)); setEnd(todayISO(1)); }} />
          <QuickDate label="Next 7 days" onPress={() => { setStart(todayISO()); setEnd(todayISO(6)); }} />
        </View>

        <View style={styles.dateRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>From</Text>
            <TextInput value={start} onChangeText={setStart} placeholder="YYYY-MM-DD" placeholderTextColor={colors.muted} style={styles.input} testID="start-date-input" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>Till</Text>
            <TextInput value={end} onChangeText={setEnd} placeholder="YYYY-MM-DD" placeholderTextColor={colors.muted} style={styles.input} testID="end-date-input" />
          </View>
        </View>

        {type === "tour" && (
          <>
            <Text style={styles.label}>Location</Text>
            <TextInput value={location} onChangeText={setLocation} placeholder="e.g. National Regatta, Goa" placeholderTextColor={colors.muted} style={styles.input} testID="location-input" />
          </>
        )}

        <Text style={styles.label}>Reason</Text>
        <TextInput
          value={reason}
          onChangeText={setReason}
          placeholder={type === "leave" ? "Reason for leave" : "Purpose of tour / duty"}
          placeholderTextColor={colors.muted}
          style={[styles.input, styles.textArea]}
          multiline
          testID="reason-input"
        />

        <View style={{ height: spacing.xl }} />
        <Button title="Submit Application" onPress={submit} loading={loading} icon="paper-plane-outline" testID="submit-leave-button" />
      </KeyboardAwareScrollView>
    </View>
  );
}

const QuickDate: React.FC<{ label: string; onPress: () => void }> = ({ label, onPress }) => (
  <Pressable onPress={onPress} style={styles.quickChip}>
    <Text style={styles.quickChipText}>{label}</Text>
  </Pressable>
);

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  headerTitle: { fontSize: font.lg, fontWeight: "800", color: colors.onSurface },
  label: { fontSize: font.sm, fontWeight: "700", color: colors.onSurfaceTertiary, marginBottom: spacing.sm, marginTop: spacing.md },
  segment: { flexDirection: "row", gap: spacing.sm },
  segBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    height: 50,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceTertiary,
    borderWidth: 1,
    borderColor: colors.border,
  },
  segBtnActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  segText: { fontSize: font.base, fontWeight: "700", color: colors.onSurfaceTertiary },
  segTextActive: { color: "#fff" },
  quickRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
  quickChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceTertiary,
    borderWidth: 1,
    borderColor: colors.border,
  },
  quickChipText: { fontSize: font.sm, fontWeight: "600", color: colors.onSurfaceTertiary },
  dateRow: { flexDirection: "row", gap: spacing.md },
  input: {
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    height: 52,
    fontSize: font.lg,
    color: colors.onSurface,
  },
  textArea: { height: 110, paddingTop: spacing.md, textAlignVertical: "top" },
});
