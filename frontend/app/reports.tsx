import React, { useState, useCallback } from "react";
import { View, Text, StyleSheet, Pressable, ScrollView, ActivityIndicator } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { api, exportUrl, getAuthHeaderForExport } from "@/src/api/client";
import { useToast } from "@/src/context/ToastContext";
import { colors, spacing, radius, font, categoryLabel } from "@/src/theme";

type HoursRow = {
  member_name: string;
  category: string;
  rank?: string | null;
  total_hours: number;
  days_present: number;
  late_days?: number;
  attendance_pct: number;
};
type Daily = {
  date: string;
  on_leave: { member_name: string; start_date: string; end_date: string; reason: string }[];
  on_tour: { member_name: string; location?: string | null; start_date: string; end_date: string; reason: string }[];
};

function isoDay(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}
function monthStart(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}
function weekStart(): string {
  const d = new Date();
  const diff = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - diff);
  return d.toISOString().slice(0, 10);
}

export default function Reports() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const [mode, setMode] = useState<"hours" | "daily">("hours");

  const [range, setRange] = useState<"week" | "month">("week");
  const [hours, setHours] = useState<HoursRow[]>([]);
  const [daily, setDaily] = useState<Daily | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const period = () =>
    range === "week" ? { start: weekStart(), end: isoDay() } : { start: monthStart(), end: isoDay() };

  const loadHours = useCallback(async () => {
    setLoading(true);
    try {
      const p = period();
      const res = await api.get<{ rows: HoursRow[] }>(`/reports/hours?start=${p.start}&end=${p.end}`);
      setHours(res.rows);
    } catch {
      toast.show("Failed to load report", "error");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  const loadDaily = useCallback(async () => {
    setLoading(true);
    try {
      setDaily(await api.get<Daily>(`/reports/daily?on=${isoDay()}`));
    } catch {
      toast.show("Failed to load report", "error");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    if (mode === "hours") loadHours();
    else loadDaily();
  }, [mode, range, loadHours, loadDaily]);

  const doExport = async (fmt: "csv" | "pdf") => {
    setExporting(true);
    try {
      const p = period();
      const path =
        mode === "hours"
          ? `/reports/hours/export?start=${p.start}&end=${p.end}&fmt=${fmt}`
          : `/reports/daily/export?on=${isoDay()}&fmt=${fmt}`;
      const headers = await getAuthHeaderForExport();
      const filename = `${mode}_report_${isoDay()}.${fmt}`;
      const target = FileSystem.documentDirectory + filename;
      const res = await FileSystem.downloadAsync(exportUrl(path), target, { headers });
      if (res.status !== 200) throw new Error("download failed");
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(res.uri, {
          mimeType: fmt === "pdf" ? "application/pdf" : "text/csv",
          UTI: fmt === "pdf" ? "com.adobe.pdf" : "public.comma-separated-values-text",
        });
      } else {
        toast.show(`Saved ${filename}`, "success");
      }
    } catch {
      toast.show("Export failed", "error");
    } finally {
      setExporting(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={() => router.back()} testID="back-button">
          <Ionicons name="chevron-back" size={26} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.headerTitle}>Reports</Text>
        <View style={{ width: 26 }} />
      </View>

      <View style={styles.modeTabs}>
        {(["hours", "daily"] as const).map((m) => (
          <Pressable key={m} onPress={() => setMode(m)} style={[styles.modeTab, mode === m && styles.modeTabActive]} testID={`mode-${m}`}>
            <Ionicons
              name={m === "hours" ? "time-outline" : "sunny-outline"}
              size={16}
              color={mode === m ? "#fff" : colors.onSurfaceTertiary}
            />
            <Text style={[styles.modeText, mode === m && styles.modeTextActive]}>
              {m === "hours" ? "Hours & Attendance" : "Daily Leave & Tour"}
            </Text>
          </Pressable>
        ))}
      </View>

      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 140 }}>
        {mode === "hours" && (
          <View style={styles.rangeRow}>
            {(["week", "month"] as const).map((r) => (
              <Pressable key={r} onPress={() => setRange(r)} style={[styles.rangeChip, range === r && styles.rangeChipActive]} testID={`range-${r}`}>
                <Text style={[styles.rangeText, range === r && styles.rangeTextActive]}>
                  {r === "week" ? "This Week" : "This Month"}
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        {loading ? (
          <ActivityIndicator size="large" color={colors.brandPrimary} style={{ marginTop: spacing["2xl"] }} />
        ) : mode === "hours" ? (
          <View>
            <View style={[styles.tRow, styles.tHead]}>
              <Text style={[styles.tName, styles.tHeadText]}>Member</Text>
              <Text style={[styles.tCell, styles.tHeadText]}>Hrs</Text>
              <Text style={[styles.tCell, styles.tHeadText]}>Days</Text>
              <Text style={[styles.tCell, styles.tHeadText]}>Late</Text>
              <Text style={[styles.tCell, styles.tHeadText]}>%</Text>
            </View>
            {hours.map((r, i) => (
              <View key={i} style={styles.tRow}>
                <View style={styles.tName}>
                  <Text style={styles.tNameText} numberOfLines={1}>{r.member_name}</Text>
                  <Text style={styles.tCat}>{categoryLabel[r.category] || r.category}</Text>
                </View>
                <Text style={styles.tCell}>{r.total_hours}</Text>
                <Text style={styles.tCell}>{r.days_present}</Text>
                <Text style={[styles.tCell, (r.late_days ?? 0) > 0 && { color: "#9A3412", fontWeight: "700" }]}>{r.late_days ?? 0}</Text>
                <Text style={[styles.tCell, { fontWeight: "700", color: r.attendance_pct >= 60 ? colors.success : colors.muted }]}>
                  {r.attendance_pct}
                </Text>
              </View>
            ))}
          </View>
        ) : (
          <View style={{ gap: spacing.lg }}>
            <ReportGroup
              title="On Tour"
              icon="airplane"
              color={colors.info}
              empty="Nobody on tour today"
              items={(daily?.on_tour || []).map((t) => ({
                name: t.member_name,
                line1: t.location ? `📍 ${t.location}` : "On tour",
                line2: `Till ${t.end_date}`,
              }))}
            />
            <ReportGroup
              title="On Leave"
              icon="bed"
              color={colors.warning}
              empty="Nobody on leave today"
              items={(daily?.on_leave || []).map((l) => ({
                name: l.member_name,
                line1: l.reason,
                line2: `Till ${l.end_date}`,
              }))}
            />
          </View>
        )}
      </ScrollView>

      {/* Export bar */}
      <View style={[styles.exportBar, { paddingBottom: insets.bottom + spacing.md }]}>
        <Pressable style={[styles.exportBtn, styles.exportCsv]} onPress={() => doExport("csv")} disabled={exporting} testID="export-csv-button">
          <Ionicons name="document-outline" size={18} color={colors.onSurface} />
          <Text style={styles.exportCsvText}>Export CSV</Text>
        </Pressable>
        <Pressable style={[styles.exportBtn, styles.exportPdf]} onPress={() => doExport("pdf")} disabled={exporting} testID="export-pdf-button">
          {exporting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Ionicons name="share-outline" size={18} color="#fff" />
              <Text style={styles.exportPdfText}>Export PDF</Text>
            </>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const ReportGroup: React.FC<{
  title: string;
  icon: string;
  color: string;
  empty: string;
  items: { name: string; line1: string; line2: string }[];
}> = ({ title, icon, color, empty, items }) => (
  <View>
    <View style={styles.groupHead}>
      <View style={[styles.groupIcon, { backgroundColor: color + "22" }]}>
        <Ionicons name={icon as never} size={16} color={color} />
      </View>
      <Text style={styles.groupTitle}>{title}</Text>
      <View style={styles.groupCount}>
        <Text style={styles.groupCountText}>{items.length}</Text>
      </View>
    </View>
    {items.length === 0 ? (
      <Text style={styles.groupEmpty}>{empty}</Text>
    ) : (
      items.map((it, i) => (
        <View key={i} style={styles.groupRow}>
          <Text style={styles.groupName}>{it.name}</Text>
          <Text style={styles.groupLine1} numberOfLines={1}>{it.line1}</Text>
          <Text style={styles.groupLine2}>{it.line2}</Text>
        </View>
      ))
    )}
  </View>
);

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
  modeTabs: { flexDirection: "row", gap: spacing.sm, padding: spacing.lg, paddingBottom: 0 },
  modeTab: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceTertiary,
  },
  modeTabActive: { backgroundColor: colors.brandPrimary },
  modeText: { fontSize: font.sm, fontWeight: "700", color: colors.onSurfaceTertiary },
  modeTextActive: { color: "#fff" },
  rangeRow: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.lg },
  rangeChip: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceTertiary,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rangeChipActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  rangeText: { fontSize: font.base, fontWeight: "600", color: colors.onSurfaceTertiary },
  rangeTextActive: { color: "#fff" },
  tRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surfaceSecondary,
  },
  tHead: { backgroundColor: colors.surfaceTertiary, borderTopLeftRadius: radius.md, borderTopRightRadius: radius.md },
  tHeadText: { color: colors.muted, fontWeight: "700", fontSize: font.sm },
  tName: { flex: 1 },
  tNameText: { fontSize: font.base, fontWeight: "600", color: colors.onSurface },
  tCat: { fontSize: font.sm, color: colors.muted },
  tCell: { width: 50, textAlign: "center", fontSize: font.base, color: colors.onSurfaceTertiary },
  groupHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.md },
  groupIcon: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  groupTitle: { fontSize: font.lg, fontWeight: "800", color: colors.onSurface, flex: 1 },
  groupCount: { minWidth: 24, height: 24, paddingHorizontal: 6, borderRadius: 12, backgroundColor: colors.surfaceTertiary, alignItems: "center", justifyContent: "center" },
  groupCountText: { fontSize: 12, fontWeight: "700", color: colors.onSurfaceTertiary },
  groupEmpty: { fontSize: font.base, color: colors.muted, fontStyle: "italic", paddingVertical: spacing.sm },
  groupRow: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  groupName: { fontSize: font.lg, fontWeight: "700", color: colors.onSurface },
  groupLine1: { fontSize: font.base, color: colors.onSurfaceTertiary, marginTop: 2 },
  groupLine2: { fontSize: font.sm, color: colors.muted, marginTop: 2 },
  exportBar: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    gap: spacing.md,
    padding: spacing.lg,
    backgroundColor: colors.surfaceSecondary,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  exportBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: spacing.sm, height: 50, borderRadius: radius.md },
  exportCsv: { backgroundColor: colors.surfaceTertiary, borderWidth: 1, borderColor: colors.borderStrong },
  exportCsvText: { fontSize: font.base, fontWeight: "700", color: colors.onSurface },
  exportPdf: { backgroundColor: colors.brandPrimary },
  exportPdfText: { fontSize: font.base, fontWeight: "700", color: "#fff" },
});
