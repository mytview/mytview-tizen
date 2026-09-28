// ⇔ Session.swift / Session.kt. Holds baseUrl + token + user, persists them (localStorage — Tizen web
// apps have no secure enclave, acceptable for a household TV; the real "sign out" is the server-side
// session revoke), vends an ApiClient, and reacts to an authenticated 401 by clearing the token.

import { ApiClient, ApiConfig } from './api.js';

const K_BASE = 'myt.baseUrl';
const K_TOKEN = 'myt.token';
const K_USER = 'myt.user';

export class Session {
	constructor() {
		this.baseUrl = localStorage.getItem(K_BASE) || null;
		this.token = localStorage.getItem(K_TOKEN) || null;
		try { this.user = JSON.parse(localStorage.getItem(K_USER) || 'null'); } catch (e) { this.user = null; }
		this._listeners = new Set();
		ApiConfig.setOnUnauthorized(() => this.sessionInvalidated());
	}

	get isAuthenticated() { return !!(this.token && this.baseUrl); }

	/** Subscribe to auth-state changes; returns an unsubscribe fn. */
	onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
	_emit() { for (const fn of this._listeners) fn(this); }

	/** Client for the current server + token, or null until a server is set. */
	client() { return this.baseUrl ? new ApiClient(this.baseUrl, this.token) : null; }

	/** Anonymous client for a just-entered server, used by device-code pairing before a token exists. */
	anonymousClient(server) {
		const base = normalize(server);
		return base ? new ApiClient(base, null) : null;
	}

	/** Adopt {baseUrl, token} from broker or device-code pairing → flips auth, host swaps to Home. */
	adopt(baseUrl, token, user) {
		this.baseUrl = normalize(baseUrl) || baseUrl;
		this.token = token;
		this.user = user || null;
		localStorage.setItem(K_BASE, this.baseUrl);
		localStorage.setItem(K_TOKEN, token);
		if (user) localStorage.setItem(K_USER, JSON.stringify(user)); else localStorage.removeItem(K_USER);
		this._emit();
	}

	/** Real sign-out: revoke this token server-side (best-effort) then clear locally. */
	async logout() {
		try { const c = this.client(); if (c) await c.signOut(); } catch (e) { /* best-effort */ }
		this._clearLocal();
	}

	/** Server rejected the token (revoked elsewhere / expired) — clear locally, no revoke call. */
	sessionInvalidated() {
		if (!this.token) return;
		this._clearLocal();
	}

	_clearLocal() {
		this.token = null;
		this.user = null;
		localStorage.removeItem(K_TOKEN);
		localStorage.removeItem(K_USER);
		this._emit(); // keep baseUrl so re-pairing to the same server is one step
	}
}

/** Default https:// when no scheme is given; strip trailing slashes. */
function normalize(s) {
	let t = (s || '').trim();
	if (!t) return null;
	if (!/:\/\//.test(t)) t = 'https://' + t;
	return t.replace(/\/+$/, '');
}
