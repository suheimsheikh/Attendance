import React, { useState, useCallback } from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { api } from "@/src/api/client";
import { useToast } from "@/src/context/ToastContext";
import { useAuth } from "@/src/context/AuthContext";
import { colors, spacing, radius, font } from "@/src/theme";
import { Button } from "@/src/components/ui";

type Office = { name: string; latitude: number; longitude: number; radius_m: number; qr_token: string };

export default function OfficeQR() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [office, setOffice] = useState<Office | null>(null);
  const [regenerating, setRegenerating] = useState(false);

  const load = useCallback(async () => {
    try {
      setOffice(await api.get<Office>("/office"));
    } catch {}
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const regenerate = async () => {
    setRegenerating(true);
    try {
      const res = await api.post<{ qr_token: string }>("/office/regenerate-qr");
      setOffice((o) => (o ? { ...o, qr_token: res.qr_token } : o));
      toast.show("New QR generated — old one is now invalid", "success");
    } catch {
      toast.show("Failed to regenerate", "error");
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} testID="close-office-qr">
          <Ionicons name="close" size={26} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>Office Station QR</Text>
        <View style={{ width: 26 }} />
      </View>

      <View style={styles.body}>
        {!office ? (
          <ActivityIndicator size="large" color={colors.brandPrimary} />
        ) : (
          <>
            <Text style={styles.instruction}>
              Display or print this QR at the gate. Members scan it to check in / out.
            </Text>
            <View style={styles.qrCard}>
              <QRCode value={office.qr_token} size={220} color="#111827" backgroundColor="#fff" />
              <Text style={styles.token}>{office.qr_token}</Text>
            </View>
            <View style={styles.infoRow}>
              <Ionicons name="location-outline" size={18} color={colors.brandSecondary} />
              <Text style={styles.infoText}>
                {office.name} · {office.latitude.toFixed(4)}, {office.longitude.toFixed(4)} · {office.radius_m}m radius
              </Text>
            </View>

            {isAdmin && (
              <View style={styles.adminActions}>
                <Button
                  title="Regenerate QR Code"
                  onPress={regenerate}
                  loading={regenerating}
                  variant="ghost"
                  icon="refresh-outline"
                  testID="regenerate-qr-button"
                />
                <Text style={styles.warn}>
                  Regenerating invalidates the current code. Re-display the new one at the gate.
                </Text>
              </View>
            )}
          </>
        )}
      </View>
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
    paddingVertical: spacing.md,
  },
  headerTitle: { fontSize: font.lg, fontWeight: "800", color: colors.onSurface },
  body: { flex: 1, alignItems: "center", padding: spacing.xl, gap: spacing.lg },
  instruction: { fontSize: font.base, color: colors.muted, textAlign: "center", lineHeight: 22 },
  qrCard: {
    backgroundColor: "#fff",
    borderRadius: radius.lg,
    padding: spacing.xl,
    alignItems: "center",
    gap: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  token: { fontSize: font.base, fontWeight: "700", color: colors.onSurfaceTertiary, letterSpacing: 1 },
  infoRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.lg },
  infoText: { fontSize: font.sm, color: colors.muted, flex: 1 },
  adminActions: { width: "100%", marginTop: spacing.lg, gap: spacing.sm },
  warn: { fontSize: font.sm, color: colors.muted, textAlign: "center" },
});
