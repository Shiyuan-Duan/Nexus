import React, { useEffect, useRef } from "react";
import { ActivityIndicator, Animated, View, Text, TouchableOpacity, StyleSheet, Platform } from "react-native";
import type { DeviceIdentity } from "../constants/devices";
import type { ConnectionStrength } from "../services/ble/bleTypes";

export interface DeviceCardProps {
  device: DeviceIdentity;
  strength?: ConnectionStrength;
  onPress?: () => void;
  loading?: boolean;
  pulse?: boolean;
}

function strengthColor(s?: ConnectionStrength): string {
  if (s === "strong") return "#22c55e"; // green
  if (s === "medium" || s === "weak") return "#f59e0b"; // orange
  if (s === "disconnected") return "#ef4444"; // red
  return "#9ca3af"; // gray unknown
}

export const DeviceCard: React.FC<DeviceCardProps> = ({ device, strength, onPress, loading, pulse = true }) => {
  const blink = useRef(new Animated.Value(1)).current;
  const blinking = strength !== "disconnected" && !loading && pulse;

  useEffect(() => {
    blink.stopAnimation();
    blink.setValue(1);
    if (!blinking) return;
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(blink, { toValue: 0.2, duration: 500, useNativeDriver: true }),
        Animated.timing(blink, { toValue: 1, duration: 500, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => {
      anim.stop();
    };
  }, [blink, blinking]);

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.8} style={styles.card}>
      <View style={styles.iconBox}>
        <Text>{device.icon || "🔌"}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.name} numberOfLines={1} ellipsizeMode="tail">
          {device.name}
        </Text>
        <Text style={styles.subtle} numberOfLines={1} ellipsizeMode="tail">
          {device.type}
        </Text>
      </View>
      {loading ? (
        <ActivityIndicator size="small" />
      ) : (
        <Animated.View
          style={[styles.dot, { backgroundColor: strengthColor(strength), opacity: blinking ? blink : 1 }]}
        />
      )}
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e5e7eb',
    flexDirection: 'row',
    alignItems: 'center',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.05,
        shadowRadius: 8,
      },
      android: { elevation: 1 },
      default: {},
    }),
  },
  iconBox: {
    width: 40,
    height: 40,
    backgroundColor: '#f3f4f6',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  name: {
    fontWeight: '600',
    color: '#111827',
  },
  subtle: {
    color: '#6b7280',
  },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
});

export default DeviceCard;
