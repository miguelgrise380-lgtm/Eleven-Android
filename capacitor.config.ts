import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Modo padrão: o app carrega os arquivos de ./dist (embutidos no APK) e chama as funções no Netlify
 * via VITE_API_BASE (veja .env.example).
 *
 * Modo alternativo (sem CORS, sempre atualizado): CAP_SERVER_URL=https://SEU-SITE.netlify.app npx cap sync android
 * Aí o app abre o seu site direto dentro do WebView.
 */
const serverUrl = process.env["CAP_SERVER_URL"];

const config: CapacitorConfig = {
  appId: "com.eleven.studios", // troque se já tiver um applicationId; precisa ser igual ao do android/app/build.gradle
  appName: "Eleven",
  webDir: "dist",
  server: {
    androidScheme: "https",
    ...(serverUrl ? { url: serverUrl, cleartext: false } : {}),
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
