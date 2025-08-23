import { View, ViewStyle } from 'react-native';

type Status = 'strong' | 'medium' | 'weak' | 'disconnected';

export type StatusDotProps = {
  status: Status;
  size?: number;
  style?: ViewStyle;
};

const COLORS: Record<Status, string> = {
  strong: '#16a34a', // green
  medium: '#f59e0b', // orange
  weak: '#b45309', // dark orange
  disconnected: '#ef4444', // red
};

const LABELS: Record<Status, string> = {
  strong: 'Strong connection',
  medium: 'Medium connection',
  weak: 'Weak connection',
  disconnected: 'Disconnected',
};

export default function StatusDot({ status, size = 10, style }: StatusDotProps) {
  const dimension = { width: size, height: size, borderRadius: size / 2 } as const;
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={LABELS[status]}
      style={[{ backgroundColor: COLORS[status] }, dimension, style]}
      testID="status-dot"
    />
  );
}

