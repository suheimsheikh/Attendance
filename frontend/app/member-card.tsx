import React, { useState, useCallback } from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter, useLocalSearchParams } from "expo-router";
import { api } from "@/src/api/client";
import { colors, spacing, radius, font, categoryLabel } from "@/src/theme";
import { Avatar } from "@/src/components/ui";

type Card = {
  id: string;
  full_name: string;
  rank?: string | null;
  category: string;
  personal_qr: string;
  photo?: string | null;
};

export default function MemberCardScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [card, setCard] = useState<Card | null>(null);

  const load = useCallback(async () => {
    try {
      setCard(await api.get<Card>(`/members/${id}/card`));
    } catch {}
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} testID="back-button">
          <Ionicons name="chevron-back" size={26} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>Member QR Card</Text>
        <View style={{ width: 26 }} />
      </View>

      <View style={styles.body}>
        {!card ? (
          <ActivityIndicator size="large" color={colors.brandPrimary} />
        ) : (
          <>
            <Text style={styles.instruction}>
              Print this card and hand it to the member. Anyone with the app can scan it at the gate to
              check them in or out.
            </Text>
            <View style={styles.card}>
              <View style={styles.cardHead}>
                <Avatar name={card.full_name} photo={card.photo} size={48} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.name}>{card.full_name}</Text>
                  <Text style={styles.meta}>
                    {card.rank ? `${card.rank} · ` : ""}
                    {categoryLabel[card.category] || card.category}
                  </Text>
                </View>
                <Ionicons name="boat" size={22} color={colors.brandSecondary} />
              </View>
              <View style={styles.qrBox}>
                <QRCode value={card.personal_qr} size={200} color="#111827" backgroundColor="#fff" />
              </View>
              <Text style={styles.token}>{card.personal_qr}</Text>
            </View>
            <View style={styles.note}>
              <Ionicons name="information-circle-outline" size={16} color={colors.muted} />
              <Text style={styles.noteText}>This QR is unique to the member and stays valid permanently.</Text>
            </View>
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
  card: {
    width: "100%",
    backgroundColor: "#fff",
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xl,
    alignItems: "center",
    gap: spacing.lg,
  },
  cardHead: { flexDirection: "row", alignItems: "center", gap: spacing.md, width: "100%" },
  name: { fontSize: font.lg, fontWeight: "800", color: colors.onSurface },
  meta: { fontSize: font.sm, color: colors.muted, marginTop: 1 },
  qrBox: { padding: spacing.sm, backgroundColor: "#fff" },
  token: { fontSize: font.base, fontWeight: "700", color: colors.onSurfaceTertiary, letterSpacing: 1 },
  note: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.lg },
  noteText: { fontSize: font.sm, color: colors.muted, flex: 1 },
});
