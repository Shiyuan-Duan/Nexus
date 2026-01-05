import React, { useState } from "react";
import { View, Text, Switch, Alert, StyleSheet, Platform } from "react-native";
import { SafeAreaView } from 'react-native-safe-area-context';

export const SettingsTab: React.FC = () => {
  const [debugEnabled, setDebugEnabled] = useState(false);
  return (
    <SafeAreaView style={{ flex: 1, padding: 12, backgroundColor: '#f6f7f8' }} edges={['top','left','right','bottom']}>
      <Text style={{ fontSize: 18, fontWeight: "600", marginBottom: 8 }}>Settings</Text>
      <View style={styles.card}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View>
            <Text style={{ fontWeight: '600', color: '#111827' }}>Debug Mode</Text>
            <Text style={{ color: '#6b7280', marginTop: 2 }}>Advanced developer features</Text>
          </View>
          <Switch
            value={debugEnabled}
            onValueChange={(v) => {
              if (v) {
                setDebugEnabled(true);
                setTimeout(() => {
                  setDebugEnabled(false);
                  Alert.alert('No Permission', 'You do not have permission to enable Debug.');
                }, 150);
              } else {
                setDebugEnabled(false);
              }
            }}
          />
        </View>
      </View>
    </SafeAreaView>
  );
};

export default SettingsTab;

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#e5e7eb',
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
});
