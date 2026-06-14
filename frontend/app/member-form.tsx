import React, { useState, useEffect } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useRouter, useLocalSearchParams } from "expo-router";
import { api, ApiError } from "@/src/api/client";
import { useToast } from "@/src/context/ToastContext";
import { colors, spacing, radius, font } from "@/src/theme";
import { Button } from "@/src/components/ui";

const CATS = ["sailor", "staff", "coach"] as const;

export default function MemberForm() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const editing = !!id;

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rank, setRank] = useState("");
  const [mobile, setMobile] = useState("");
  const [workStart, setWorkStart] = useState("");
  const [workEnd, setWorkEnd] = useState("");
  const [category, setCategory] = useState<(typeof CATS)[number]>("sailor");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(editing);

  useEffect(() => {
    if (!editing) return;
    (async () => {
      try {
        const members = await api.get<any[]>("/members");
        const m = members.find((x) => x.id === id);
        if (m) {
          setFullName(m.full_name);
          setEmail(m.email);
          setRank(m.rank || "");
          setMobile(m.mobile || "");
          setWorkStart(m.work_start || "");
          setWorkEnd(m.work_end || "");
          setCategory(m.category);
          setRole(m.role || "member");
        }
      } catch {}
      setFetching(false);
    })();
  }, [editing, id]);

  const timeOk = (s: string) => s === "" || /^\d{1,2}:\d{2}$/.test(s);

  const save = async () => {
    if (!fullName.trim()) return toast.show("Enter full name", "error");
    if (!editing && (!email.trim() || !password)) return toast.show("Email and password required", "error");
    if (!timeOk(workStart) || !timeOk(workEnd)) return toast.show("Timings must be HH:MM or left blank", "error");
    setLoading(true);
    try {
      if (editing) {
        await api.patch(`/members/${id}`, {
          full_name: fullName.trim(),
          rank: rank.trim() || null,
          mobile: mobile.trim() || null,
          work_start: workStart.trim() || null,
          work_end: workEnd.trim() || null,
          category,
          role,
          ...(password ? { password } : {}),
        });
        toast.show("Member updated", "success");
      } else {
        await api.post("/members", {
          full_name: fullName.trim(),
          email: email.trim().toLowerCase(),
          password,
          rank: rank.trim() || null,
          mobile: mobile.trim() || null,
          work_start: workStart.trim() || null,
          work_end: workEnd.trim() || null,
          category,
          role,
        });
        toast.show("Member added", "success");
      }
      router.back();
    } catch (e) {
      toast.show(e instanceof ApiError ? e.message : "Failed to save", "error");
    } finally {
      setLoading(false);
    }
  };

  if (fetching) {
    return (
      <View style={[styles.container, styles.center]}>
        <ActivityIndicator size="large" color={colors.brandPrimary} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} testID="close-member-form">
          <Ionicons name="close" size={26} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>{editing ? "Edit Member" : "Add Member"}</Text>
        <View style={{ width: 26 }} />
      </View>

      <KeyboardAwareScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing["3xl"] }} bottomOffset={24}>
        <Text style={styles.label}>Full Name</Text>
        <TextInput value={fullName} onChangeText={setFullName} placeholder="e.g. Arjun Nair" placeholderTextColor={colors.muted} style={styles.input} testID="member-name-input" />

        <Text style={styles.label}>Email {editing && "(cannot change)"}</Text>
        <TextInput
          value={email}
          onChangeText={setEmail}
          editable={!editing}
          placeholder="name@attendance.app"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          keyboardType="email-address"
          style={[styles.input, editing && styles.inputDisabled]}
          testID="member-email-input"
        />

        <Text style={styles.label}>{editing ? "New Password (optional)" : "Password"}</Text>
        <TextInput value={password} onChangeText={setPassword} placeholder={editing ? "Leave blank to keep" : "Min 4 characters"} placeholderTextColor={colors.muted} secureTextEntry style={styles.input} testID="member-password-input" />

        <Text style={styles.label}>Rank / Title</Text>
        <TextInput value={rank} onChangeText={setRank} placeholder="e.g. Petty Officer" placeholderTextColor={colors.muted} style={styles.input} testID="member-rank-input" />

        <Text style={styles.label}>Mobile Number</Text>
        <TextInput value={mobile} onChangeText={setMobile} placeholder="e.g. 9876543210" placeholderTextColor={colors.muted} keyboardType="phone-pad" style={styles.input} testID="member-mobile-input" />

        <Text style={styles.label}>Custom Timings (optional — blank uses office default)</Text>
        <View style={styles.catRow}>
          <View style={{ flex: 1 }}>
            <TextInput value={workStart} onChangeText={setWorkStart} placeholder="Start HH:MM" placeholderTextColor={colors.muted} style={styles.input} testID="member-work-start-input" />
          </View>
          <View style={{ flex: 1 }}>
            <TextInput value={workEnd} onChangeText={setWorkEnd} placeholder="End HH:MM" placeholderTextColor={colors.muted} style={styles.input} testID="member-work-end-input" />
          </View>
        </View>

        <Text style={styles.label}>Category</Text>
        <View style={styles.catRow}>
          {CATS.map((c) => (
            <Pressable key={c} onPress={() => setCategory(c)} style={[styles.catBtn, category === c && styles.catBtnActive]} testID={`cat-${c}`}>
              <Text style={[styles.catText, category === c && styles.catTextActive]}>
                {c.charAt(0).toUpperCase() + c.slice(1)}
              </Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.label}>Access Level</Text>
        <View style={styles.catRow}>
          {(["member", "admin"] as const).map((r) => (
            <Pressable key={r} onPress={() => setRole(r)} style={[styles.catBtn, role === r && styles.catBtnActive]} testID={`role-${r}`}>
              <Text style={[styles.catText, role === r && styles.catTextActive]}>
                {r === "member" ? "Member" : "Admin"}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.hint}>Admins can open the desktop Console on a laptop browser to manage everything.</Text>

        <View style={{ height: spacing.xl }} />
        <Button title={editing ? "Save Changes" : "Add Member"} onPress={save} loading={loading} icon="checkmark" testID="save-member-button" />
      </KeyboardAwareScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface },
  center: { alignItems: "center", justifyContent: "center" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  headerTitle: { fontSize: font.lg, fontWeight: "800", color: colors.onSurface },
  label: { fontSize: font.sm, fontWeight: "700", color: colors.onSurfaceTertiary, marginBottom: spacing.sm, marginTop: spacing.md },
  hint: { fontSize: font.sm, color: colors.muted, marginTop: spacing.sm },
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
  inputDisabled: { backgroundColor: colors.surfaceTertiary, color: colors.muted },
  catRow: { flexDirection: "row", gap: spacing.sm },
  catBtn: {
    flex: 1,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceTertiary,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  catBtnActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  catText: { fontSize: font.base, fontWeight: "700", color: colors.onSurfaceTertiary },
  catTextActive: { color: "#fff" },
});
