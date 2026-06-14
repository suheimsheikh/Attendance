import React, { useState } from "react";
import { View, Text, StyleSheet, Pressable, ScrollView, ActivityIndicator } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import * as DocumentPicker from "expo-document-picker";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { exportUrl, getAuthHeaderForExport } from "@/src/api/client";
import { useToast } from "@/src/context/ToastContext";
import { colors, spacing, radius, font } from "@/src/theme";

type ImportResult = {
  created: { full_name: string; email: string; password: string }[];
  errors: { row: number; reason: string }[];
  created_count: number;
  error_count: number;
};

export default function ImportMembers() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const [downloading, setDownloading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const downloadTemplate = async () => {
    setDownloading(true);
    try {
      const headers = await getAuthHeaderForExport();
      const target = FileSystem.documentDirectory + "members_template.xlsx";
      const res = await FileSystem.downloadAsync(exportUrl("/members/import-template"), target, { headers });
      if (res.status !== 200) throw new Error("failed");
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(res.uri, {
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          UTI: "org.openxmlformats.spreadsheetml.sheet",
        });
      } else {
        toast.show("Template saved", "success");
      }
    } catch {
      toast.show("Could not download template", "error");
    } finally {
      setDownloading(false);
    }
  };

  const pickAndImport = async () => {
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: [
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "application/vnd.ms-excel",
          "application/octet-stream",
        ],
        copyToCacheDirectory: true,
      });
      if (picked.canceled || !picked.assets?.length) return;
      setUploading(true);
      setResult(null);
      const headers = await getAuthHeaderForExport();
      const up = await FileSystem.uploadAsync(exportUrl("/members/import"), picked.assets[0].uri, {
        httpMethod: "POST",
        uploadType: FileSystem.FileSystemUploadType.MULTIPART,
        fieldName: "file",
        headers,
      });
      if (up.status !== 200) {
        let msg = "Import failed";
        try { msg = JSON.parse(up.body).detail || msg; } catch {}
        toast.show(msg, "error");
        return;
      }
      const data: ImportResult = JSON.parse(up.body);
      setResult(data);
      toast.show(`Imported ${data.created_count} member${data.created_count === 1 ? "" : "s"}`, "success");
    } catch {
      toast.show("Could not import file", "error");
    } finally {
      setUploading(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={() => router.back()} testID="back-button">
          <Ionicons name="chevron-back" size={26} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>Bulk Import Members</Text>
        <View style={{ width: 26 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing["3xl"] }}>
        <View style={styles.stepCard}>
          <View style={styles.stepBadge}><Text style={styles.stepNum}>1</Text></View>
          <View style={{ flex: 1 }}>
            <Text style={styles.stepTitle}>Download the Excel template</Text>
            <Text style={styles.stepSub}>
              Columns: full_name, mobile, email, password, rank, category, work_start, work_end. Only{" "}
              <Text style={styles.bold}>full_name</Text> and <Text style={styles.bold}>mobile</Text> are required.
            </Text>
            <Pressable style={styles.outlineBtn} onPress={downloadTemplate} disabled={downloading} testID="download-template-button">
              {downloading ? (
                <ActivityIndicator color={colors.brandPrimary} />
              ) : (
                <>
                  <Ionicons name="download-outline" size={18} color={colors.brandPrimary} />
                  <Text style={styles.outlineBtnText}>Download Template</Text>
                </>
              )}
            </Pressable>
          </View>
        </View>

        <View style={styles.stepCard}>
          <View style={styles.stepBadge}><Text style={styles.stepNum}>2</Text></View>
          <View style={{ flex: 1 }}>
            <Text style={styles.stepTitle}>Fill it in, then upload</Text>
            <Text style={styles.stepSub}>
              Blank email → auto-created from mobile. Blank password → the mobile number is used. Blank timings → office
              default applies.
            </Text>
            <Pressable style={styles.primaryBtn} onPress={pickAndImport} disabled={uploading} testID="pick-file-button">
              {uploading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <>
                  <Ionicons name="cloud-upload-outline" size={18} color="#fff" />
                  <Text style={styles.primaryBtnText}>Pick Excel File & Import</Text>
                </>
              )}
            </Pressable>
          </View>
        </View>

        {result && (
          <View style={styles.resultBox}>
            <View style={styles.resultHead}>
              <Ionicons name="checkmark-circle" size={20} color={colors.success} />
              <Text style={styles.resultTitle}>
                {result.created_count} added · {result.error_count} skipped
              </Text>
            </View>

            {result.created.length > 0 && (
              <>
                <Text style={styles.resultLabel}>Created accounts (share these logins):</Text>
                {result.created.map((c, i) => (
                  <View key={i} style={styles.createdRow}>
                    <Text style={styles.createdName}>{c.full_name}</Text>
                    <Text style={styles.createdCreds}>{c.email}  ·  {c.password}</Text>
                  </View>
                ))}
              </>
            )}

            {result.errors.length > 0 && (
              <>
                <Text style={[styles.resultLabel, { color: colors.error }]}>Skipped rows:</Text>
                {result.errors.map((e, i) => (
                  <Text key={i} style={styles.errRow}>Row {e.row}: {e.reason}</Text>
                ))}
              </>
            )}
          </View>
        )}
      </ScrollView>
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
    paddingBottom: spacing.md,
    backgroundColor: colors.surfaceSecondary,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerTitle: { fontSize: font.lg, fontWeight: "800", color: colors.onSurface },
  stepCard: {
    flexDirection: "row",
    gap: spacing.md,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  stepBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
  },
  stepNum: { color: "#fff", fontWeight: "800", fontSize: font.base },
  stepTitle: { fontSize: font.lg, fontWeight: "700", color: colors.onSurface },
  stepSub: { fontSize: font.sm, color: colors.muted, marginTop: spacing.xs, lineHeight: 19 },
  bold: { fontWeight: "800", color: colors.onSurfaceTertiary },
  outlineBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    height: 48,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    marginTop: spacing.md,
  },
  outlineBtnText: { fontSize: font.base, fontWeight: "700", color: colors.brandPrimary },
  primaryBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    height: 48,
    borderRadius: radius.md,
    backgroundColor: colors.brandPrimary,
    marginTop: spacing.md,
  },
  primaryBtnText: { fontSize: font.base, fontWeight: "700", color: "#fff" },
  resultBox: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  resultHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.md },
  resultTitle: { fontSize: font.lg, fontWeight: "800", color: colors.onSurface },
  resultLabel: { fontSize: font.sm, fontWeight: "700", color: colors.onSurfaceTertiary, marginTop: spacing.sm, marginBottom: spacing.xs },
  createdRow: { paddingVertical: spacing.xs, borderBottomWidth: 1, borderBottomColor: colors.divider },
  createdName: { fontSize: font.base, fontWeight: "600", color: colors.onSurface },
  createdCreds: { fontSize: font.sm, color: colors.muted, marginTop: 1 },
  errRow: { fontSize: font.sm, color: colors.error, paddingVertical: 2 },
});
