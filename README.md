# Nexus

Minimal Expo (SDK 53) TypeScript app using `expo-router` with three tabs: Devices, Data, Settings.

## Scripts

- `dev`: Starts Metro for a development client (`expo start --dev-client`).
- `ios`: Builds and runs the iOS app (`expo run:ios`).
- `android`: Builds and runs the Android app (`expo run:android`).

## Run

1) Install deps: `npm install`
2) Start dev server: `npm run dev`
3) Open iOS/Android with `npm run ios` / `npm run android`

## Structure

- `app/_layout.tsx`: Root layout with `<Tabs>` for three routes.
- `app/(tabs)/devices/index.tsx`: Devices tab screen.
- `app/(tabs)/data/index.tsx`: Data tab screen.
- `app/(tabs)/settings/index.tsx`: Settings tab screen.
- `components/StatusDot.tsx`: Small colored status indicator.

All screens are intentionally minimal and compile cleanly.
# Nexus
