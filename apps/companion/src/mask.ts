/**
 * Local secret masking, applied BEFORE anything is encrypted and sent. It is a seatbelt, not a boundary: it catches common token
 * shapes and secret-looking values, but it cannot find source code, customer data or an unusual secret. The UI shows how many items
 * were masked. Licence: Apache-2.0.
 */

const RULES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private key]'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, '[token]'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, '[token]'],
  [/\bglpat-[A-Za-z0-9_-]{16,}\b/g, '[token]'],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, '[token]'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[token]'],
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g, '[token]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[token]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[token]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[token]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, 'Bearer [token]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, '$1[masked]@'],
  [/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH)[A-Z0-9_]*)\s*([=:])\s*(["']?)[^\s"']{6,}\3/gi, '$1$2[masked]'],
];

const entropy = (s: string): number => {
  const f = new Map<string, number>();
  for (const c of s) f.set(c, (f.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of f.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
};

export interface Masked { text: string; masked: number }

/** `secrets`: literal secret values to remove wherever they appear (the daemon passes the values of secret-looking environment variables) */
export function maskSecrets(input: string, secrets: readonly string[] = []): Masked {
  let text = input; let masked = 0;
  for (const [re, rep] of RULES) text = text.replace(re, (...m: unknown[]) => { masked++; return rep.replace(/\$(\d)/g, (_x, n: string) => String(m[Number(n)] ?? '')); });
  for (const s of secrets) if (s.length >= 8 && text.includes(s)) { masked += text.split(s).length - 1; text = text.split(s).join('[masked]'); }
  // long high-entropy strings that look like keys (hex, base64, base64url) but are not ordinary words or paths
  // (a 40-character hex string is a git commit id, not a secret: only 64+ hex characters, e.g. a SHA-256, are masked)
  text = text.replace(/(?<![\w/.-])[A-Za-z0-9+/_-]{40,}={0,2}(?![\w/.-])/g, (m) => {
    const hexOnly = /^[0-9a-fA-F]+$/.test(m);
    const hit = hexOnly ? m.length >= 64 : /\d/.test(m) && /[a-z]/.test(m) && /[A-Z]/.test(m) && entropy(m) > 3.8;
    if (hit) masked++;
    return hit ? '[masked]' : m;
  });
  return { text, masked };
}

/** values of environment variables whose names look secret (used as literal secrets to remove) */
export function secretEnvValues(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) if (v && v.length >= 8 && /(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL)/i.test(k)) out.push(v);
  return out;
}

/** shorten for display without cutting a surrogate pair */
export function clip(s: string, max: number): string {
  const a = Array.from(s);
  return a.length <= max ? s : a.slice(0, max - 1).join('') + '…';
}
