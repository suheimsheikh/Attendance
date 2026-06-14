import React, { useState, useRef, useEffect } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, ActivityIndicator } from "react-native";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useRouter } from "expo-router";
import { useAuth, User } from "@/src/context/AuthContext";
import { useToast } from "@/src/context/ToastContext";
import { api, ApiError } from "@/src/api/client";
import { getDeviceId, getDeviceInfo } from "@/src/utils/device";
import { colors, spacing, radius, font } from "@/src/theme";
import { Button } from "@/src/components/ui";

const COVER =
  "https://images.unsplash.com/photo-1689846136233-de0717f3675c?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NjA2MTJ8MHwxfHNlYXJjaHwxfHx5YWNodCUyMGNsdWIlMjBidWlsZGluZ3xlbnwwfHx8fDE3ODEwNTgwOTl8MA&ixlib=rb-4.1.0&q=85";

type PhoneResp = { status: string; access_token?: string; user?: User; matched_member?: string | null };

export default function Login() {
  const insets = useSafeAreaInsets();
  const { login, loginWithToken } = useAuth();
  const toast = useToast();
  const router = useRouter();

  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const deviceIdRef = useRef<string>("");

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const enter = async (token: string, user: User) => {
    if (pollRef.current) clearInterval(pollRef.current);
    await loginWithToken(token, user);
    router.replace("/");
  };

  const submitPhone = async () => {
    if (phone.replace(/[^0-9]/g, "").length < 6) {
      toast.show("Enter a valid phone number", "error");
      return;
    }
    setLoading(true);
    try {
      const deviceId = await getDeviceId();
      deviceIdRef.current = deviceId;
      const info = getDeviceInfo();
      const res = await api.post<PhoneResp>("/auth/phone", { phone: phone.trim(), device_id: deviceId, ...info });
      if (res.status === "approved" && res.access_token && res.user) {
        await enter(res.access_token, res.user);
      } else if (res.status === "pending") {
        setPending(true);
        startPolling(deviceId);
      }
    } catch (e) {
      toast.show(e instanceof ApiError ? e.message : "Could not connect", "error");
    } finally {
      setLoading(false);
    }
  };

  const checkStatus = async (deviceId: string) => {
    try {
      const res = await api.get<PhoneResp>(`/auth/phone/status?device_id=${encodeURIComponent(deviceId)}`);
      if (res.status === "approved" && res.access_token && res.user) {
        await enter(res.access_token, res.user);
      } else if (res.status === "revoked") {
        if (pollRef.current) clearInterval(pollRef.current);
        setPending(false);
        toast.show("This device was revoked. Contact your admin.", "error");
      }
    } catch {}
  };

  const startPolling = (deviceId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => checkStatus(deviceId), 4000);
  };

  if (pending) {
    return (
      <View style={styles.container}>
        <Hero insets={insets} />
        <View style={styles.pendingWrap}>
          <View style={styles.pendingIcon}>
            <Ionicons name="hourglass-outline" size={34} color={colors.brandPrimary} />
          </View>
          <Text style={styles.pendingTitle}>Waiting for approval</Text>
          <Text style={styles.pendingSub}>
            Your request has been sent to the admin. As soon as they approve this device, you&apos;ll be signed in
            automatically — no need to log in again.
          </Text>
          <ActivityIndicator color={colors.brandPrimary} style={{ marginVertical: spacing.lg }} />
          <Pressable onPress={() => checkStatus(deviceIdRef.current)} style={styles.checkBtn} testID="check-approval-button">
            <Ionicons name="refresh" size={16} color={colors.brandPrimary} />
            <Text style={styles.checkBtnText}>Check now</Text>
          </Pressable>
          <Pressable onPress={() => { if (pollRef.current) clearInterval(pollRef.current); setPending(false); }} testID="cancel-pending-button">
            <Text style={styles.cancelText}>Use a different number</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Hero insets={insets} />
      <KeyboardAwareScrollView style={styles.sheet} contentContainerStyle={styles.sheetContent} bottomOffset={20} keyboardShouldPersistTaps="handled">
        <Text style={styles.welcome}>Sign in</Text>
        <Text style={styles.muted}>Enter your phone number — your admin approves your device once, then you&apos;re in for good.</Text>

        <View style={styles.field}>
          <Ionicons name="call-outline" size={20} color={colors.muted} />
          <TextInput
            testID="login-phone-input"
            placeholder="Phone number"
            placeholderTextColor={colors.muted}
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            style={styles.input}
            onSubmitEditing={submitPhone}
          />
        </View>

        <View style={{ height: spacing.lg }} />
        <Button title="Continue" onPress={submitPhone} loading={loading} testID="phone-continue-button" icon="arrow-forward" />

        <Pressable onPress={() => setShowAdmin((s) => !s)} style={styles.adminToggle} testID="toggle-admin-login">
          <Ionicons name={showAdmin ? "chevron-up" : "chevron-down"} size={16} color={colors.muted} />
          <Text style={styles.adminToggleText}>Admin sign in with email</Text>
        </Pressable>

        {showAdmin && <AdminEmailLogin onDone={() => router.replace("/")} login={login} />}
      </KeyboardAwareScrollView>
    </View>
  );
}

const Hero: React.FC<{ insets: { top: number } }> = ({ insets }) => (
  <View style={styles.hero}>
    <Image source={{ uri: COVER }} style={StyleSheet.absoluteFill} contentFit="cover" />
    <LinearGradient colors={["rgba(17,24,39,0.45)", "rgba(17,24,39,0.75)", "#111827"]} style={StyleSheet.absoluteFill} />
    <View style={[styles.heroContent, { paddingTop: insets.top + spacing.xl }]}>
      <View style={styles.logoBadge}>
        <Ionicons name="boat" size={26} color="#fff" />
      </View>
      <Text style={styles.heroTitle}>Attendance</Text>
      <Text style={styles.heroSub}>Campus presence & duty tracking</Text>
    </View>
  </View>
);

const AdminEmailLogin: React.FC<{ onDone: () => void; login: (e: string, p: string) => Promise<void> }> = ({ onDone, login }) => {
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const go = async (e: string, p: string) => {
    setLoading(true);
    try {
      await login(e, p);
      onDone();
    } catch (err) {
      toast.show(err instanceof ApiError ? err.message : "Login failed", "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.adminBox}>
      <View style={styles.field}>
        <Ionicons name="mail-outline" size={20} color={colors.muted} />
        <TextInput testID="login-email-input" placeholder="Admin email" placeholderTextColor={colors.muted} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" style={styles.input} />
      </View>
      <View style={styles.field}>
        <Ionicons name="lock-closed-outline" size={20} color={colors.muted} />
        <TextInput testID="login-password-input" placeholder="Password" placeholderTextColor={colors.muted} value={password} onChangeText={setPassword} secureTextEntry style={styles.input} />
      </View>
      <View style={{ height: spacing.sm }} />
      <Button title="Sign In" onPress={() => go(email.trim().toLowerCase(), password)} loading={loading} testID="login-submit-button" icon="log-in-outline" />
      <Pressable testID="quick-login-admin" onPress={() => go("admin@attendance.app", "Admin@12345")} disabled={loading} style={({ pressed }) => [styles.quickBtn, pressed && { opacity: 0.85 }]}>
        <Ionicons name="shield-checkmark" size={16} color="#fff" />
        <Text style={styles.quickBtnText}>Enter as Admin (demo)</Text>
      </Pressable>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface },
  hero: { height: 260, backgroundColor: colors.brandPrimary },
  heroContent: { flex: 1, paddingHorizontal: spacing.xl, justifyContent: "center" },
  logoBadge: { width: 56, height: 56, borderRadius: radius.md, backgroundColor: "rgba(255,255,255,0.18)", alignItems: "center", justifyContent: "center", marginBottom: spacing.md },
  heroTitle: { color: "#fff", fontSize: 34, fontWeight: "800", letterSpacing: -0.5 },
  heroSub: { color: "rgba(255,255,255,0.8)", fontSize: font.lg, marginTop: spacing.xs },
  sheet: { flex: 1, backgroundColor: colors.surface, marginTop: -24, borderTopLeftRadius: 28, borderTopRightRadius: 28 },
  sheetContent: { padding: spacing.xl, paddingTop: spacing["2xl"] },
  welcome: { fontSize: font["2xl"], fontWeight: "800", color: colors.onSurface },
  muted: { fontSize: font.base, color: colors.muted, marginTop: spacing.xs, marginBottom: spacing.xl, lineHeight: 20 },
  field: { flexDirection: "row", alignItems: "center", gap: spacing.sm, backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: spacing.lg, height: 54, marginBottom: spacing.md },
  input: { flex: 1, fontSize: font.lg, color: colors.onSurface },
  adminToggle: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: spacing["2xl"], paddingVertical: spacing.sm },
  adminToggleText: { fontSize: font.sm, fontWeight: "700", color: colors.muted },
  adminBox: { marginTop: spacing.md, backgroundColor: colors.surfaceTertiary, borderRadius: radius.md, padding: spacing.lg },
  quickBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm, height: 46, borderRadius: radius.md, backgroundColor: colors.brandSecondary, marginTop: spacing.md },
  quickBtnText: { fontSize: font.base, fontWeight: "700", color: "#fff" },
  // pending
  pendingWrap: { flex: 1, padding: spacing.xl, alignItems: "center", justifyContent: "center", marginTop: -24, backgroundColor: colors.surface, borderTopLeftRadius: 28, borderTopRightRadius: 28 },
  pendingIcon: { width: 72, height: 72, borderRadius: 36, backgroundColor: colors.surfaceTertiary, alignItems: "center", justifyContent: "center", marginBottom: spacing.lg },
  pendingTitle: { fontSize: font["2xl"], fontWeight: "800", color: colors.onSurface },
  pendingSub: { fontSize: font.base, color: colors.muted, textAlign: "center", marginTop: spacing.sm, lineHeight: 21, paddingHorizontal: spacing.lg },
  checkBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.brandPrimary, marginBottom: spacing.lg },
  checkBtnText: { fontSize: font.base, fontWeight: "700", color: colors.brandPrimary },
  cancelText: { fontSize: font.sm, fontWeight: "600", color: colors.muted, textDecorationLine: "underline" },
});
