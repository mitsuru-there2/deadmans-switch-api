// RevenueCat Android 10.27.0 uses standard base64(SHA-256(UTF-8 appUserID)), with padding and no wrapping.
// This is a representation of a server-known profile ID, never an authentication secret.
export async function googleAccountHash(profileId: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(profileId));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}
export async function storeAccountMatches(
  store: "apple" | "google",
  observed: string,
  profileId: string,
) {
  return (
    observed === profileId ||
    (store === "google" && observed === (await googleAccountHash(profileId)))
  );
}
