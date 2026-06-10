import React, { useState, useRef, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Modal,
  ActivityIndicator,
  Switch,
  Linking,
  TextInput,
  Platform,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Location from "expo-location";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useFocusEffect } from "expo-router";
import { api, ApiError } from "@/src/api/client";
import { useToast } from "@/src/context/ToastContext";
import { colors, spacing, radius, font } from "@/src/theme";

type Office = { name: string; latitude: number; longitude: number; radius_m: number; qr_token: string };
type Mode = "self" | "card";
type Step = "scan" | "photo" | "reason" | "submitting";

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dphi = toRad(lat2 - lat1);
  const dlmb = toRad(lon2 - lon1);
  const a =
    Math.sin(dphi / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dlmb / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export default function CheckIn() {
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);

  const [checkedIn, setCheckedIn] = useState<boolean | null>(null);
  const [session, setSession] = useState<{ check_in_at: string } | null>(null);
  const [office, setOffice] = useState<Office | null>(null);
  const [simulate, setSimulate] = useState(true);
  const [mode, setMode] = useState<Mode>("self");

  const [scanning, setScanning] = useState(false);
  const [step, setStep] = useState<Step>("scan");
  const [scannedValue, setScannedValue] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [distance, setDistance] = useState(0);
  const lockRef = useRef(false);
  const pendingRef = useRef<{ photo: string | null; lat: number; lng: number } | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const [st, off] = await Promise.all([
        api.get<{ checked_in: boolean; session: { check_in_at: string } | null }>("/attendance/status"),
        api.get<Office>("/office"),
      ]);
      setCheckedIn(st.checked_in);
      setSession(st.session);
      setOffice(off);
    } catch {
      setCheckedIn(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { loadStatus(); }, [loadStatus]));

  const getCoords = async (): Promise<{ latitude: number; longitude: number } | null> => {
    if (simulate && office) return { latitude: office.latitude, longitude: office.longitude };
    const perm = await Location.getForegroundPermissionsAsync();
    let status = perm.status;
    if (status !== "granted" && perm.canAskAgain) {
      status = (await Location.requestForegroundPermissionsAsync()).status;
    }
    if (status !== "granted") {
      toast.show("Location permission needed to verify campus", "error");
      return null;
    }
    const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    return { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
  };

  const openScanner = async (m: Mode) => {
    setMode(m);
    if (!permission?.granted) {
      const res = await requestPermission();
      if (!res.granted) {
        if (!res.canAskAgain) {
          toast.show("Enable camera in Settings to scan", "error");
          Linking.openSettings();
        }
        return;
      }
    }
    lockRef.current = false;
    setScannedValue(null);
    setReason("");
    pendingRef.current = null;
    setStep("scan");
    setScanning(true);
  };

  const onBarcode = ({ data }: { data: string }) => {
    if (lockRef.current || step !== "scan") return;
    if (mode === "self" && office && data !== office.qr_token) {
      // wrong QR for self check-in
      lockRef.current = true;
      toast.show("That's not the Office Station QR", "error");
      setTimeout(() => (lockRef.current = false), 1500);
      return;
    }
    if (mode === "card" && !data.startsWith("CARD-")) {
      lockRef.current = true;
      toast.show("Scan a member's personal QR card", "error");
      setTimeout(() => (lockRef.current = false), 1500);
      return;
    }
    lockRef.current = true;
    setScannedValue(data);
    setStep("photo");
  };

  const submit = async (photo: string | null, lat: number, lng: number, reasonText: string | null) => {
    if (!scannedValue) return;
    setStep("submitting");
    try {
      const photoData = photo ? `data:image/jpeg;base64,${photo}` : null;
      if (mode === "card") {
        const res = await api.post<{ action: string; member: string; hours?: number; out_of_geofence: boolean }>(
          "/attendance/scan-card",
          { personal_qr: scannedValue, latitude: lat, longitude: lng, photo: photoData, reason: reasonText }
        );
        const msg = res.action === "checkin" ? `${res.member} checked in` : `${res.member} checked out (${res.hours}h)`;
        toast.show(res.out_of_geofence ? `${msg} · off-site` : msg, "success");
      } else {
        const payload = { qr_token: scannedValue, latitude: lat, longitude: lng, photo: photoData, reason: reasonText };
        if (checkedIn) {
          const res = await api.post<{ hours: number }>("/attendance/checkout", payload);
          toast.show(`Checked out — ${res.hours}h on campus`, "success");
        } else {
          await api.post("/attendance/checkin", payload);
          toast.show("Checked in — welcome to campus!", "success");
        }
      }
      setScanning(false);
      await loadStatus();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Something went wrong";
      toast.show(msg, "error");
      setStep("photo");
      lockRef.current = false;
    }
  };

  const captureAndContinue = async () => {
    if (!cameraRef.current || !scannedValue) return;
    setStep("submitting");
    const photo = await cameraRef.current.takePictureAsync({ base64: true, quality: 0.35 });
    const coords = await getCoords();
    if (!coords) {
      setStep("photo");
      return;
    }
    const dist = office ? haversine(coords.latitude, coords.longitude, office.latitude, office.longitude) : 0;
    const outside = office ? dist > office.radius_m : false;
    if (outside) {
      // need a reason before submitting
      pendingRef.current = { photo: photo?.base64 ?? null, lat: coords.latitude, lng: coords.longitude };
      setDistance(Math.round(dist));
      setStep("reason");
      return;
    }
    await submit(photo?.base64 ?? null, coords.latitude, coords.longitude, null);
  };

  const submitWithReason = async () => {
    if (!reason.trim()) {
      toast.show("Please enter a reason", "error");
      return;
    }
    const p = pendingRef.current;
    if (!p) return;
    await submit(p.photo, p.lat, p.lng, reason.trim());
  };

  const selfMode = mode === "self";
  const camFacing = step === "scan" ? "back" : selfMode ? "front" : "back";

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.lg }]}>
        <Text style={styles.title}>Check In / Out</Text>
        <Text style={styles.sub}>Scan the Office QR, or a member&apos;s card</Text>
      </View>

      <View style={styles.body}>
        <View style={[styles.statusCard, checkedIn ? styles.statusIn : styles.statusOut]}>
          <Ionicons
            name={checkedIn ? "checkmark-circle" : "log-out-outline"}
            size={32}
            color={checkedIn ? colors.success : colors.muted}
          />
          <Text style={styles.statusTitle}>
            {checkedIn === null ? "Loading…" : checkedIn ? "You're on campus" : "You're off campus"}
          </Text>
          {checkedIn && session && (
            <Text style={styles.statusSub}>
              Since {new Date(session.check_in_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </Text>
          )}
          {office && <Text style={styles.statusOffice}>{office.name} · within {office.radius_m}m</Text>}
        </View>

        <View style={styles.actions}>
          <Pressable testID="self-checkin-button" onPress={() => openScanner("self")} style={styles.primaryAction}>
            <LinearGradient
              colors={checkedIn ? ["#B45309", "#92400E"] : ["#1F2937", "#111827"]}
              style={styles.primaryActionInner}
            >
              <Ionicons name="qr-code-outline" size={40} color="#fff" />
              <Text style={styles.primaryActionText}>
                {checkedIn ? "Scan to Check Out" : "Scan to Check In"}
              </Text>
              <Text style={styles.primaryActionSub}>My attendance · Office QR</Text>
            </LinearGradient>
          </Pressable>

          <Pressable testID="scan-card-button" onPress={() => openScanner("card")} style={styles.secondaryAction}>
            <View style={styles.secondaryIcon}>
              <Ionicons name="id-card-outline" size={24} color={colors.brandPrimary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.secondaryTitle}>Scan a Member Card</Text>
              <Text style={styles.secondarySub}>For people without a phone — scan their QR card</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.muted} />
          </Pressable>
        </View>

        <View style={styles.simRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.simTitle}>Simulate at office (demo)</Text>
            <Text style={styles.simSub}>Use office GPS so it works in preview</Text>
          </View>
          <Switch
            testID="simulate-switch"
            value={simulate}
            onValueChange={setSimulate}
            trackColor={{ true: colors.brandPrimary, false: colors.borderStrong }}
          />
        </View>
      </View>

      {/* Scanner / Photo / Reason modal */}
      <Modal visible={scanning} animationType="slide" onRequestClose={() => setScanning(false)}>
        <View style={styles.camContainer}>
          <CameraView
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            facing={camFacing}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={step === "scan" ? onBarcode : undefined}
          />
          <LinearGradient
            colors={["rgba(17,24,39,0.7)", "transparent"]}
            style={[styles.camHeader, { paddingTop: insets.top + spacing.sm }]}
          >
            <Text style={styles.camTitle}>
              {step === "scan"
                ? selfMode ? "Scan Office QR" : "Scan Member Card"
                : step === "photo"
                ? "Take the photo"
                : step === "reason"
                ? "Off campus"
                : "Recording…"}
            </Text>
            <Pressable onPress={() => setScanning(false)} testID="close-scanner" style={styles.camClose}>
              <Ionicons name="close" size={26} color="#fff" />
            </Pressable>
          </LinearGradient>

          {step === "scan" && (
            <View style={styles.frameWrap} pointerEvents="none">
              <View style={styles.frame} />
              <Text style={styles.frameHint}>
                {selfMode ? "Point at the Office Station QR" : "Point at the member's QR card"}
              </Text>
            </View>
          )}

          {step === "photo" && (
            <View style={[styles.camBottom, { paddingBottom: insets.bottom + spacing.lg }]}>
              <Text style={styles.camBottomText}>
                {selfMode ? "QR verified. Snap a photo to confirm presence." : "Card scanned. Photograph the person."}
              </Text>
              <Pressable testID="capture-photo-button" onPress={captureAndContinue} style={styles.shutter}>
                <View style={styles.shutterInner} />
              </Pressable>
            </View>
          )}

          {step === "submitting" && (
            <View style={[styles.camBottom, { paddingBottom: insets.bottom + spacing.lg }]}>
              <ActivityIndicator size="large" color="#fff" />
              <Text style={styles.camBottomText}>Submitting…</Text>
            </View>
          )}

          {step === "reason" && (
            <KeyboardAvoidingView
              behavior={Platform.OS === "ios" ? "padding" : "height"}
              style={styles.reasonWrap}
            >
              <View style={[styles.reasonCard, { paddingBottom: insets.bottom + spacing.lg }]}>
                <View style={styles.reasonWarn}>
                  <Ionicons name="warning-outline" size={20} color={colors.warning} />
                  <Text style={styles.reasonWarnText}>You are ~{distance}m from campus (outside {office?.radius_m}m).</Text>
                </View>
                <Text style={styles.reasonLabel}>Reason for off-site attendance</Text>
                <TextInput
                  testID="geofence-reason-input"
                  value={reason}
                  onChangeText={setReason}
                  placeholder="e.g. Open-water training at the bay"
                  placeholderTextColor={colors.muted}
                  style={styles.reasonInput}
                  multiline
                  autoFocus
                />
                <Pressable testID="submit-reason-button" onPress={submitWithReason} style={styles.reasonBtn}>
                  <Ionicons name="checkmark" size={18} color="#fff" />
                  <Text style={styles.reasonBtnText}>Record with reason</Text>
                </Pressable>
              </View>
            </KeyboardAvoidingView>
          )}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface },
  header: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    backgroundColor: colors.surfaceSecondary,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  title: { fontSize: font["2xl"], fontWeight: "800", color: colors.onSurface, letterSpacing: -0.5 },
  sub: { fontSize: font.base, color: colors.muted, marginTop: 2 },
  body: { flex: 1, padding: spacing.lg, gap: spacing.lg },
  statusCard: { alignItems: "center", padding: spacing.lg, borderRadius: radius.lg, borderWidth: 1, gap: spacing.xs },
  statusIn: { backgroundColor: "#ECFDF5", borderColor: "#A7F3D0" },
  statusOut: { backgroundColor: colors.surfaceSecondary, borderColor: colors.border },
  statusTitle: { fontSize: font.xl, fontWeight: "800", color: colors.onSurface, marginTop: spacing.xs },
  statusSub: { fontSize: font.base, color: colors.onSurfaceTertiary },
  statusOffice: { fontSize: font.sm, color: colors.muted, marginTop: spacing.xs },
  actions: { gap: spacing.md },
  primaryAction: { borderRadius: radius.lg, overflow: "hidden" },
  primaryActionInner: { alignItems: "center", paddingVertical: spacing.xl, gap: spacing.sm },
  primaryActionText: { color: "#fff", fontSize: font.xl, fontWeight: "800" },
  primaryActionSub: { color: "rgba(255,255,255,0.7)", fontSize: font.sm },
  secondaryAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  secondaryIcon: {
    width: 46,
    height: 46,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceTertiary,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryTitle: { fontSize: font.lg, fontWeight: "700", color: colors.onSurface },
  secondarySub: { fontSize: font.sm, color: colors.muted, marginTop: 1 },
  simRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.surfaceTertiary,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginTop: "auto",
  },
  simTitle: { fontSize: font.base, fontWeight: "700", color: colors.onSurface },
  simSub: { fontSize: font.sm, color: colors.muted, marginTop: 2 },
  camContainer: { flex: 1, backgroundColor: "#000" },
  camHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
  },
  camTitle: { color: "#fff", fontSize: font.xl, fontWeight: "700" },
  camClose: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  frameWrap: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.lg },
  frame: { width: 240, height: 240, borderRadius: radius.lg, borderWidth: 3, borderColor: "rgba(255,255,255,0.9)" },
  frameHint: { color: "#fff", fontSize: font.base, fontWeight: "600" },
  camBottom: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: "center",
    gap: spacing.lg,
    padding: spacing.xl,
    backgroundColor: "rgba(17,24,39,0.85)",
  },
  camBottomText: { color: "#fff", fontSize: font.base, textAlign: "center", lineHeight: 22 },
  shutter: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 4,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  shutterInner: { width: 58, height: 58, borderRadius: 29, backgroundColor: "#fff" },
  reasonWrap: { position: "absolute", bottom: 0, left: 0, right: 0 },
  reasonCard: {
    backgroundColor: colors.surfaceSecondary,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: spacing.xl,
    gap: spacing.md,
  },
  reasonWarn: { flexDirection: "row", alignItems: "center", gap: spacing.sm, backgroundColor: "#FEF3C7", padding: spacing.md, borderRadius: radius.md },
  reasonWarnText: { flex: 1, fontSize: font.sm, color: "#92400E", fontWeight: "600" },
  reasonLabel: { fontSize: font.sm, fontWeight: "700", color: colors.onSurfaceTertiary },
  reasonInput: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    minHeight: 80,
    fontSize: font.lg,
    color: colors.onSurface,
    textAlignVertical: "top",
  },
  reasonBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    height: 52,
    borderRadius: radius.md,
    backgroundColor: colors.brandPrimary,
  },
  reasonBtnText: { color: "#fff", fontSize: font.lg, fontWeight: "700" },
});
