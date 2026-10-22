import type { Env } from "../config";
const encoder = new TextEncoder();
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
export function randomToken() {
  return encode(crypto.getRandomValues(new Uint8Array(32)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
export async function hash(value: string) {
  return encode(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}
export class Vault {
  private keys: Record<string, string>;
  constructor(private env: Pick<Env, "ENCRYPTION_KEYS" | "ENCRYPTION_KEY_ID">) {
    this.keys = JSON.parse(env.ENCRYPTION_KEYS);
    if (!this.keys[env.ENCRYPTION_KEY_ID]) throw new Error("Encryption key missing");
  }
  private key(id: string) {
    const value = this.keys[id];
    if (!value || decode(value).length !== 32) throw new Error("Invalid encryption key");
    return crypto.subtle.importKey("raw", decode(value), "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  async seal(value: unknown, context: string) {
    const id = this.env.ENCRYPTION_KEY_ID;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
      await this.key(id),
      encoder.encode(JSON.stringify(value)),
    );
    return `${id}.${encode(iv)}.${encode(new Uint8Array(ciphertext))}`;
  }
  async open<T>(value: string, context: string): Promise<T> {
    const [id, iv, ciphertext] = value.split(".");
    if (!id || !iv || !ciphertext) throw new Error("Invalid ciphertext");
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decode(iv), additionalData: encoder.encode(context) },
      await this.key(id),
      decode(ciphertext),
    );
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  }
}
export async function sign(secret: string, text: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return encode(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(text))));
}
export async function verifySignature(secret: string, text: string, signature: string) {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify("HMAC", key, decode(signature), encoder.encode(text));
  } catch {
    return false;
  }
}
export async function secretEqual(a: string, b: string) {
  return (await hash(a)) === (await hash(b));
}
