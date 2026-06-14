import React, { useState, useEffect } from "react";
import { View, Text, StyleSheet, Pressable, ScrollView, useWindowDimensions } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useAuth } from "@/src/context/AuthContext";
import { colors, spacing, radius, font } from "@/src/theme";
import { Avatar } from "@/src/components/ui";
import { cc } from "@/src/console/ConsoleUI";
import {
  Dashboard,
  PresenceBoard,
  MembersSection,
  ApprovalsSection,
  ReportsSection,
  OfficeSettingsSection,
  OfficeQRSection,
  ImportSection,
} from "@/src/console/sections";

export const DESKTOP_MIN_WIDTH = 1000;

const NAV = [
  { k: "dashboard", label: "Dashboard", icon: "grid-outline" },
  { k: "presence", label: "Presence Board", icon: "people-outline" },
  { k: "members", label: "Members", icon: "id-card-outline" },
  { k: "approvals", label: "Approvals", icon: "checkmark-done-outline" },
  { k: "reports", label: "Reports", icon: "bar-chart-outline" },
  { k: "settings", label: "Office Settings", icon: "settings-outline" },
  { k: "qr", label: "Office QR", icon: "qr-code-outline" },
  { k: "import", label: "Bulk Import", icon: "cloud-upload-outline" },
];

export default function Console() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [section, setSection] = useState("dashboard");

  // Redirect to mobile app if not eligible (member, or narrow screen)
  useEffect(() => {
    if (!user) {
      router.replace("/login");
    } else if (user.role !== "admin" || width < DESKTOP_MIN_WIDTH) {
      router.replace("/(tabs)");
    }
  }, [user, width, router]);

  if (!user || user.role !== "admin" || width < DESKTOP_MIN_WIDTH) return null;

  const renderSection = () => {
    switch (section) {
      case "presence": return <PresenceBoard />;
      case "members": return <MembersSection />;
      case "approvals": return <ApprovalsSection />;
      case "reports": return <ReportsSection />;
      case "settings": return <OfficeSettingsSection />;
      case "qr": return <OfficeQRSection />;
      case "import": return <ImportSection />;
      default: return <Dashboard go={setSection} />;
    }
  };

  return (
    <View style={styles.shell}>
      {/* Sidebar */}
      <View style={styles.sidebar}>
        <View style={styles.brand}>
          <View style={styles.logo}><Ionicons name="boat" size={22} color="#fff" /></View>
          <View>
            <Text style={styles.brandTitle}>Attendance</Text>
            <Text style={styles.brandSub}>Admin Console</Text>
          </View>
        </View>

        <View style={styles.nav}>
          {NAV.map((n) => {
            const active = section === n.k;
            return (
              <Pressable
                key={n.k}
                onPress={() => setSection(n.k)}
                style={[styles.navItem, active && styles.navItemActive]}
                testID={`nav-${n.k}`}
              >
                <Ionicons name={n.icon as never} size={18} color={active ? "#fff" : cc.sidebarText} />
                <Text style={[styles.navText, active && styles.navTextActive]}>{n.label}</Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.userBox}>
          <Avatar name={user.full_name} photo={user.photo} size={36} />
          <View style={{ flex: 1 }}>
            <Text style={styles.userName} numberOfLines={1}>{user.full_name}</Text>
            <Text style={styles.userRole}>Administrator</Text>
          </View>
          <Pressable onPress={logout} testID="console-logout" hitSlop={8}>
            <Ionicons name="log-out-outline" size={20} color={cc.sidebarText} />
          </Pressable>
        </View>
      </View>

      {/* Main */}
      <View style={styles.main}>
        <ScrollView contentContainerStyle={styles.content}>{renderSection()}</ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: { flex: 1, flexDirection: "row", backgroundColor: cc.bg },
  sidebar: { width: 248, backgroundColor: cc.sidebar, paddingVertical: spacing.xl, paddingHorizontal: spacing.lg },
  brand: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.sm, marginBottom: spacing["2xl"] },
  logo: { width: 42, height: 42, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.12)", alignItems: "center", justifyContent: "center" },
  brandTitle: { color: "#fff", fontSize: font.xl, fontWeight: "800" },
  brandSub: { color: cc.sidebarText, fontSize: font.sm },
  nav: { flex: 1, gap: 4 },
  navItem: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.md, paddingHorizontal: spacing.md, borderRadius: radius.sm },
  navItemActive: { backgroundColor: cc.sidebarActive },
  navText: { color: cc.sidebarText, fontSize: font.base, fontWeight: "600" },
  navTextActive: { color: "#fff" },
  userBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingTop: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.08)",
  },
  userName: { color: "#fff", fontSize: font.base, fontWeight: "700" },
  userRole: { color: cc.sidebarText, fontSize: font.sm },
  main: { flex: 1 },
  content: { padding: spacing["2xl"], maxWidth: 1280 },
});
