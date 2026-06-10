import React, { createContext, useContext, useState, useCallback, useRef } from "react";
import { StyleSheet, Text, Animated } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors, radius, spacing, font } from "@/src/theme";

type ToastType = "success" | "error" | "info";
type ToastCtx = { show: (msg: string, type?: ToastType) => void };

const Ctx = createContext<ToastCtx | undefined>(undefined);

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const insets = useSafeAreaInsets();
  const [msg, setMsg] = useState("");
  const [type, setType] = useState<ToastType>("info");
  const [visible, setVisible] = useState(false);
  const opacity = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback(
    (m: string, t: ToastType = "info") => {
      setMsg(m);
      setType(t);
      setVisible(true);
      if (timer.current) clearTimeout(timer.current);
      Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
      timer.current = setTimeout(() => {
        Animated.timing(opacity, { toValue: 0, duration: 250, useNativeDriver: true }).start(
          () => setVisible(false)
        );
      }, 2800);
    },
    [opacity]
  );

  const cfg = {
    success: { bg: colors.success, icon: "checkmark-circle" as const },
    error: { bg: colors.error, icon: "alert-circle" as const },
    info: { bg: colors.surfaceInverse, icon: "information-circle" as const },
  }[type];

  return (
    <Ctx.Provider value={{ show }}>
      {children}
      {visible && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.toast,
            { top: insets.top + spacing.sm, backgroundColor: cfg.bg, opacity },
          ]}
          testID="app-toast"
        >
          <Ionicons name={cfg.icon} size={20} color="#fff" />
          <Text style={styles.toastText}>{msg}</Text>
        </Animated.View>
      )}
    </Ctx.Provider>
  );
};

export const useToast = (): ToastCtx => {
  const c = useContext(Ctx);
  if (!c) throw new Error("useToast must be used within ToastProvider");
  return c;
};

const styles = StyleSheet.create({
  toast: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    zIndex: 9999,
  },
  toastText: { color: "#fff", fontSize: font.base, fontWeight: "600", flex: 1 },
});
