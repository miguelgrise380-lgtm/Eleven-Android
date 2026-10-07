#!/usr/bin/env node
/**
 * Aplica as permissões da Eleven no projeto Android do Capacitor (idempotente: pode rodar quantas vezes quiser).
 *   1) npx cap add android      (só na primeira vez)
 *   2) npm run android:setup
 *   3) npx cap sync android
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "android/app/src/main/AndroidManifest.xml");

if (!existsSync(manifestPath)) {
  console.error("✗ Pasta android/ não encontrada. Rode antes:  npm run build && npx cap add android");
  process.exit(1);
}

// ---------- AndroidManifest.xml ----------
const PERMISSIONS = [
  ["android.permission.INTERNET"],
  ["android.permission.ACCESS_NETWORK_STATE"],
  ["android.permission.RECORD_AUDIO"],
  ["android.permission.MODIFY_AUDIO_SETTINGS"],
  ["android.permission.CAMERA"],
  ["android.permission.READ_MEDIA_IMAGES"],
  ["android.permission.READ_EXTERNAL_STORAGE", 'android:maxSdkVersion="32"'],
  ["android.permission.WRITE_EXTERNAL_STORAGE", 'android:maxSdkVersion="29"'],
  ["android.permission.ACCESS_MEDIA_LOCATION"],
  ["android.permission.ACCESS_COARSE_LOCATION"],
  ["android.permission.ACCESS_FINE_LOCATION"],
  ["android.permission.POST_NOTIFICATIONS"],
  ["android.permission.VIBRATE"],
  ["android.permission.WAKE_LOCK"],
];
const FEATURES = [
  "android.hardware.microphone",
  "android.hardware.camera",
  "android.hardware.camera.autofocus",
  "android.hardware.location.gps",
];

let xml = readFileSync(manifestPath, "utf8");
const before = xml;
const lines = [];

for (const [name, extra] of PERMISSIONS) {
  if (!xml.includes(`"${name}"`)) lines.push(`    <uses-permission android:name="${name}"${extra ? " " + extra : ""} />`);
}
for (const name of FEATURES) {
  if (!xml.includes(`"${name}"`)) lines.push(`    <uses-feature android:name="${name}" android:required="false" />`);
}
if (lines.length) {
  xml = xml.replace("</manifest>", `\n    <!-- Eleven: permissões (android-setup.mjs) -->\n${lines.join("\n")}\n</manifest>`);
}
if (!xml.includes("requestLegacyExternalStorage")) {
  xml = xml.replace("<application", '<application\n        android:requestLegacyExternalStorage="true"');
}
if (xml !== before) {
  writeFileSync(manifestPath, xml);
  console.log(`✓ AndroidManifest.xml atualizado (${lines.length} linhas novas)`);
} else {
  console.log("✓ AndroidManifest.xml já estava certo");
}

// ---------- MainActivity.java (pede ACCESS_MEDIA_LOCATION em tempo de execução) ----------
const cfg = readFileSync(join(root, "capacitor.config.ts"), "utf8");
const appId = /appId:\s*["']([\w.]+)["']/.exec(cfg)?.[1];
if (!appId) {
  console.warn("! Não achei appId no capacitor.config.ts; pulei o MainActivity.java");
} else {
  const javaPath = join(root, "android/app/src/main/java", ...appId.split("."), "MainActivity.java");
  const template = readFileSync(join(root, "android-template/MainActivity.java"), "utf8").replace("__APP_ID__", appId);
  const current = existsSync(javaPath) ? readFileSync(javaPath, "utf8") : "";
  if (current.includes("ACCESS_MEDIA_LOCATION")) {
    console.log("✓ MainActivity.java já estava certo");
  } else if (!current || current.length < 500) {
    mkdirSync(dirname(javaPath), { recursive: true });
    writeFileSync(javaPath, template);
    console.log("✓ MainActivity.java escrito");
  } else {
    console.warn(`! ${javaPath} tem código seu; não mexi. Copie o bloco de permissões de android-template/MainActivity.java.`);
  }
}

// ---------- res/xml/file_paths.xml ----------
const fp = join(root, "android/app/src/main/res/xml/file_paths.xml");
if (!existsSync(fp)) {
  mkdirSync(dirname(fp), { recursive: true });
  writeFileSync(fp, readFileSync(join(root, "android-template/res/xml/file_paths.xml"), "utf8"));
  console.log("✓ file_paths.xml criado");
}
console.log("\nPróximo passo:  npx cap sync android  &&  npx cap open android");
