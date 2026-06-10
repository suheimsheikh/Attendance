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
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Location from "expo-location";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import { api, ApiError } from "@/src/api/client";
import { useToast } from "@/src/context/ToastContext";
import { colors, spacing, radius, font } from "@/src/theme";

type Office = { name: string; latitude: number; longitude: number; radius_m: number; qr_token: string };
type Step = "scan" | "photo" | "submitting";

export default function CheckIn() {
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);

  const [checkedIn, setCheckedIn] = useState<boolean | null>(null);
  const [session, setSession] = useState<{ check_in_at: string } | null>(null);
  const [office, setOffice] = useState<Office | null>(null);
  const [simulate, setSimulate] = useState(true);

  const [scanning, setScanning] = useState(false);
  const [step, setStep] = useState<Step>("scan");
  const [scannedToken, setScannedToken] = useState<string | null>(null);
  const lockRef = useRef(false);

  const mode = checkedIn ? "checkout" : "checkin";

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

  useFocusEffect(
    useCallback(() => {
      loadStatus();
    }, [loadStatus])
  );

  const getCoords = async (): Promise<{ latitude: number; longitude: number } | null> => {
    if (simulate && office) {
      return { latitude: office.latitude, longitude: office.longitude };
    }
    const perm = await Location.getForegroundPermissionsAsync();
    let status = perm.status;
    if (status !== "granted" && perm.canAskAgain) {
      const req = await Location.requestForegroundPermissionsAsync();
      status = req.status;
    }
    if (status !== "granted") {
      toast.show("Location permission needed to verify campus", "error");
      return null;
    }
    const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    return { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
  };

  const openScanner = async () => {
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
    setScannedToken(null);
    setStep("scan");
    setScanning(true);
  };

  const onBarcode = ({ data }: { data: string }) => {
    if (lockRef.current || step !== "scan") return;
    lockRef.current = true;
    setScannedToken(data);
    setStep("photo");
  };

  const captureAndSubmit = async () => {
    if (!cameraRef.current || !scannedToken) return;
    setStep("submitting");
    try {
      const photo = await cameraRef.current.takePictureAsync({ base64: true, quality: 0.35 });
      const coords = await getCoords();
      if (!coords) {
        setStep("photo");
        return;
      }
      const payload = {
        qr_token: scannedToken,
        latitude: coords.latitude,
        longitude: coords.longitude,
        photo: photo?.base64 ? `data:image/jpeg;base64,${photo.base64}` : null,
      };
      if (mode === "checkin") {
        await api.post("/attendance/checkin", payload);
        toast.show("Checked in — welcome to campus!", "success");
      } else {
        const res = await api.post<{ hours: number }>("/attendance/checkout", payload);
        toast.show(`Checked out — ${res.hours}h on campus`, "success");
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

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.lg }]}>
        <Text style={styles.title}>Check In / Out</Text>
        <Text style={styles.sub}>Scan the Office Station QR at the gate</Text>
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

        <View style={styles.scanCircleWrap}>
          <Pressable
            testID="open-scanner-button"
            onPress={openScanner}
            style={({ pressed }) => [styles.scanCircle, pressed && { transform: [{ scale: 0.97 }] }]}
          >
            <LinearGradient
              colors={mode === "checkin" ? ["#1F2937", "#111827"] : ["#B45309", "#92400E"]}
              style={styles.scanCircleInner}
            >
              <Ionicons name="qr-code-outline" size={44} color="#fff" />
              <Text style={styles.scanCircleText}>
                {mode === "checkin" ? "Scan to Check In" : "Scan to Check Out"}
              </Text>
            </LinearGradient>
          </Pressable>
        </View>

        <View style={styles.simRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.simTitle}>Simulate at office (demo)</Text>
            <Text style={styles.simSub}>Use office GPS so check-in works in preview</Text>
          </View>
          <Switch
            testID="simulate-switch"
            value={simulate}
            onValueChange={setSimulate}
            trackColor={{ true: colors.brandPrimary, false: colors.borderStrong }}
          />
        </View>
      </View>

      {/* Scanner / Photo modal */}
      <Modal visible={scanning} animationType="slide" onRequestClose={() => setScanning(false)}>
        <View style={styles.camContainer}>
          <CameraView
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            facing={step === "scan" ? "back" : "front"}
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={step === "scan" ? onBarcode : undefined}
          />
          <LinearGradient
            colors={["rgba(17,24,39,0.6)", "transparent"]}
            style={[styles.camHeader, { paddingTop: insets.top + spacing.sm }]}
          >
            <Text style={styles.camTitle}>
              {step === "scan" ? "Scan Office QR" : step === "photo" ? "Take your photo" : "Recording…"}
            </Text>
            <Pressable onPress={() => setScanning(false)} testID="close-scanner" style={styles.camClose}>
              <Ionicons name="close" size={26} color="#fff" />
            </Pressable>
          </LinearGradient>

          {step === "scan" && (
            <View style={styles.frameWrap} pointerEvents="none">
              <View style={styles.frame} />
              <Text style={styles.frameHint}>Point at the Office Station QR code</Text>
            </View>
          )}

          {(step === "photo" || step === "submitting") && (
            <View style={[styles.camBottom, { paddingBottom: insets.bottom + spacing.lg }]}>
              <Text style={styles.camBottomText}>
                {step === "submitting" ? "Submitting…" : "QR verified. Snap a photo to confirm your presence."}
              </Text>
              {step === "submitting" ? (
                <ActivityIndicator size="large" color="#fff" />
              ) : (
                <Pressable testID="capture-photo-button" onPress={captureAndSubmit} style={styles.shutter}>
                  <View style={styles.shutterInner} />
                </Pressable>
              )}
            </View>
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
  body: { flex: 1, padding: spacing.lg, justifyContent: "space-between" },
  statusCard: {
    alignItems: "center",
    padding: spacing.xl,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.xs,
  },
  statusIn: { backgroundColor: "#ECFDF5", borderColor: "#A7F3D0" },
  statusOut: { backgroundColor: colors.surfaceSecondary, borderColor: colors.border },
  statusTitle: { fontSize: font.xl, fontWeight: "800", color: colors.onSurface, marginTop: spacing.sm },
  statusSub: { fontSize: font.base, color: colors.onSurfaceTertiary },
  statusOffice: { fontSize: font.sm, color: colors.muted, marginTop: spacing.xs },
  scanCircleWrap: { alignItems: "center", justifyContent: "center", flex: 1 },
  scanCircle: { width: 220, height: 220, borderRadius: 110 },
  scanCircleInner: {
    width: "100%",
    height: "100%",
    borderRadius: 110,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  scanCircleText: { color: "#fff", fontSize: font.lg, fontWeight: "700" },
  simRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.surfaceTertiary,
    borderRadius: radius.md,
    padding: spacing.lg,
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
  frame: {
    width: 240,
    height: 240,
    borderRadius: radius.lg,
    borderWidth: 3,
    borderColor: "rgba(255,255,255,0.9)",
  },
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
});
