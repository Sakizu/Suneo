import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

// On Android (Termux) there is no @tailwindcss/oxide NAPI prebuild for
// android-arm64, so the Tailwind PostCSS plugin cannot run there. Termux builds
// (scripts/termux/build.sh) swap in precompiled CSS generated off-device, so
// no plugins are needed at build time on Android. Everywhere else the config
// is unchanged.
const isAndroid = process.platform === "android";

export default {
  plugins: isAndroid
    ? {}
    : {
        "@tailwindcss/postcss": {
          base: projectRoot,
        },
      },
};
