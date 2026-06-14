import React, { useState, useCallback } from "react";
import { View, Text, StyleSheet, TextInput, Pressable, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useFocusEffect, useRouter } from "expo-router";
import { api, ApiError } from "@/src/api/client";
import { useToast } from "@/src/context/ToastContext";
import { colors, spacing, radius, font } from "@/src/theme";
import { Button } from "@/src/components/ui";

type Office = {
  name: string;
  latitude: number;
  longitude: number;
  radius_m: number;
  default_work_start: string;
  default_work_end: string;
};

export default function OfficeSettings() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState("");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [radius, setRadius] = useState("100");
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("17:00");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const o = await api.get<Office>("/office");
      setName(o.name);
      setLat(String(o.latitude));
      setLng(String(o.longitude));
      setRadius(String(o.radius_m));
      setStart(o.default_work_start || "09:00");
      setEnd(o.default_work_end || "17:00");
    } catch {}
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const timeOk = (s: string) => /^\d{1,2}:\d{2}$/.test(s);

  const save = async () => {
    const latN = parseFloat(lat);
    const lngN = parseFloat(lng);
    const radN = parseInt(radius, 10);
    if (isNaN(latN) || latN < -90 || latN > 90) return toast.show("Latitude must be between -90 and 90", "error");
    if (isNaN(lngN) || lngN < -180 || lngN > 180) return toast.show("Longitude must be between -180 and 180", "error");
    if (isNaN(radN) || radN < 10 || radN > 100) return toast.show("Radius must be between 10 and 100 m", "error");
    if (!timeOk(start) || !timeOk(end)) return toast.show("Timings must be HH:MM (24-hour)", "error");
    setSaving(true);
    try {
      await api.put("/office", {
        name: name.trim() || "Campus Office",
        latitude: latN,
        longitude: lngN,
        radius_m: radN,
        default_work_start: start,
        default_work_end: end,
      });
      toast.show("Office settings saved", "success");
      router.back();
    } catch (e) {
      toast.show(e instanceof ApiError ? e.message : "Failed to save", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} testID="back-button">
          <Ionicons name="chevron-back" size={26} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>Office Settings</Text>
        <View style={{ width: 26 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={colors.brandPrimary} /></View>
      ) : (
        <KeyboardAwareScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing["3xl"] }} bottomOffset={24}>
          <Text style={styles.sectionTitle}>Geofence</Text>
          <View style={styles.infoCard}>
            <Ionicons name="location-outline" size={18} color={colors.brandSecondary} />
            <Text style={styles.infoText}>
              Set the office GPS coordinates. Members must be within the radius to check in. Tip: open Google Maps,
              long-press the office, and copy the lat, long.
            </Text>
          </View>

          <Text style={styles.label}>Office Name</Text>
          <TextInput value={name} onChangeText={setName} placeholder="e.g. Naval Academy" placeholderTextColor={colors.muted} style={styles.input} testID="office-name-input" />

          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Latitude</Text>
              <TextInput value={lat} onChangeText={setLat} placeholder="15.4909" placeholderTextColor={colors.muted} keyboardType="numbers-and-punctuation" style={styles.input} testID="latitude-input" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Longitude</Text>
              <TextInput value={lng} onChangeText={setLng} placeholder="73.8278" placeholderTextColor={colors.muted} keyboardType="numbers-and-punctuation" style={styles.input} testID="longitude-input" />
            </View>
          </View>

          <Text style={styles.label}>Geofence Radius (metres, max 100)</Text>
          <TextInput value={radius} onChangeText={setRadius} placeholder="100" placeholderTextColor={colors.muted} keyboardType="number-pad" style={styles.input} testID="radius-input" />

          <Text style={[styles.sectionTitle, { marginTop: spacing.xl }]}>Default Working Hours</Text>
          <View style={styles.infoCard}>
            <Ionicons name="time-outline" size={18} color={colors.brandSecondary} />
            <Text style={styles.infoText}>
              These apply to everyone. People with special timings can be given custom hours in their member profile or
              via the import sheet.
            </Text>
          </View>
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Start (HH:MM)</Text>
              <TextInput value={start} onChangeText={setStart} placeholder="09:00" placeholderTextColor={colors.muted} style={styles.input} testID="work-start-input" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>End (HH:MM)</Text>
              <TextInput value={end} onChangeText={setEnd} placeholder="17:00" placeholderTextColor={colors.muted} style={styles.input} testID="work-end-input" />
            </View>
          </View>

          <View style={{ height: spacing.xl }} />
          <Button title="Save Settings" onPress={save} loading={saving} icon="save-outline" testID="save-office-button" />
        </KeyboardAwareScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  headerTitle: { fontSize: font.lg, fontWeight: "800", color: colors.onSurface },
  sectionTitle: { fontSize: font.lg, fontWeight: "800", color: colors.onSurface, marginBottom: spacing.md },
  infoCard: {
    flexDirection: "row",
    gap: spacing.sm,
    backgroundColor: colors.surfaceTertiary,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  infoText: { flex: 1, fontSize: font.sm, color: colors.onSurfaceTertiary, lineHeight: 19 },
  label: { fontSize: font.sm, fontWeight: "700", color: colors.onSurfaceTertiary, marginBottom: spacing.sm, marginTop: spacing.md },
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
  row: { flexDirection: "row", gap: spacing.md },
});
