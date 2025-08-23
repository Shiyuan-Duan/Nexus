import { Platform, PermissionsAndroid } from "react-native";

export async function ensureAndroidBlePermissions(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  try {
    const perms = [
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION, // for older Androids
    ].filter(Boolean) as string[];
    const res = await PermissionsAndroid.requestMultiple(perms);
    const allGranted = perms.every((p) => res[p] === PermissionsAndroid.RESULTS.GRANTED);
    return allGranted;
  } catch {
    return false;
  }
}

// Optional: check if Android location services are enabled using expo-location.
// Returns true if services are enabled, false if disabled, and null if not available.
export async function isLocationServicesEnabled(): Promise<boolean | null> {
  // To avoid optional dependency issues at runtime, don't require expo-location here.
  // If you install expo-location, we can wire this up later.
  return null;
}
