// ⇔ APIClient.swift / ApiClient.kt. Stateless apart from baseUrl + token. Attaches the bearer +
// X-Client-Name, resolves signed media/image URLs (the signature is the credential — no auth header on
// those), and fires onUnauthorized on an AUTHENTICATED 401 (Session clears the token → back to pairing).
// Signed device-code auth bodies are snake_case; everything else is the /api/v1 contract.

let clientName = null;
let onUnauthorized = () => {};

export const ApiConfig = {
	setClientName(n) { clientName = n; },
	setOnUnauthorized(fn) { onUnauthorized = fn; },
};

export class ApiError extends Error {
	constructor(status, message) {
		super(message || `HTTP ${status}`);
		this.status = status;
	}
}

export class ApiClient {
	constructor(baseUrl, token = null) {
		this.baseUrl = (baseUrl || '').replace(/\/+$/, '');
		this.token = token;
	}

	/** Absolute URL for a server-provided (possibly signed) relative path — hand straight to <img>/<video>. */
	absolute(path) {
		if (!path) return null;
		if (/^https?:\/\//.test(path)) return path;
		return this.baseUrl + '/' + path.replace(/^\/+/, '');
	}

	/** Signed image path + a pixel width (server downscales + caches; `&w` isn't part of the signature). */
	sized(path, width) {
		const abs = this.absolute(path);
		if (!abs) return null;
		const u = new URL(abs);
		u.searchParams.set('w', String(width));
		return u.toString();
	}

	async _send(path, { method = 'GET', query, body, authed = true } = {}) {
		const u = new URL(this.absolute(path));
		if (query) for (const [k, v] of Object.entries(query)) if (v != null) u.searchParams.set(k, String(v));
		const headers = {};
		if (authed && this.token) headers['Authorization'] = 'Bearer ' + this.token;
		if (clientName) {
			const ascii = clientName.replace(/[^\x20-\x7e]/g, '').trim(); // some stacks reject header bytes > 0x7e
			if (ascii) headers['X-Client-Name'] = ascii;
		}
		if (body != null) headers['content-type'] = 'application/json';
		const resp = await fetch(u.toString(), {
			method,
			headers,
			body: body != null ? JSON.stringify(body) : undefined,
			cache: 'no-store',
		});
		if (resp.status === 401) {
			if (authed) onUnauthorized(); // token revoked/expired → drop to pairing (NOT on login/pairing calls)
			throw new ApiError(401, 'not authorized');
		}
		if (!resp.ok) throw new ApiError(resp.status);
		const text = await resp.text();
		return text ? JSON.parse(text) : null;
	}

	// --- auth (login-exempt; device-code bodies are snake_case) ---
	deviceStart() { return this._send('api/v1/auth/device/start', { method: 'POST', authed: false }); }
	devicePoll(deviceCode) {
		return this._send('api/v1/auth/device/poll', { method: 'POST', authed: false, body: { device_code: deviceCode } });
	}

	// --- reads ---
	me() { return this._send('api/v1/me'); }

	/** Fetch a TEXT resource (a WebVTT subtitle) with the same auth + base URL as the JSON calls.
	 *  Subtitles can't go through <track> on this platform, so the app loads them itself. */
	text(pathOrUrl) {
		var url = this.absolute(pathOrUrl);
		return fetch(url, { headers: { Authorization: 'Bearer ' + this.token } }).then(function (r) {
			if (!r.ok) throw new Error('http ' + r.status);
			return r.text();
		});
	}
	status() { return this._send('api/v1/status'); }
	videos({ offset = 0, limit, watched, q, tag } = {}) {
		return this._send('api/v1/videos', { query: { offset, limit, watched: watched ? 1 : undefined, q, tag } });
	}
	/** `sort` is a SERVER-side ordering key (name|updated|unwatched); `watched` reveals the grid's
	 *  server-hidden fully-watched shows (contract §Browse controls / §channels). */
	channels(library, sort, watched) {
		return this._send('api/v1/channels', { query: { library, sort, watched: watched ? 1 : undefined } });
	}
	/** Owner-configured libraries the user can see media in (per-library nav tabs). */
	libraries() { return this._send('api/v1/libraries'); }
	channel(id, showWatched) {
		return this._send('api/v1/channels/' + encodeURIComponent(id), { query: { watched: showWatched ? 1 : undefined } });
	}
	/** Bulk mark every video/episode in a channel/series watched (or unwatched) → { affected, watched }. */
	setChannelWatched(id, watched) {
		return this._send('api/v1/channels/' + encodeURIComponent(id) + '/watched', { method: 'POST', body: { watched } });
	}
	videoDetail(id) { return this._send('api/v1/videos/' + encodeURIComponent(id)); }
	related(id) { return this._send('api/v1/related/' + encodeURIComponent(id)); }

	// --- writes ---
	postWatch(id, { position, watched } = {}) {
		return this._send('api/v1/watch/' + encodeURIComponent(id), { method: 'POST', body: { position, watched } });
	}
	updatePrefs(patch) { return this._send('api/v1/me', { method: 'PATCH', body: patch }); }
	/** Personal unsubscribe (feed filter, not access control) → { hidden }. */
	setChannelHidden(id, hidden) {
		return this._send('api/v1/channels/' + encodeURIComponent(id) + '/hidden', { method: 'POST', body: { hidden } });
	}
	transcodeStatus(id) { return this._send('api/v1/transcode/' + encodeURIComponent(id)); }
	requestTranscode(id) { return this._send('api/v1/transcode/' + encodeURIComponent(id), { method: 'POST' }); }
	signOut() { return this._send('api/v1/auth/sessions/current', { method: 'DELETE' }); }
}
