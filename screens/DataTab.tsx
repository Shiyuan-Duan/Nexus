import React, { useEffect, useState } from "react";
import { View, Text, FlatList } from "react-native";
import { listDatasets, start as startPackager } from "../services/data/packager";

export const DataTab: React.FC = () => {
  const [rev, setRev] = useState(0);
  useEffect(() => {
    startPackager();
    const t = setInterval(() => setRev((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const data = listDatasets();
  return (
    <View style={{ flex: 1 }}>
      <Text style={{ padding: 12, fontSize: 18, fontWeight: "600" }}>Packaged Data</Text>
      <FlatList
        data={data}
        keyExtractor={(d) => d.id}
        renderItem={({ item }) => (
          <View style={{ paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderColor: "#e5e7eb" }}>
            <Text style={{ fontWeight: "600" }}>{item.id}</Text>
            <Text style={{ color: "#6b7280" }}>Samples: {item.count}</Text>
          </View>
        )}
        ListEmptyComponent={<Text style={{ padding: 12, color: "#6b7280" }}>No datasets yet</Text>}
      />
    </View>
  );
};

export default DataTab;

