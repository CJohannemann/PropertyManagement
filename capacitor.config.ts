import type { CapacitorConfig } from '@capacitor/cli'

// Placeholder — native platforms (`npx cap add android`) aren't set up yet.
// appId is provisional, same caveat as FarmHand's: settle this before any
// store submission, since changing it later means a new app listing.
const config: CapacitorConfig = {
  appId: 'com.propertymanagement.app',
  appName: 'Property Management',
  webDir: 'dist',
}

export default config
