import { useEffect } from "react";
import { View, ActivityIndicator, StyleSheet, useWindowDimensions } from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "@/src/context/AuthContext";
import { colors } from "@/src/theme";

const DESKTOP_MIN_WIDTH = 1000;

export default function Index() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const { width } = useWindowDimensions();

  useEffect(() => {
    if (loading) return;
    if (!user) router.replace("/login");
    else if (user.role === "admin" && width >= DESKTOP_MIN_WIDTH) router.replace("/console" as never);
    else router.replace("/(tabs)");
  }, [user, loading, router, width]);

  return (
    <View style={styles.container} testID="splash-loading">
      <ActivityIndicator size="large" color={colors.brandPrimary} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.surface },
});
