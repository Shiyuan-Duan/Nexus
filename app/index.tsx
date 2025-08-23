import { Redirect } from 'expo-router';

export default function Index() {
  // Redirect to the Devices tab; group segments '()' are omitted from URLs.
  return <Redirect href="/devices" />;
}
