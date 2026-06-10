import React from "react";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Platform, View, StyleSheet } from "react-native";
import { useAuth } from "@/src/context/AuthContext";
import { colors } from "@/src/theme";

export default function TabsLayout() {
  const { effectiveRole } = useAuth();
  const isAdmin = effectiveRole === "admin";

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.brandPrimary,
        tabBarInactiveTintColor: "#9CA3AF",
        tabBarStyle: {
          backgroundColor: colors.surfaceSecondary,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          height: Platform.OS === "ios" ? 86 : 64,
          paddingTop: 6,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Board",
          tabBarIcon: ({ color, size }) => <Ionicons name="people" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="checkin"
        options={{
          title: "Check-In",
          tabBarIcon: ({ color, focused }) => (
            <View style={[styles.scanBtn, focused && styles.scanBtnActive]}>
              <Ionicons name="qr-code" size={24} color={focused ? "#fff" : color} />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: isAdmin ? "Admin" : "Profile",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name={isAdmin ? "grid" : "person"} size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  scanBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.surfaceTertiary,
    alignItems: "center",
    justifyContent: "center",
    marginTop: -4,
  },
  scanBtnActive: { backgroundColor: colors.brandPrimary },
});
