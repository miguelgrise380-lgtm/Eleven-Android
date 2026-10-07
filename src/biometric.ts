/**
 * Trava por biometria do aparelho (digital, rosto ou PIN/senha do sistema) usando WebAuthn.
 * Na primeira vez cadastra uma credencial neste aparelho; depois só confirma.
 * O desbloqueio vale até desativar a Eleven ou fechar a aba.
 *
 * Aviso honesto: a checagem é local (no navegador), serve para impedir que outra pessoa use a Eleven
 * no seu aparelho desbloqueado. Não substitui autenticação no servidor.
 *
 * Para desligar a trava: REQUIRE_BIOMETRIC = false.
 */
export const REQUIRE_BIOMETRIC = true;

export type BioResult = "ok" | "denied" | "failed" | "unsupported";

const CRED_KEY = "eleven.credId";
const UNLOCK_KEY = "eleven.unlocked";

const rand = (n: number): ArrayBuffer => crypto.getRandomValues(new Uint8Array(n)).buffer as ArrayBuffer;
const toB64 = (buf: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s: string): ArrayBuffer => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer as ArrayBuffer;

export function isUnlocked(): boolean {
  if (!REQUIRE_BIOMETRIC) return true;
  try {
    return sessionStorage.getItem(UNLOCK_KEY) === "1";
  } catch {
    return false;
  }
}

function setUnlocked(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(UNLOCK_KEY, "1");
    else sessionStorage.removeItem(UNLOCK_KEY);
  } catch {
    /* sem sessionStorage: vale só até recarregar */
  }
}

export function lock(): void {
  setUnlocked(false);
}

/** Pede a biometria (cadastra na primeira vez). "denied" = cancelou ou o navegador exigiu um toque. */
export async function verifyBiometric(): Promise<BioResult> {
  if (!REQUIRE_BIOMETRIC) return "ok";
  try {
    const available = window.PublicKeyCredential && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());
    if (!available) {
      setUnlocked(true); // aparelho sem biometria/PIN: não trava o uso
      return "unsupported";
    }

    const saved = localStorage.getItem(CRED_KEY);
    if (!saved) {
      const cred = (await navigator.credentials.create({
        publicKey: {
          challenge: rand(32),
          rp: { name: "Eleven" },
          user: { id: rand(16), name: "eleven", displayName: "Eleven" },
          pubKeyCredParams: [
            { type: "public-key", alg: -7 },
            { type: "public-key", alg: -257 },
          ],
          authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "preferred" },
          timeout: 60000,
        },
      })) as PublicKeyCredential | null;
      if (!cred) return "failed";
      localStorage.setItem(CRED_KEY, toB64(cred.rawId));
    } else {
      const got = await navigator.credentials.get({
        publicKey: {
          challenge: rand(32),
          allowCredentials: [{ type: "public-key", id: fromB64(saved), transports: ["internal"] }],
          userVerification: "required",
          timeout: 60000,
        },
      });
      if (!got) return "failed";
    }
    setUnlocked(true);
    return "ok";
  } catch (e) {
    return e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "AbortError") ? "denied" : "failed";
  }
}

/** Botão na tela: alguns navegadores só liberam a biometria depois de um toque. */
export function promptTap(): Promise<BioResult> {
  return new Promise((resolve) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Verificar biometria";
    btn.style.cssText =
      "position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 24px);transform:translateX(-50%);z-index:50;padding:16px 28px;border:0;border-radius:999px;font:600 16px system-ui,sans-serif;background:#0b57d0;color:#fff;box-shadow:0 6px 24px rgba(0,0,0,.35)";
    const done = (r: BioResult): void => {
      window.clearTimeout(timer);
      btn.remove();
      resolve(r);
    };
    const timer = window.setTimeout(() => done("denied"), 20000);
    btn.addEventListener("click", () => void verifyBiometric().then(done));
    document.body.append(btn);
  });
}
