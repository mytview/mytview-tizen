// End-to-end encryption for the pairing payload — the JS twin of MytViewKit `PairCrypto` (Swift) and
// `com.mytview.core.pair.PairCrypto` (Kotlin). The TV makes a fresh random AES-256 key, puts it in the
// QR; the phone AES-GCM-seals {baseUrl, token} with it; the TV opens it with the key it generated. The
// key rides ONLY the QR, never the broker → blind relay.
//
// Wire format (interop-pinned against CryptoKit's AES.GCM.SealedBox.combined):
//   base64url( nonce(12) || ciphertext || tag(16) ), AES-256-GCM, 96-bit nonce, 128-bit tag.
//
// Uses Web Crypto (crypto.subtle) — present on modern Tizen WebKit, every browser, and Node 16+.

const KEY_BYTES = 32;
const NONCE_BYTES = 12;

export function b64urlEncode(bytes) {
	let s = '';
	for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(str) {
	let t = str.replace(/-/g, '+').replace(/_/g, '/');
	while (t.length % 4) t += '=';
	const bin = atob(t);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function importKey(keyBytes) {
	return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** TV: a fresh random 256-bit pairing key; the base64url string goes in the QR. */
export function newPairing() {
	return b64urlEncode(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));
}

/** Phone: seal `plaintext` (Uint8Array) with the pairing key → the payload string for /pair/claim. */
export async function seal(plaintext, keyB64url) {
	const keyBytes = b64urlDecode(keyB64url);
	if (keyBytes.length !== KEY_BYTES) return null;
	const key = await importKey(keyBytes);
	const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
	const ctAndTag = new Uint8Array(
		await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, plaintext),
	);
	const combined = new Uint8Array(NONCE_BYTES + ctAndTag.length);
	combined.set(nonce, 0);
	combined.set(ctAndTag, NONCE_BYTES);
	return b64urlEncode(combined);
}

/** TV: open a payload with the pairing key it generated → the plaintext bytes ({baseUrl, token} JSON),
 *  or null on any decrypt/auth failure. */
export async function open(payloadB64url, keyB64url) {
	const keyBytes = b64urlDecode(keyB64url);
	if (keyBytes.length !== KEY_BYTES) return null;
	const combined = b64urlDecode(payloadB64url);
	if (combined.length <= NONCE_BYTES) return null;
	const nonce = combined.slice(0, NONCE_BYTES);
	const ctAndTag = combined.slice(NONCE_BYTES);
	try {
		const key = await importKey(keyBytes);
		const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, ctAndTag);
		return new Uint8Array(plain);
	} catch (e) {
		return null;
	}
}
