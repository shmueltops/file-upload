export const SESSION_EXPIRED_EVENT = 'vault:session-expired';
export const SIGNED_OUT_KEY = 'vault:signed-out';

// A logout marker only: credentials and session tokens never go into browser storage.
export function isSignedOut() {
  try {
    return localStorage.getItem(SIGNED_OUT_KEY) === '1';
  } catch {
    return false;
  }
}
export function rememberSignedOut(signedOut: boolean) {
  try {
    if (signedOut) localStorage.setItem(SIGNED_OUT_KEY, '1');
    else localStorage.removeItem(SIGNED_OUT_KEY);
  } catch {
    // React still signs out when browser storage is unavailable.
  }
}
