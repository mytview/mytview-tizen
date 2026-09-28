// MytView Tizen — bootstrap + gate + pairing (broker primary, device-code fallback). Once authenticated
// it hands off to the browse shell (browse.js). Focus/remote handling lives in nav.js.

import { ApiConfig } from './api.js';
import { Session } from './session.js';
import { Broker, BrokerClient } from './broker.js';
import { open as pairOpen, newPairing } from './paircrypto.js';
import { qrDataUrl } from './qr.js';
import * as nav from './nav.js';
import { renderShell } from './browse.js';

const app = document.getElementById('app');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

ApiConfig.setClientName(deviceName());
function deviceName() {
	// A real per-set label for the Devices list (web/iOS), not a constant. webapis.productinfo is the Samsung
	// TV product API (present in the packaged app; absent in a desktop preview → falls back to "Samsung TV").
	try {
		if (window.webapis && webapis.productinfo && webapis.productinfo.getModel) {
			const m = webapis.productinfo.getModel();
			if (m) return 'Samsung ' + m;
		}
	} catch (e) {}
	return 'Samsung TV';
}

/** Scale the fixed 1920×1080 stage to fit the window (=1 on a real 1080p TV, shrunk in a desktop browser). */
function fitStage() {
	// The Tizen soft keyboard (IME) shrinks window.innerHeight while a text field is focused. Rescaling then
	// would shrink the whole 10-foot UI (the tab bar collapses), corrupt the spatial-nav geometry (Up/Left
	// misroute), AND leave the player clipped when you Play right after. The stage size doesn't actually
	// change — the IME just overlaps it — so keep the current scale while a field is focused.
	if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
	const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
	const x = (window.innerWidth - 1920 * s) / 2;
	const y = (window.innerHeight - 1080 * s) / 2;
	app.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
}

const session = new Session();
let epoch = 0; // bumped on every view change; async pairing loops bail when their epoch is stale

session.onChange(render);
registerMediaKeys();
nav.initNav();
window.addEventListener('resize', fitStage);
fitStage();
render();

function render() {
	epoch++;
	// A render that THROWS must never strand the viewer on the splash with a dead Return key — that
	// exact shape is a CRITICAL Return-key-policy rejection (Seller Office 2026-08-19, on
	// Tizen 7.0–10.0 panels we can't test locally). Show a plain error state instead; Return exits
	// via nav.js's no-handler fallback, and Retry re-renders.
	try {
		if (session.isAuthenticated) renderShell(session);
		else renderBroker();
	} catch (e) {
		try {
			document.getElementById('app').innerHTML =
				'<div class="screen"><div class="center-col">' +
				'<div class="page-title">Something went wrong</div>' +
				'<div class="muted">' + escapeHtml((e && e.message) || 'Unknown error') + '</div>' +
				'<button class="btn focusable" tabindex="0" id="bootRetry">Try again</button>' +
				'</div></div>';
			const r = document.getElementById('bootRetry');
			r.addEventListener('click', () => render());
			r.focus();
		} catch (e2) {}
	}
	hideSplash();
}

/** Drop the markup-inlined launch splash (index.html) once a real screen has rendered. It covered the
 *  whole cold start — bundle parse, session restore, first paint — which is the slow part on old sets. */
function hideSplash() {
	const el = document.getElementById('splash');
	if (el && el.parentNode) el.parentNode.removeChild(el);
}

/** Exit the app to the TV home (Tizen). The primary pairing screen is the root, so Back there exits. */
function exitApp() { try { window.tizen.application.getCurrentApplication().exit(); } catch (e) {} }

// ---- pairing: broker (primary) -----------------------------------------------------------------

async function renderBroker() {
	const mine = epoch;
	// Centered column ⇔ the tvOS reference (TVLoginView): wordmark → title → QR → subtitle → button.
	// (Was a left-aligned horizontal split with the QR off to the side — a per-client divergence; tvOS is
	// the canonical TV layout, so Tizen mirrors it screen-for-screen.)
	app.innerHTML = `
		<div class="screen"><div class="center-col">
			<img class="wordmark" src="wordmark.png" alt="MytView">
			<div class="title">Sign in with your phone</div>
			<div class="qr" id="qrBox"><div class="muted" style="width:360px;height:360px;display:flex;align-items:center;justify-content:center">…</div></div>
			<div class="subtitle">Open the MytView app on your phone and scan this</div>
			<button class="btn focusable" tabindex="0" id="toManual">Enter server manually</button>
			<div class="error hidden" id="brokerErr"></div>
		</div></div>`;
	nav.setBack(exitApp); // primary pairing screen is the root — Back exits the app (Samsung QA expects a clean exit)
	document.getElementById('toManual').addEventListener('click', () => renderServerEntry());
	nav.focusFirst();

	const pairKey = newPairing();
	const broker = new BrokerClient();
	let info;
	try {
		info = await broker.pairNew();
	} catch (e) {
		return showErr('brokerErr', "Couldn't reach the pairing service.");
	}
	if (mine !== epoch) return;
	document.getElementById('qrBox').innerHTML = `<img alt="Pairing QR" src="${qrDataUrl(Broker.qrUrl(info.pairingId, pairKey))}">`;

	const deadline = Date.now() + (info.expiresIn || 300) * 1000;
	while (Date.now() < deadline) {
		await sleep(2000);
		if (mine !== epoch) return;
		let r;
		try { r = await broker.pairPoll(info.pairingId, info.pollToken); } catch (e) { continue; }
		if (r.status === 'claimed' && r.payload) {
			const plain = await pairOpen(r.payload, pairKey);
			const payload = plain && safeJson(new TextDecoder().decode(plain));
			if (payload && payload.baseUrl && payload.token) {
				session.adopt(payload.baseUrl, payload.token, null); // → onChange → shell
				return;
			}
			return showErr('brokerErr', 'Couldn’t read the pairing data. Try again.');
		}
		if (r.status === 'expired') return showErr('brokerErr', 'This code expired. Go back and reopen.');
	}
	if (mine === epoch) showErr('brokerErr', 'This code expired. Go back and reopen.');
}

// ---- pairing: device-code (fallback) -----------------------------------------------------------

function renderServerEntry(errorMsg) {
	epoch++;
	app.innerHTML = `
		<div class="screen"><div class="center-col">
			<img class="wordmark" src="wordmark.png" alt="MytView">
			<div class="title">Connect to your server</div>
			<div class="subtitle">Enter your MytView server address.</div>
			<input class="field focusable" tabindex="0" id="server" placeholder="https://your-server" value="">
			<div class="row">
				<button class="btn focusable" tabindex="0" id="continue">Continue</button>
				<button class="btn focusable" tabindex="0" id="back">Scan with phone instead</button>
			</div>
			<div class="error ${errorMsg ? '' : 'hidden'}" id="entryErr">${errorMsg || ''}</div>
		</div></div>`;
	nav.setBack(() => renderBroker());
	document.getElementById('back').addEventListener('click', () => renderBroker());
	document.getElementById('continue').addEventListener('click', () => {
		const url = document.getElementById('server').value.trim();
		if (url) startDeviceCode(url);
	});
	nav.focusFirst();
}

async function startDeviceCode(server) {
	const client = session.anonymousClient(server);
	if (!client) return renderServerEntry('That server address doesn’t look right.');
	epoch++;
	const mine = epoch;
	app.innerHTML = `<div class="screen"><div class="muted">Connecting to ${escapeHtml(server)}…</div></div>`;
	nav.setBack(() => renderServerEntry());
	let start;
	try { start = await client.deviceStart(); } catch (e) { return renderServerEntry('Couldn’t reach that server.'); }
	if (mine !== epoch) return;

	// Centered column ⇔ the broker screen + tvOS reference (was a left-aligned split with the QR aside).
	app.innerHTML = `
		<div class="screen"><div class="center-col">
			<div class="title">Pair this TV</div>
			<div class="qr"><img alt="Pairing QR" src="${qrDataUrl(start.verification_url_complete)}"></div>
			<div class="subtitle">On your phone or computer, open ${escapeHtml(start.verification_url)}<br>and enter this code:</div>
			<div class="code">${escapeHtml(start.user_code)}</div>
			<button class="btn focusable" tabindex="0" id="back">Back</button>
		</div></div>`;
	nav.setBack(() => renderServerEntry());
	document.getElementById('back').addEventListener('click', () => renderServerEntry());
	nav.focusFirst();

	const deadline = Date.now() + (start.expires_in || 300) * 1000;
	while (Date.now() < deadline) {
		await sleep((start.interval || 5) * 1000);
		if (mine !== epoch) return;
		let poll;
		try {
			poll = await client.devicePoll(start.device_code);
		} catch (e) {
			if (e && e.status === 410) break; // expired
			continue; // transient
		}
		if (poll.status === 'approved' && poll.token) {
			// Use the server the user ENTERED, not poll.baseUrl (the server's ORIGIN / forwarded host —
			// trivially stale behind a proxy). The client already knows the URL it paired against. ⇔ iOS/Android.
			session.adopt(server, poll.token, poll.user || null);
			return;
		}
		// pending → keep polling
	}
	if (mine === epoch) renderServerEntry('That code expired. Try again.');
}

// ---- remote media keys (arrows/OK/Back handled by nav.js) ---------------------------------------

function registerMediaKeys() {
	try {
		if (window.tizen && tizen.tvinputdevice) {
			['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaFastForward', 'MediaRewind'].forEach((k) => {
				try { tizen.tvinputdevice.registerKey(k); } catch (e) {}
			});
		}
	} catch (e) {}
}

function showErr(id, msg) {
	const el = document.getElementById(id);
	if (el) { el.textContent = msg; el.classList.remove('hidden'); }
}
function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }
function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
