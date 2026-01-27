import React, { useCallback, useEffect, useState } from "react";
import { View, Text, FlatList, TouchableOpacity, ActivityIndicator, StyleSheet, TextInput, Alert, Animated } from "react-native";
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from "@expo/vector-icons";
import { Swipeable } from "react-native-gesture-handler";
import {
  getActiveRecordingId,
  getRecordingCsv,
  getRecordingMeta,
  listRecordings,
  renameRecording,
  deleteRecording,
  subscribe as subscribeRecorder,
  type RecordingMeta,
} from "../services/data/recorder";

export const DataTab: React.FC = () => {
  const [recordings, setRecordings] = useState<RecordingMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(getActiveRecordingId());
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [exportErr, setExportErr] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState<string>("");

  const load = useCallback(async () => {
    const list = await listRecordings();
    setRecordings(list);
    setActiveId(getActiveRecordingId());
  }, []);

  useEffect(() => {
    void load();
    const unsub = subscribeRecorder(() => { void load(); });
    return () => unsub();
  }, [load]);

  const exportRecording = useCallback(async (rec: RecordingMeta) => {
    if (exportingId) return;
    setExportingId(rec.id);
    setExportErr(null);
    try {
      // Lazy-load native modules to avoid init issues during screen mount.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const FileSystem = require("expo-file-system");
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Sharing = require("expo-sharing");
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const JSZip = require("jszip");

      if (!(await Sharing.isAvailableAsync())) {
        throw new Error("Sharing is not available on this device.");
      }
      const meta = await getRecordingMeta(rec.id);
      const csv = await getRecordingCsv(rec.id);
      if (!meta) return;
      const metaText = JSON.stringify(meta, null, 2);
      const dir = `${FileSystem.documentDirectory}exports`;
      const dirInfo = await FileSystem.getInfoAsync(dir);
      if (!dirInfo.exists) {
        await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      }
      const safeId = rec.id.replace(/[^a-zA-Z0-9_-]/g, "_");
      const baseName = `${rec.deviceType}_${safeId}`;
      const zipPath = `${dir}/${baseName}.zip`;
      const zip = new JSZip();
      zip.file(`${baseName}.csv`, csv || "");
      zip.file(`${baseName}.json`, metaText);
      const zipBase64 = await zip.generateAsync({ type: "base64" });
      await FileSystem.writeAsStringAsync(zipPath, zipBase64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      await Sharing.shareAsync(zipPath, {
        mimeType: "application/zip",
        dialogTitle: `Export ${rec.deviceType} dataset`,
      });
    } catch (e: any) {
      setExportErr(e?.message ?? String(e));
    } finally {
      setExportingId(null);
    }
  }, [exportingId]);

  const startEdit = useCallback((rec: RecordingMeta) => {
    setEditingId(rec.id);
    setDraftName(rec.name ?? rec.id);
  }, []);

  const commitEdit = useCallback(async () => {
    if (!editingId) return;
    await renameRecording(editingId, draftName.trim() || editingId);
    setEditingId(null);
  }, [draftName, editingId]);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
  }, []);

  const confirmDelete = useCallback((rec: RecordingMeta) => {
    if (activeId === rec.id) {
      Alert.alert("Recording Active", "Stop recording before deleting this dataset.");
      return;
    }
    Alert.alert(
      "Delete recording?",
      "This will remove the dataset from this device.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Continue",
          style: "destructive",
          onPress: () => {
            Alert.alert(
              "Confirm delete",
              "This cannot be undone. Are you absolutely sure?",
              [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Delete",
                  style: "destructive",
                  onPress: async () => {
                    await deleteRecording(rec.id);
                  },
                },
              ]
            );
          },
        },
      ]
    );
  }, [activeId]);

  return (
    <SafeAreaView style={styles.screen} edges={['top','left','right','bottom']}>
      <FlatList
        data={recordings}
        keyExtractor={(d) => d.id}
        ListHeaderComponent={
          <View style={styles.headerWrap}>
            <Text style={styles.headerTitle}>Saved recordings</Text>
            <Text style={styles.headerSubtitle}>Tap a name to rename, swipe left to delete, use the share icon to export.</Text>
            {exportErr ? <Text style={styles.errorText}>{exportErr}</Text> : null}
          </View>
        }
        renderItem={({ item }) => (
          <Swipeable
            friction={2}
            overshootRight={false}
            rightThreshold={64}
            renderRightActions={(progress) => {
              const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: [80, 0] });
              const opacity = progress.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 0, 1] });
              return (
                <Animated.View style={{ transform: [{ translateX }], opacity }}>
                  <View style={styles.swipeDelete}>
                    <TouchableOpacity onPress={() => confirmDelete(item)} style={styles.swipeDeleteButton}>
                      <Text style={styles.swipeDeleteText}>Delete</Text>
                    </TouchableOpacity>
                  </View>
                </Animated.View>
              );
            }}
          >
            <View style={styles.card}>
              <View style={styles.cardAccent} />
              <View style={styles.cardHeader}>
                <View style={{ flex: 1 }}>
                  {editingId === item.id ? (
                    <View style={styles.editRow}>
                      <TextInput
                        value={draftName}
                        onChangeText={setDraftName}
                        autoFocus
                        onSubmitEditing={commitEdit}
                        style={styles.editInput}
                      />
                      <TouchableOpacity style={styles.editButton} onPress={commitEdit}>
                        <Ionicons name="checkmark" size={18} color="#111827" />
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.editButton} onPress={cancelEdit}>
                        <Ionicons name="close" size={18} color="#111827" />
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <TouchableOpacity onPress={() => startEdit(item)} style={styles.titleRow}>
                      <Text style={styles.cardTitle} numberOfLines={1}>{item.name ?? item.id}</Text>
                      <Ionicons name="create-outline" size={16} color="#6b7280" />
                    </TouchableOpacity>
                  )}
                  <View style={styles.metaRow}>
                    <View style={styles.tag}>
                      <Text style={styles.tagText}>{item.deviceType}</Text>
                    </View>
                    <Text style={styles.metaText}>ID {item.id}</Text>
                  </View>
                </View>
                <TouchableOpacity
                  style={styles.exportButton}
                  onPress={() => exportRecording(item)}
                  disabled={exportingId === item.id}
                >
                  {exportingId === item.id ? (
                    <ActivityIndicator size="small" color="#111827" />
                  ) : (
                    <Ionicons name="share-outline" size={18} color="#111827" />
                  )}
                </TouchableOpacity>
              </View>

              <View style={styles.statsRow}>
                <View style={styles.statCell}>
                  <Text style={styles.statLabel}>Started</Text>
                  <Text style={styles.statValue}>{new Date(item.startedAt).toLocaleString()}</Text>
                </View>
                <View style={styles.statCell}>
                  <Text style={styles.statLabel}>Samples</Text>
                  <Text style={styles.statValue}>{item.sampleCount}</Text>
                </View>
                <View style={[styles.statCell, styles.statCellLast]}>
                  <Text style={styles.statLabel}>Events</Text>
                  <Text style={styles.statValue}>{item.events?.length ?? 0}</Text>
                </View>
              </View>
            {item.events && item.events.length > 0 ? (
              <View style={styles.eventPreview}>
                {item.events.slice(-3).map((evt, idx) => (
                  <Text key={`${item.id}-evt-${idx}`} style={styles.eventPreviewText}>
                    {evt.label} • +{((evt.t - item.startedAt) / 1000).toFixed(2)}s
                  </Text>
                ))}
              </View>
            ) : null}

              {item.endedAt ? (
                <Text style={styles.endedText}>
                  Ended: {new Date(item.endedAt).toLocaleString()}
                </Text>
              ) : activeId === item.id ? (
                <View style={styles.recordingPill}>
                  <View style={styles.recordingDot} />
                  <Text style={styles.recordingText}>Recording in progress</Text>
                </View>
              ) : null}
            </View>
          </Swipeable>
        )}
        ListEmptyComponent={<Text style={styles.emptyText}>No recordings yet</Text>}
      />
    </SafeAreaView>
  );
};

export default DataTab;

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#f6f7f8',
  },
  headerWrap: {
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 6,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#111827",
  },
  headerSubtitle: {
    color: "#6b7280",
    fontSize: 12,
    paddingTop: 6,
  },
  card: {
    marginHorizontal: 12,
    marginBottom: 12,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    backgroundColor: "#ffffff",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 1,
    overflow: "hidden",
  },
  cardAccent: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: 4,
    backgroundColor: "#111827",
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
  },
  editRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  editInput: {
    flex: 1,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    backgroundColor: "#ffffff",
    marginRight: 6,
  },
  editButton: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    backgroundColor: "#f9fafb",
    marginLeft: 4,
  },
  cardTitle: {
    fontWeight: "700",
    color: "#111827",
    marginBottom: 4,
    maxWidth: "90%",
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  metaText: {
    color: "#6b7280",
    fontSize: 12,
  },
  tag: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: "#eef2ff",
    marginRight: 8,
  },
  tagText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#4338ca",
    letterSpacing: 0.2,
  },
  exportButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    backgroundColor: "#f9fafb",
  },
  statsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 8,
  },
  statCell: {
    flex: 1,
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderRadius: 10,
    backgroundColor: "#f9fafb",
    borderWidth: 1,
    borderColor: "#eef2f7",
    marginRight: 8,
  },
  statCellLast: {
    marginRight: 0,
  },
  statLabel: {
    color: "#6b7280",
    fontSize: 11,
    marginBottom: 4,
  },
  statValue: {
    color: "#111827",
    fontSize: 12,
    fontWeight: "700",
  },
  eventPreview: {
    marginTop: 8,
  },
  eventPreviewText: {
    color: "#6b7280",
    fontSize: 12,
    marginTop: 2,
  },
  recordingPill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    marginTop: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: "#fee2e2",
  },
  recordingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#ef4444",
    marginRight: 6,
  },
  recordingText: {
    color: "#b91c1c",
    fontSize: 12,
    fontWeight: "600",
  },
  endedText: {
    color: "#6b7280",
    marginTop: 8,
    fontSize: 12,
  },
  emptyText: {
    padding: 12,
    color: "#6b7280",
  },
  errorText: {
    color: "#b91c1c",
    paddingHorizontal: 12,
    paddingBottom: 6,
    fontSize: 12,
  },
  swipeDelete: {
    width: 96,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
  },
  swipeDeleteButton: {
    backgroundColor: "#ef4444",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
  },
  swipeDeleteText: {
    color: "#ffffff",
    fontWeight: "700",
  },
});
