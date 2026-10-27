// Base64url without padding (RFC 4648 section 5), as JWTs use it. Built on btoa/atob, which every
// target runtime has; decoding is strict so a malformed token never half-parses.

const BASE64URL = /^[A-Za-z0-9_-]*$/;

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Returns undefined for anything that isn't canonical unpadded base64url. */
export function decodeBase64Url(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!BASE64URL.test(text) || text.length % 4 === 1) return undefined;
  let binary: string;
  try {
    binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // Reject non-canonical encodings (stray bits in the last character), so each token has one spelling.
  return encodeBase64Url(bytes) === text ? bytes : undefined;
}
