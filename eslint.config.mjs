// Fixes a real gap flagged by an automated PR review: `npm run lint` had no
// config file to run against and failed immediately. This version of
// eslint-config-next ships a ready flat-config array directly (no
// FlatCompat/legacy-extends shim needed for this Next.js version).
import nextConfig from "eslint-config-next";

const eslintConfig = [...nextConfig];

export default eslintConfig;
