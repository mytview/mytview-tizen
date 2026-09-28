// The mytview.com pairing broker — a blind rendezvous that only ever relays ciphertext. JS twin of
// MytViewKit's Broker / BrokerClient. The TV uses pairNew + pairPoll; the wire format is camelCase
// (matches pair-broker/src/index.ts). NO media goes through it; the payload is E2E-encrypted (paircrypto).

const API_BASE = 'https://link.mytview.com';

export const Broker = {
	apiBase: API_BASE,
	/** The URL the TV renders as a QR; the phone parses `i` (pairingId) + `k` (the AES pairing key). */
	qrUrl(pairingId, keyB64url) {
		return `${API_BASE}/pair?i=${encodeURIComponent(pairingId)}&k=${encodeURIComponent(keyB64url)}`;
	},
};

export class BrokerClient {
	constructor(base = API_BASE) {
		this.base = base;
	}

	/** TV: create a pairing session → { pairingId, pollToken, expiresIn }. */
	async pairNew() {
		const r = await fetch(`${this.base}/pair/new`, { method: 'POST' });
		if (!r.ok) throw new Error(`broker /pair/new ${r.status}`);
		return r.json();
	}

	/** TV: poll until claimed → { status: 'pending'|'claimed'|'expired', payload? }. */
	async pairPoll(pairingId, pollToken) {
		// `.set()`, NOT `new URLSearchParams({ ... })`: the OBJECT-form constructor no-ops on Tizen 4.0's
		// old WebKit (Cr56) — it stringifies the record to "[object Object]" instead of iterating it, so the
		// poll URL lost both params → broker 400 → this threw → the caller's catch polled forever. It worked
		// on the 2022 set (Cr85) only because the object-form IS supported there. api.js already uses `.set()`.
		const p = new URLSearchParams();
		p.set('pairingId', pairingId);
		p.set('pollToken', pollToken);
		const r = await fetch(`${this.base}/pair/poll?${p.toString()}`, { cache: 'no-store' });
		if (!r.ok) throw new Error(`broker /pair/poll ${r.status}`);
		return r.json();
	}

	/** Phone: hand the TV its encrypted {baseUrl, token} payload. (For a future JS phone scanner.) */
	async pairClaim(pairingId, payload) {
		const r = await fetch(`${this.base}/pair/claim`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ pairingId, payload }),
		});
		if (!r.ok) throw new Error(`broker /pair/claim ${r.status}`);
	}
}
