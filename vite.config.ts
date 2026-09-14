import { defineConfig } from 'vite';

export default defineConfig({
  // `./` so the built bundle works from `file://` inside the Cordova WebView — an absolute `/assets/…`
  // base resolves to the device filesystem root and the app comes up blank.
  base: './',
  server: {
    port: 5180,
    strictPort: true,
    host: '127.0.0.1',
  },
  build: {
    target: 'es2022',
    // Off by default: a Vite sourcemap for this bundle is ~12 MB, and Cordova copies `dist/` verbatim
    // into the APK — more than twice the size of everything else in it. Set `JIEQI_SOURCEMAP=1` when
    // you actually need to read a stack trace from a built bundle.
    sourcemap: process.env.JIEQI_SOURCEMAP === '1',
    chunkSizeWarningLimit: 2000,
  },
});
