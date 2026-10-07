# Eleven no Android (Capacitor)

## Primeira vez
```bash
npm install
cp .env.example .env        # preencha VITE_API_BASE=https://SEU-SITE.netlify.app
npm run android:init        # build + cap add android + permissões + sync
npm run android:open        # abre no Android Studio e rode no celular
```
Já tem a pasta `android/`? Rode só `npm run android:setup` e depois `npm run cap:sync`.

## Netlify (uma vez)
Faça deploy desta versão: as funções agora respondem ao CORS do app (`https://localhost`).
Outras origens: variável `CORS_ORIGINS` (separadas por vírgula).

## O que cada permissão faz
| Recurso | Permissão | Quem pede |
|---|---|---|
| Microfone | `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS` | WebView do Capacitor, no `getUserMedia` ao tocar em "Ativar Eleven" |
| Fotos/arquivos | `READ_MEDIA_IMAGES` (Android 13+), `READ_EXTERNAL_STORAGE` (até 12) | `ensureFileAccess()` em `src/native.ts` |
| GPS das fotos (EXIF) | `ACCESS_MEDIA_LOCATION` | `MainActivity.java` |
| Câmera | `CAMERA` | `ensureFileAccess(true)` |
| Localização | `ACCESS_FINE/COARSE_LOCATION` | `getPosition()` |
| Lembretes | `POST_NOTIFICATIONS` | `requestNotifyPermission()` |

Se negar algo, vá em Configurações › Apps › Eleven › Permissões.

## Alternativa sem CORS
`CAP_SERVER_URL=https://SEU-SITE.netlify.app npx cap sync android` faz o app abrir o seu site direto (sempre atualizado, precisa de internet).
