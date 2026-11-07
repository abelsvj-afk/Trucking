// Fixes a real gap flagged by an automated PR review: `npm run lint` had no
// config file to run against and failed immediately. This version of
// eslint-config-next ships a ready flat-config array directly (no
// FlatCompat/legacy-extends shim needed for this Next.js version).
import nextConfig from "eslint-config-next";

const eslintConfig = [
  ...nextConfig,
  // Not our source: Android/Gradle build output from building the Tracker APK, and the Capacitor core copied
  // verbatim from @capacitor/core into the Tracker page (native/tracker/README.md).
  { ignores: ["native/tracker/android/**/build/**", "native/tracker/android/.gradle/**", "native/tracker/www/capacitor-core.js"] },
];

export default eslintConfig;
