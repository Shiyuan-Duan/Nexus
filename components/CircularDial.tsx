import React from 'react';
import { StyleSheet, View } from 'react-native';
import { RadialSlider } from 'react-native-radial-slider';

type Props = {
  value: number; // 0..100
  onChange: (v: number) => void;
  onComplete?: (v: number) => void;
  size?: number; // px (container size)
  stroke?: number; // ring thickness
  trackColor?: string; // unselected track color
  progressColor?: string; // selected track color
  handleColor?: string; // knob color
  children?: React.ReactNode; // center content
  disabled?: boolean;
};

export default function CircularDial({
  value,
  onChange,
  onComplete,
  size = 220,
  stroke = 18,
  trackColor = '#e5e7eb',
  progressColor = '#2563eb',
  handleColor = '#2563eb',
  children,
  disabled,
}: Props) {
  // Map `size` and styling to library props. Keep a small margin to avoid clipping.
  const radius = Math.max(40, size / 2 - 12);
  const sliderWidth = Math.max(8, stroke);
  return (
    <View style={[styles.container, { width: size, height: size, zIndex: 1, position: 'relative' }]} pointerEvents="box-none"> 
      <RadialSlider
        variant={'radial-circle-slider'}
        value={value}
        min={0}
        max={100}
        // Sizing and look
        radius={radius}
        sliderWidth={sliderWidth}
        sliderTrackColor={trackColor}
        // Use a flat gradient to emulate a solid color for the selected track
        linearGradient={[
          { offset: '0%', color: progressColor },
          { offset: '100%', color: progressColor },
        ]}
        thumbColor={handleColor}
        // Hide built-in center content to avoid overlapping with our children
        isHideCenterContent
        isHideTitle
        isHideSubtitle
        isHideValue
        isHideButtons
        isHideLines
        isHideMarkerLine
        disabled={disabled}
        // Events
        onChange={(v: number) => onChange(Math.max(0, Math.min(100, v)))}
        onComplete={(v: number) => onComplete?.(Math.max(0, Math.min(100, Math.round(v))))}
      />
      {children ? <View style={styles.center}>{children}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
  },
});
