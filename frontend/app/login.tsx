import React, { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Pressable,
} from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useRouter } from "expo-router";
import { useAuth } from "@/src/context/AuthContext";
import { useToast } from "@/src/context/ToastContext";
import { ApiError } from "@/src/api/client";
import { colors, spacing, radius, font } from "@/src/theme";
import { Button } from "@/src/components/ui";

const COVER =
  "https://images.unsplash.com/photo-1689846136233-de0717f3675c?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NjA2MTJ8MHwxfHNlYXJjaHwxfHx5YWNodCUyMGNsdWIlMjBidWlsZGluZ3xlbnwwfHx8fDE3ODEwNTgwOTl8MA&ixlib=rb-4.1.0&q=85";

export default function Login() {
  const insets = useSafeAreaInsets();
  const { login } = useAuth();
  const toast = useToast();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);

  const onSubmit = async () => {
    if (!email.trim() || !password) {
      toast.show("Enter email and password", "error");
      return;
    }
    setLoading(true);
    try {
      await login(email.trim().toLowerCase(), password);
      router.replace("/");
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Login failed. Check connection.";
      toast.show(msg, "error");
    } finally {
      setLoading(false);
    }
  };

  const quickLogin = async (e: string, p: string) => {
    setLoading(true);
    try {
      await login(e, p);
      router.replace("/");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "Login failed. Check connection.";
      toast.show(msg, "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.hero}>
        <Image source={{ uri: COVER }} style={StyleSheet.absoluteFill} contentFit="cover" />
        <LinearGradient
          colors={["rgba(17,24,39,0.45)", "rgba(17,24,39,0.75)", "#111827"]}
          style={StyleSheet.absoluteFill}
        />
        <View style={[styles.heroContent, { paddingTop: insets.top + spacing.xl }]}>
          <View style={styles.logoBadge}>
            <Ionicons name="boat" size={26} color="#fff" />
          </View>
          <Text style={styles.heroTitle}>Attendance</Text>
          <Text style={styles.heroSub}>Campus presence & duty tracking</Text>
        </View>
      </View>

      <KeyboardAwareScrollView
        style={styles.sheet}
        contentContainerStyle={styles.sheetContent}
        bottomOffset={20}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.welcome}>Welcome back</Text>
        <Text style={styles.muted}>Sign in to mark attendance and view the board.</Text>

        <View style={styles.field}>
          <Ionicons name="mail-outline" size={20} color={colors.muted} />
          <TextInput
            testID="login-email-input"
            placeholder="Email"
            placeholderTextColor={colors.muted}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            style={styles.input}
          />
        </View>

        <View style={styles.field}>
          <Ionicons name="lock-closed-outline" size={20} color={colors.muted} />
          <TextInput
            testID="login-password-input"
            placeholder="Password"
            placeholderTextColor={colors.muted}
            value={password}
            onChangeText={setPassword}
            secureTextEntry={!show}
            style={styles.input}
            onSubmitEditing={onSubmit}
          />
          <Pressable onPress={() => setShow((s) => !s)} testID="toggle-password">
            <Ionicons name={show ? "eye-off-outline" : "eye-outline"} size={20} color={colors.muted} />
          </Pressable>
        </View>

        <View style={{ height: spacing.lg }} />
        <Button title="Sign In" onPress={onSubmit} loading={loading} testID="login-submit-button" icon="log-in-outline" />

        <View style={styles.hintBox}>
          <Text style={styles.hintTitle}>Quick test login — one tap, no typing</Text>
          <Pressable
            testID="quick-login-admin"
            onPress={() => quickLogin("admin@attendance.app", "Admin@12345")}
            disabled={loading}
            style={({ pressed }) => [styles.quickBtn, styles.quickAdmin, pressed && { opacity: 0.85 }]}
          >
            <Ionicons name="shield-checkmark" size={18} color="#fff" />
            <Text style={styles.quickBtnText}>Enter as Admin</Text>
          </Pressable>
          <Text style={styles.hintNote}>
            Members log in with the email & password you set (or import). Admins can preview the member view from
            the Admin console.
          </Text>
        </View>
      </KeyboardAwareScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface },
  hero: { height: 280, backgroundColor: colors.brandPrimary },
  heroContent: { flex: 1, paddingHorizontal: spacing.xl, justifyContent: "center" },
  logoBadge: {
    width: 56,
    height: 56,
    borderRadius: radius.md,
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.md,
  },
  heroTitle: { color: "#fff", fontSize: 34, fontWeight: "800", letterSpacing: -0.5 },
  heroSub: { color: "rgba(255,255,255,0.8)", fontSize: font.lg, marginTop: spacing.xs },
  sheet: {
    flex: 1,
    backgroundColor: colors.surface,
    marginTop: -24,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
  },
  sheetContent: { padding: spacing.xl, paddingTop: spacing["2xl"] },
  welcome: { fontSize: font["2xl"], fontWeight: "800", color: colors.onSurface },
  muted: { fontSize: font.base, color: colors.muted, marginTop: spacing.xs, marginBottom: spacing.xl },
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    height: 54,
    marginBottom: spacing.md,
  },
  input: { flex: 1, fontSize: font.lg, color: colors.onSurface },
  hintBox: {
    marginTop: spacing["2xl"],
    backgroundColor: colors.surfaceTertiary,
    borderRadius: radius.md,
    padding: spacing.lg,
  },
  hintTitle: { fontSize: font.sm, fontWeight: "700", color: colors.onSurfaceTertiary, marginBottom: spacing.md },
  hintText: { fontSize: font.sm, color: colors.muted, lineHeight: 20 },
  hintNote: { fontSize: font.sm, color: colors.muted, lineHeight: 19, marginTop: spacing.md },
  quickBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    height: 48,
    borderRadius: radius.md,
  },
  quickAdmin: { backgroundColor: colors.brandPrimary },
  quickBtnText: { fontSize: font.base, fontWeight: "700", color: "#fff" },
});
