import * as Device from "expo-device";
import { Platform } from "react-native";
import { storage } from "@/src/utils/storage";

const DEVICE_ID_KEY = "attendance_device_id";

/** A stable per-installation id, generated once and kept in secure storage. */
export async function getDeviceId(): Promise<string> {
  let id = await storage.secureGet<string>(DEVICE_ID_KEY, "");
  if (!id) {
    id =
      "dev-" +
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 10) +
      Math.random().toString(36).slice(2, 10);
    await storage.secureSet(DEVICE_ID_KEY, id);
  }
  return id;
}

export type DeviceInfo = { device_name: string | null; model: string | null; platform: string };

/** Best-effort device name + model. iOS may return a generic name (Apple privacy). */
export function getDeviceInfo(): DeviceInfo {
  const name = Device.deviceName || null;
  const model = Device.modelName || (Platform.OS === "web" ? "Web Browser" : null);
  return { device_name: name, model, platform: Platform.OS };
}
