// Central theme tokens — derived from /app/design_guidelines.json
// "1 iOS-Native Clean" — Dark Slate / Graphite brand, no blues.

export const colors = {
  surface: "#F9F9FB",
  onSurface: "#111827",
  surfaceSecondary: "#FFFFFF",
  onSurfaceSecondary: "#111827",
  surfaceTertiary: "#F3F4F6",
  onSurfaceTertiary: "#374151",
  surfaceInverse: "#1F2937",
  onSurfaceInverse: "#FFFFFF",
  brand: "#1F2937",
  brandPrimary: "#111827",
  onBrandPrimary: "#FFFFFF",
  brandSecondary: "#374151",
  brandTertiary: "#E5E7EB",
  onBrandTertiary: "#111827",
  success: "#10B981",
  onSuccess: "#FFFFFF",
  warning: "#F59E0B",
  onWarning: "#FFFFFF",
  error: "#EF4444",
  onError: "#FFFFFF",
  info: "#F97316",
  onInfo: "#FFFFFF",
  border: "#E5E7EB",
  borderStrong: "#D1D5DB",
  divider: "#F3F4F6",
  muted: "#6B7280",
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  "2xl": 32,
  "3xl": 48,
};

export const radius = {
  sm: 6,
  md: 12,
  lg: 20,
  pill: 999,
};

export const font = {
  sm: 12,
  base: 14,
  lg: 16,
  xl: 20,
  "2xl": 24,
};

// Presence status -> visual config
export const statusConfig: Record<
  string,
  { label: string; color: string; bg: string; icon: string }
> = {
  on_campus: { label: "On Campus", color: "#047857", bg: "#D1FAE5", icon: "checkmark-circle" },
  exited: { label: "Exited", color: "#4B5563", bg: "#E5E7EB", icon: "log-out-outline" },
  on_tour: { label: "On Tour", color: "#C2410C", bg: "#FFEDD5", icon: "airplane" },
  on_leave: { label: "On Leave", color: "#B45309", bg: "#FEF3C7", icon: "bed-outline" },
};

export const categoryLabel: Record<string, string> = {
  sailor: "Sailor",
  staff: "Staff",
  coach: "Coach",
};

export const shadow = {
  card: {
    shadowColor: "#111827",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
};
