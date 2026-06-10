import React from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { colors, radius, spacing, font, statusConfig } from "@/src/theme";

export function initials(name: string): string {
  return name
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

const AVATAR_COLORS = ["#374151", "#4B5563", "#6B7280", "#1F2937", "#52525B", "#3F3F46"];
function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}

export const Avatar: React.FC<{
  name: string;
  photo?: string | null;
  size?: number;
  ring?: string;
}> = ({ name, photo, size = 52, ring }) => {
  const src = photo
    ? photo.startsWith("data:") || photo.startsWith("http")
      ? photo
      : `data:image/jpeg;base64,${photo}`
    : null;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: ring ? 2.5 : 0,
        borderColor: ring,
      }}
    >
      {src ? (
        <Image
          source={{ uri: src }}
          style={{ width: "100%", height: "100%", borderRadius: size / 2 }}
          contentFit="cover"
          transition={150}
        />
      ) : (
        <View
          style={[
            styles.avatarFallback,
            { borderRadius: size / 2, backgroundColor: colorFor(name) },
          ]}
        >
          <Text style={{ color: "#fff", fontWeight: "700", fontSize: size * 0.36 }}>
            {initials(name)}
          </Text>
        </View>
      )}
    </View>
  );
};

export const StatusBadge: React.FC<{ status: string; compact?: boolean }> = ({
  status,
  compact,
}) => {
  const cfg = statusConfig[status] || statusConfig.exited;
  return (
    <View style={[styles.badge, { backgroundColor: cfg.bg }]} testID={`status-badge-${status}`}>
      <Ionicons name={cfg.icon as never} size={13} color={cfg.color} />
      {!compact && <Text style={[styles.badgeText, { color: cfg.color }]}>{cfg.label}</Text>}
    </View>
  );
};

export const Button: React.FC<{
  title: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  loading?: boolean;
  disabled?: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
  testID?: string;
  fullWidth?: boolean;
}> = ({ title, onPress, variant = "primary", loading, disabled, icon, testID, fullWidth = true }) => {
  const isDisabled = disabled || loading;
  const bg =
    variant === "primary"
      ? colors.brandPrimary
      : variant === "danger"
      ? colors.error
      : variant === "secondary"
      ? colors.surfaceTertiary
      : "transparent";
  const fg =
    variant === "secondary" ? colors.onSurface : variant === "ghost" ? colors.brandPrimary : "#fff";
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.btn,
        { backgroundColor: bg, opacity: isDisabled ? 0.5 : pressed ? 0.85 : 1 },
        fullWidth && { width: "100%" },
        variant === "ghost" && { borderWidth: 1.5, borderColor: colors.border },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <View style={styles.btnInner}>
          {icon && <Ionicons name={icon} size={18} color={fg} />}
          <Text style={[styles.btnText, { color: fg }]}>{title}</Text>
        </View>
      )}
    </Pressable>
  );
};

export const Card: React.FC<{ children: React.ReactNode; style?: object }> = ({
  children,
  style,
}) => <View style={[styles.card, style]}>{children}</View>;

const styles = StyleSheet.create({
  avatarFallback: { width: "100%", height: "100%", alignItems: "center", justifyContent: "center" },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    borderRadius: radius.pill,
  },
  badgeText: { fontSize: font.sm, fontWeight: "700" },
  btn: {
    height: 52,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
  },
  btnInner: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  btnText: { fontSize: font.lg, fontWeight: "700" },
  card: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
});
