import React from "react";
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator, ScrollView } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radius, font, statusConfig } from "@/src/theme";

export const cc = {
  bg: "#F4F5F7",
  sidebar: "#111827",
  sidebarActive: "rgba(255,255,255,0.10)",
  sidebarText: "#9CA3AF",
  panel: "#FFFFFF",
  border: "#E5E7EB",
  headBg: "#F9FAFB",
};

export const Panel: React.FC<{ children: React.ReactNode; style?: object }> = ({ children, style }) => (
  <View style={[styles.panel, style]}>{children}</View>
);

export const SectionTitle: React.FC<{ title: string; subtitle?: string; right?: React.ReactNode }> = ({
  title,
  subtitle,
  right,
}) => (
  <View style={styles.sectionHead}>
    <View style={{ flex: 1 }}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {!!subtitle && <Text style={styles.sectionSub}>{subtitle}</Text>}
    </View>
    {right}
  </View>
);

export const StatTile: React.FC<{ label: string; value: number | string; icon: string; color: string }> = ({
  label,
  value,
  icon,
  color,
}) => (
  <View style={styles.statTile}>
    <View style={[styles.statIcon, { backgroundColor: color + "22" }]}>
      <Ionicons name={icon as never} size={22} color={color} />
    </View>
    <View>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  </View>
);

export const Field: React.FC<{ label: string; children: React.ReactNode; style?: object }> = ({ label, children, style }) => (
  <View style={[{ flex: 1 }, style]}>
    <Text style={styles.fieldLabel}>{label}</Text>
    {children}
  </View>
);

export const WInput: React.FC<React.ComponentProps<typeof TextInput>> = (props) => (
  <TextInput placeholderTextColor={colors.muted} {...props} style={[styles.input, props.style]} />
);

export const WButton: React.FC<{
  title: string;
  onPress: () => void;
  icon?: string;
  variant?: "primary" | "ghost" | "danger" | "success";
  loading?: boolean;
  small?: boolean;
  testID?: string;
}> = ({ title, onPress, icon, variant = "primary", loading, small, testID }) => {
  const bg =
    variant === "primary" ? colors.brandPrimary : variant === "danger" ? colors.error : variant === "success" ? colors.success : "transparent";
  const fg = variant === "ghost" ? colors.onSurface : "#fff";
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={loading}
      style={({ pressed }) => [
        styles.btn,
        small && { height: 38, paddingHorizontal: spacing.md },
        { backgroundColor: bg, opacity: loading ? 0.6 : pressed ? 0.85 : 1 },
        variant === "ghost" && { borderWidth: 1, borderColor: cc.border },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} size="small" />
      ) : (
        <View style={styles.btnInner}>
          {icon && <Ionicons name={icon as never} size={16} color={fg} />}
          <Text style={[styles.btnText, { color: fg }, small && { fontSize: font.sm }]}>{title}</Text>
        </View>
      )}
    </Pressable>
  );
};

export const SearchBar: React.FC<{ value: string; onChange: (v: string) => void; placeholder?: string; testID?: string }> = ({
  value,
  onChange,
  placeholder,
  testID,
}) => (
  <View style={styles.search}>
    <Ionicons name="search" size={16} color={colors.muted} />
    <TextInput
      testID={testID}
      value={value}
      onChangeText={onChange}
      placeholder={placeholder || "Search…"}
      placeholderTextColor={colors.muted}
      style={styles.searchInput}
    />
    {!!value && (
      <Pressable onPress={() => onChange("")}>
        <Ionicons name="close-circle" size={16} color={colors.muted} />
      </Pressable>
    )}
  </View>
);

export const Chip: React.FC<{ label: string; active: boolean; onPress: () => void; count?: number; testID?: string }> = ({
  label,
  active,
  onPress,
  count,
  testID,
}) => (
  <Pressable testID={testID} onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
    <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    {count !== undefined && (
      <View style={[styles.chipCount, active && { backgroundColor: "rgba(255,255,255,0.25)" }]}>
        <Text style={[styles.chipCountText, active && { color: "#fff" }]}>{count}</Text>
      </View>
    )}
  </Pressable>
);

export const Pill: React.FC<{ status: string }> = ({ status }) => {
  const cfg = statusConfig[status] || statusConfig.exited;
  return (
    <View style={[styles.pill, { backgroundColor: cfg.bg }]}>
      <Ionicons name={cfg.icon as never} size={12} color={cfg.color} />
      <Text style={[styles.pillText, { color: cfg.color }]}>{cfg.label}</Text>
    </View>
  );
};

export const WModal: React.FC<{ visible: boolean; onClose: () => void; title: string; children: React.ReactNode; width?: number }> = ({
  visible,
  onClose,
  title,
  children,
  width = 520,
}) => {
  if (!visible) return null;
  return (
    <View style={styles.overlay}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      <View style={[styles.modal, { width }]}>
        <View style={styles.modalHead}>
          <Text style={styles.modalTitle}>{title}</Text>
          <Pressable onPress={onClose} testID="modal-close">
            <Ionicons name="close" size={22} color={colors.onSurface} />
          </Pressable>
        </View>
        <ScrollView style={{ maxHeight: 560 }} contentContainerStyle={{ padding: spacing.xl }}>
          {children}
        </ScrollView>
      </View>
    </View>
  );
};

export const Empty: React.FC<{ icon: string; text: string }> = ({ icon, text }) => (
  <View style={styles.empty}>
    <Ionicons name={icon as never} size={40} color={colors.muted} />
    <Text style={styles.emptyText}>{text}</Text>
  </View>
);

export const Loader = () => (
  <View style={styles.empty}>
    <ActivityIndicator size="large" color={colors.brandPrimary} />
  </View>
);

export const tableStyles = StyleSheet.create({
  head: {
    flexDirection: "row",
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    backgroundColor: cc.headBg,
    borderBottomWidth: 1,
    borderBottomColor: cc.border,
  },
  headText: { fontSize: font.sm, fontWeight: "700", color: colors.muted, textTransform: "uppercase" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  cell: { fontSize: font.base, color: colors.onSurface },
});

const styles = StyleSheet.create({
  panel: { backgroundColor: cc.panel, borderRadius: radius.md, borderWidth: 1, borderColor: cc.border, overflow: "hidden" },
  sectionHead: { flexDirection: "row", alignItems: "center", marginBottom: spacing.lg },
  sectionTitle: { fontSize: 26, fontWeight: "800", color: colors.onSurface, letterSpacing: -0.5 },
  sectionSub: { fontSize: font.base, color: colors.muted, marginTop: 2 },
  statTile: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: cc.panel,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: cc.border,
    padding: spacing.lg,
  },
  statIcon: { width: 46, height: 46, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  statValue: { fontSize: 26, fontWeight: "800", color: colors.onSurface },
  statLabel: { fontSize: font.sm, color: colors.muted, marginTop: 1 },
  fieldLabel: { fontSize: font.sm, fontWeight: "700", color: colors.onSurfaceTertiary, marginBottom: spacing.sm, marginTop: spacing.md },
  input: {
    backgroundColor: cc.panel,
    borderWidth: 1,
    borderColor: cc.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    height: 44,
    fontSize: font.base,
    color: colors.onSurface,
    outlineStyle: "none" as never,
  },
  btn: { height: 44, borderRadius: radius.sm, alignItems: "center", justifyContent: "center", paddingHorizontal: spacing.lg },
  btnInner: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  btnText: { fontSize: font.base, fontWeight: "700" },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: cc.panel,
    borderWidth: 1,
    borderColor: cc.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    height: 42,
    minWidth: 260,
  },
  searchInput: { flex: 1, fontSize: font.base, color: colors.onSurface, outlineStyle: "none" as never },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 36,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: cc.panel,
    borderWidth: 1,
    borderColor: cc.border,
  },
  chipActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  chipText: { fontSize: font.sm, fontWeight: "600", color: colors.onSurfaceTertiary },
  chipTextActive: { color: "#fff" },
  chipCount: { minWidth: 18, paddingHorizontal: 5, height: 18, borderRadius: 9, backgroundColor: colors.surfaceTertiary, alignItems: "center", justifyContent: "center" },
  chipCountText: { fontSize: 10, fontWeight: "700", color: colors.muted },
  pill: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: radius.pill, alignSelf: "flex-start" },
  pillText: { fontSize: font.sm, fontWeight: "700" },
  overlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(17,24,39,0.45)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 100,
  },
  modal: { backgroundColor: cc.panel, borderRadius: radius.lg, maxWidth: "92%" },
  modalHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: cc.border,
  },
  modalTitle: { fontSize: font.xl, fontWeight: "800", color: colors.onSurface },
  empty: { alignItems: "center", justifyContent: "center", gap: spacing.md, padding: spacing["3xl"] },
  emptyText: { fontSize: font.base, color: colors.muted },
});
