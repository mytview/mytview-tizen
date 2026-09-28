// Slice 3+4 — HTML5 <video> playback + watch state + autoplay-next + "still watching?".
//
// Fail-open (contract): always attempt the signed `playback.url`; only on a real decode error
// (MediaError 3/4) fall back to `compatUrl`, or POST+poll a transcode. Resume (server-gated
// `resumePosition`), throttled writes (~15s + pause/exit), auto-mark at `watchedAt`.
//
// Autoplay-next: on end, mark watched, pick the next related video (a session `playedIds` loop-guard skips
// anything already played this session, so a symmetric A↔B related graph can't autoplay forever), and
// advance after a short count-down. `advanceCount` tracks CONSECUTIVE UNATTENDED advances; any user
// interaction (play/pause/seek/skip) resets it. Once it reaches `stillWatchingAfter`, pause and prompt
// "Are you still watching?" (OK = continue + reset, Back = stop). Mirrors web Player.svelte + tvOS/Android.

import { durationText } from './format.js';
import { createMedia } from './media.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UP_NEXT_SECS = 8; // autoplay-next countdown — canonical across web + all TV clients

export function playDetail(client, session, detail, prefs, onExit) {
	const app = document.getElementById('app');
	prefs = prefs || { autoplayNext: true, stillWatchingAfter: 3 };
	let d, pb, marked, resumed, fbStage, lastSave, resumeTries; // per-video state (reset in startVideo)
	let hlsWatchdog = null; // native-<video> HLS stall guard (Samsung sets that half-support HLS can hang w/o error)
	let audioWatchdog = null; // a chosen audio track's HLS stream that stops making progress → back to the file's own
	let advanceCount = 0; // CONSECUTIVE UNATTENDED advances (reset on interaction); prompts at stillWatchingAfter
	const playedIds = new Set(); // session loop-guard so a symmetric related graph (A↔B) can't autoplay forever
	let exited = false;
	let countdown = null;

	app.innerHTML = `
		<div class="player" data-cue-size="${prefs.subtitleSize || 'medium'}" data-cue-color="${prefs.subtitleColor || 'white'}">
			<div class="pl-cue" id="plcue"></div>
			<div class="pl-msg hidden" id="plmsg"></div>
			<div class="pl-overlay" id="overlay">
				<div class="pl-title" id="pltitle"></div>
				<div class="pl-audio" id="plaudio"></div>
				<div class="pl-subs" id="plsubs"></div>
				<div class="pl-bottom">
					<span class="pl-time" id="cur">0:00</span>
					<div class="pl-bar"><div class="pl-fill" id="fill"></div></div>
					<span class="pl-time" id="dur">0:00</span>
				</div>
			</div>
			<div class="pl-next hidden" id="next"></div>
		</div>`;
	// The ENGINE (media.js): AVPlay on the sets (the full native decoder — the HTML5 pipeline
	// stuttered undetectably on HEVC, field 2026-09-18), <video> in desktop previews.
	const media = createMedia(app.querySelector('.player'));
	var activeSub = -1;   // index into the descriptor's subtitles; -1 = off
	var activeAudio = null; // chosen audio STREAM index; null = whatever the file leads with
	var pendingSeek = -1;   // seconds to resume at after a source swap (audio change)
	var switchAt = 0;       // where the viewer was when they changed audio — restored if that source fails
	const overlay = document.getElementById('overlay');
	const nextCard = document.getElementById('next');

	media.on('loadedmetadata', onMeta);
	media.on('canplay', tryResume); // Samsung engines can ignore a seek at loadedmetadata — retry when seekable
	media.on('error', onError);
	media.on('playing', clearHlsWatchdog); // HLS rung actually started → cancel the stall guard
	media.on('playing', clearAudioWatchdog);
	media.on('waiting', armAudioWatchdog); // mid-stream starvation on a chosen track counts too
	media.on('stalled', armAudioWatchdog);
	media.on('timeupdate', onTime);
	media.on('pause', savePos);
	media.on('ended', onEnded);
	document.addEventListener('keydown', onKey, true); // capture, so nav.js stays out while playing

	startVideo(detail);

	function startVideo(det) {
		d = det;
		playedIds.add(det.id); // mark played this session (the loop-guard in pickNext reads this)
		pb = d.playback || {};
		marked = !!(d.watch && d.watch.watched);
		resumed = false;
		resumeTries = 0;
		fbStage = 0;
		activeSub = -1; // a fresh VIDEO starts with captions off (contract: never default-on)
		activeAudio = null; // …and on whatever audio track the file itself leads with
		pendingSeek = -1;
		cues = [];
		renderCue();
		clearHlsWatchdog();
		clearAudioWatchdog();
		lastSave = 0;
		hideNext();
		hideMsg();
		document.getElementById('pltitle').textContent = d.title;
		document.getElementById('cur').textContent = '0:00';
		document.getElementById('fill').style.width = '0';
		// A container with too many embedded text streams chokes this panel's demuxer SILENTLY — perfect
		// health metrics, stuttering picture, no error for the ladder to catch (Q7FN field case
		// 2026-09-18, 44 SRT streams). Start on the HLS rung instead of attempting the original when the
		// server says so (`preferHls`, the precise embedded-stream count — contract §playback descriptor)
		// OR, against a server without the flag, when the descriptor's own subtitle list is that long:
		// the fault is THIS platform's, so this client must not depend on a server upgrade to dodge it.
		if (preferHls() && pb.hlsUrl) {
			fbStage = 2;
			setSource(hlsSrc());
			armHlsWatchdog();
		} else {
			setSource(pb.url);
		}
		// The transport overlay is shown in onMeta (once duration is known + layout has settled), so the
		// time/seek-bar row doesn't flash into a wrong position before the video has laid out.
	}
	// Text-stream-heavy container (see startVideo). The 8 mirrors the server's PREFER_HLS_TEXT_STREAMS
	// default; only a container with dozens of tracks (the field case had 44) is anywhere near it.
	// A LITERAL inside the function, deliberately: this runs from startVideo(detail) above, BEFORE any
	// `var` declared down here is assigned — the first cut compared against undefined and never fired.
	function preferHls() {
		return !!pb.preferHls || ((pb.subtitles || []).length > 8);
	}
	// Re-sourcing does NOT touch the track selection: the same video can change source under the viewer
	// (fail-open ladder, audio switch) and losing their captions to that is exactly the regression this
	// feature exists to prevent — the subtitle list is descriptor-level, served independently of the media.
	function setSource(url) {
		media.setSrc(client.absolute(url));
		updateSubsLabel();
		updateAudioLabel();
	}
	// The HLS rung, carrying the viewer's audio pick — so a fallback (or a retry) doesn't quietly put the
	// original language back. Always asks for STREAM COPY (`mode=copy`, contract §HLS): the panel plays
	// HEVC/H.264 + AC-3/E-AC-3/AAC copied into TS natively (Q7FN field test 2026-09-19), so a
	// text-stream-heavy file arrives at original quality for ~no server cost; the server encodes
	// instead when the codecs can't ride in TS, and an old server ignores the parameter.
	function hlsSrc() {
		if (!pb.hlsUrl) return null;
		var u = pb.hlsUrl + (pb.hlsUrl.indexOf('?') >= 0 ? '&' : '?') + 'mode=copy';
		if (activeAudio == null) return u;
		return u + '&a=' + activeAudio;
	}

	// SUBTITLES ARE RENDERED BY US, not by <video>.
	//
	// The obvious approach — append <track> and set mode='showing' — appears to work here and then
	// displays nothing: Samsung's engine does not reliably render track cues (their own guidance is
	// to draw subtitles yourself), and a packaged widget is cross-origin to the server, which <track>
	// loading requires CORS for while the app's `<access origin="*">` allowance only covers fetch.
	// Two independent reasons the browser cannot do this for us, so we fetch the WebVTT through the
	// same client as every other request, parse it, and paint the active cue ourselves.
	var cues = [];        // [{ start, end, text }]
	var cueEl = null;

	function parseVtt(text) {
		var out = [];
		var lines = String(text).replace(/\r\n?/g, '\n').split('\n');
		for (var i = 0; i < lines.length; i++) {
			var m = lines[i].match(/(\d{1,2}:)?(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}:)?(\d{2}):(\d{2})[.,](\d{1,3})/);
			if (!m) continue;
			var start = (parseInt(m[1] || '0', 10) * 3600) + (+m[2] * 60) + +m[3] + +m[4] / 1000;
			var end = (parseInt(m[5] || '0', 10) * 3600) + (+m[6] * 60) + +m[7] + +m[8] / 1000;
			var body = [];
			for (i++; i < lines.length && lines[i].trim() !== ''; i++) body.push(lines[i]);
			// Strip inline tags (<i>, <c.colorE5E5E5>, karaoke timestamps) — we render text, not markup.
			out.push({ start: start, end: end, text: body.join('\n').replace(/<[^>]*>/g, '') });
		}
		return out;
	}

	function loadCues(i) {
		var subs = subsList();
		cues = [];
		renderCue();
		if (i < 0 || !subs[i]) return;
		var want = i;
		client.text(subs[i].url).then(function (text) {
			if (activeSub !== want) return; // the viewer moved on while it was in flight
			cues = parseVtt(text);
			renderCue();
		}).catch(function () {
			if (activeSub === want) showMsg('Subtitles unavailable');
		});
	}

	function renderCue() {
		if (!cueEl) cueEl = document.getElementById('plcue');
		if (!cueEl) return;
		var t = media.currentTime || 0;
		var text = '';
		for (var i = 0; i < cues.length; i++) {
			if (t >= cues[i].start && t <= cues[i].end) { text = cues[i].text; break; }
		}
		cueEl.textContent = text;
		cueEl.style.display = text ? 'block' : 'none';
	}

	function onMeta() {
		document.getElementById('dur').textContent = durationText(Math.floor(media.duration)) || '0:00';
		tryResume();
		media.play();
		showOverlay(); // duration is set + video is laid out → now flash the transport bar (no reflow jump)
	}
	// Resume to the server-gated resumePosition. Samsung's <video> frequently IGNORES a currentTime set at
	// `loadedmetadata` (media not seekable yet) and starts from 0 — so also retry on `canplay`, and stop once
	// it takes (or after a few tries) so we never yank the viewer back after they've settled in.
	function tryResume() {
		// An audio change re-sources the video; land back where the viewer was, not at the resume point.
		if (pendingSeek >= 0) {
			try { media.currentTime = pendingSeek; } catch (e) {}
			if (media.currentTime >= pendingSeek - 2) pendingSeek = -1;
			return;
		}
		if (resumed) return;
		const t = d.resumePosition;
		if (!t || t <= 5 || !media.duration || t >= media.duration) { resumed = true; return; }
		if (media.currentTime >= t - 2) { resumed = true; return; } // seek took
		try { media.currentTime = t; } catch (e) {}
		if (++resumeTries >= 3) resumed = true;
	}

	// ---- fail-open ----
	function onError() {
		const code = media.errorCode;
		// A chosen audio track that won't play is a failed OPTION, not a failed video: put the file's own
		// track back where the viewer was, rather than walking the ladder down to "can't play this".
		if (activeAudio != null && fbStage === 0) return revertAudio();
		// On the ORIGINAL (stage 0), only a real decode failure (MediaError 3/4) falls back — a 2 (network/IO)
		// is an honest error. On a FALLBACK rung, ANY code advances to the next tier (live-HLS segment IO is
		// common), until the ladder is exhausted.
		if (fbStage === 0 && code !== 3 && code !== 4) return showMsg('Playback error. Check your connection.');
		advanceFallback();
	}
	// Fail-open ladder, ONE rung per call so a rung that ALSO fails falls THROUGH: ready whole-file compat
	// (instant static copy — preferred over spinning up a live session) → on-the-fly HLS (starts in seconds) →
	// transcode-and-wait → give up. HLS via native <video> is UNVERIFIED on 2018 (Cr56) sets, so the ladder must
	// fall through to the progressive compat — plus a stall watchdog for a set that half-inits HLS then hangs.
	function advanceFallback() {
		clearHlsWatchdog();
		while (true) {
			fbStage++;
			if (fbStage === 1 && pb.compatUrl) return setSource(pb.compatUrl);
			if (fbStage === 2 && pb.hlsUrl) { setSource(hlsSrc()); return armHlsWatchdog(); }
			if (fbStage === 3 && pb.canTranscode) return transcodeThenPlay();
			if (fbStage >= 4) return showMsg('Can’t play this video on this device.');
		}
	}
	function armHlsWatchdog() {
		clearHlsWatchdog();
		// Some Samsung sets half-support native-<video> HLS: it can init and hang FOREVER without firing 'error'.
		// If nothing has played within a few seconds, force the ladder onward to the whole-file compat.
		hlsWatchdog = setTimeout(() => { hlsWatchdog = null; if (!exited) advanceFallback(); }, 12000);
	}
	function clearHlsWatchdog() { if (hlsWatchdog) { clearTimeout(hlsWatchdog); hlsWatchdog = null; } }

	// A chosen track is served by a live transcode, and a transcode can fail WITHOUT an error: the set just
	// sits in "loading" forever (field 2026-09-13, Q7FN: 4K source encoding at 0.3x real time — the audio
	// switch never played and never errored). If a chosen track makes no progress for AUDIO_STALL_MS, it's
	// the same failed OPTION onError handles: the file's own track, in place, with a message. Generous
	// because the server may be restarting the encode at a smaller size (adaptive downscale) meanwhile.
	var AUDIO_STALL_MS = 30000;
	function armAudioWatchdog() {
		if (activeAudio == null || fbStage !== 0 || audioWatchdog || exited) return;
		audioWatchdog = setTimeout(function () {
			audioWatchdog = null;
			if (!exited && activeAudio != null && fbStage === 0) revertAudio();
		}, AUDIO_STALL_MS);
	}
	function clearAudioWatchdog() { if (audioWatchdog) { clearTimeout(audioWatchdog); audioWatchdog = null; } }
	function revertAudio() {
		clearAudioWatchdog();
		activeAudio = null;
		// Where the viewer IS, if the chosen track played a while before starving; else where they switched
		// (a stream that never started has reset the clock to 0).
		pendingSeek = Math.max(switchAt, media.currentTime || 0);
		showMsg('Couldn’t switch audio track');
		setTimeout(hideMsg, 4000);
		setSource(pb.url);
		media.play();
	}
	async function transcodeThenPlay() {
		showMsg('Preparing this video for your TV…');
		const id = d.id;
		try {
			await client.requestTranscode(id);
			for (let i = 0; i < 200 && !exited && d.id === id; i++) {
				await sleep(3000);
				const st = await client.transcodeStatus(id).catch(() => null);
				if (st && st.status === 'ready') break;
				if (st && st.status === 'error') return showMsg('Couldn’t prepare this video.');
			}
			if (exited || d.id !== id) return;
			const fresh = await client.videoDetail(id);
			d = fresh; pb = fresh.playback || {};
			hideMsg();
			setSource(pb.compatUrl || pb.url);
		} catch (e) {
			showMsg('Couldn’t prepare this video.');
		}
	}

	// ---- watch state ----
	function onTime() {
		renderCue(); // our own subtitle painter (see loadCues) — <track> does not render here
		const dur = media.duration || 0;
		document.getElementById('cur').textContent = durationText(Math.floor(media.currentTime)) || '0:00';
		document.getElementById('fill').style.width = dur ? `${(media.currentTime / dur) * 100}%` : '0';
		const now = Date.now();
		if (now - lastSave > 15000) { lastSave = now; savePos(); }
		if (!marked && d.watchedAt && media.currentTime >= d.watchedAt) {
			marked = true;
			client.postWatch(d.id, { watched: true }).catch(() => {});
		}
	}
	function savePos() {
		// No `!marked` gate — positions flow regardless of the watched flag; the SERVER owns it
		// (contract §Rewatch): a watched episode reporting a real mid-video position flips back to
		// in-progress with the offset kept, so a rewatch resumes next open. This gate silently
		// starved that rule on this client (M8 field report 2026-08-18 — same leftover the web
		// player had). The >1s floor stays: instant exits aren't progress.
		if (media.currentTime > 1) client.postWatch(d.id, { position: media.currentTime }).catch(() => {});
	}

	// ---- autoplay-next / still-watching ----
	async function onEnded() {
		if (!marked) { marked = true; client.postWatch(d.id, { watched: true }).catch(() => {}); }
		// Contract §Movies: a film never autoplay-chains — end means end (the Related rail on the
		// detail is the path onward). Server-owned via channel_kind. ⇔ web/Android/Apple.
		if (d.channel_kind === 'movies') return exit();
		if (!prefs.autoplayNext) return exit();
		const next = await pickNext(d.id);
		if (exited) return;
		if (!next) return exit();
		// Check the count BEFORE this advance, so stillWatchingAfter=N prompts after N unattended advances
		// (⇔ tvOS/Android/web). Previously Tizen incremented first and prompted one video too early.
		if (prefs.stillWatchingAfter > 0 && advanceCount >= prefs.stillWatchingAfter) {
			media.pause();
			showNext(next, nextHtml(next, 'Are you still watching?', true));
		} else {
			let secs = UP_NEXT_SECS;
			// Countdown lives in the HEADER (⇔ tvOS/Android), so the button row is a clean two-choice.
			showNext(next, nextHtml(next, 'Up next in ' + secs + 's', false));
			countdown = setInterval(() => {
				secs--;
				const el = document.getElementById('pl-next-label');
				if (el) el.textContent = 'Up next in ' + secs + 's';
				if (secs <= 0) { clearInterval(countdown); advanceCount++; advanceTo(next); } // unattended → count it
			}, 1000);
		}
	}
	// One card for both end-of-video states (⇔ Android/web). The still-watching gate NAMES the next video
	// too — it used to only ask, so you couldn't see what you were saying yes to.
	// Thumbnail + title + channel, ⇔ the web end-card. The poster is MORE useful at 10 feet than on a
	// desktop — the title alone is thin when you're deciding whether to let it roll — so the TV clients
	// carry it too. `onerror` drops the img rather than leaving a broken-image box.
	function nextHtml(next, label, gate) {
		const thumb = client.sized(next.thumb, 480);
		// Two real buttons (⇔ tvOS/Android): primary + Stop, D-pad Left/Right between them, OK activates the
		// focused one (see onKey). tabindex so `.focus()` + the `.btn:focus` lift/outline work; system Back
		// still stops too. Replaces the old "OK to continue · Back to stop" TEXT, which named no reachable Stop.
		const primary = gate ? 'Continue' : 'Play now';
		return `<div class="pl-next-label" id="pl-next-label">${label}</div>
			<div class="pl-next-row">
				<div class="pl-next-thumb">${thumb ? `<img src="${thumb}" alt="" onerror="this.remove()">` : ''}</div>
				<div class="pl-next-meta">
					<div class="pl-next-title">${esc(next.title)}</div>
					<div class="pl-next-chan">${esc(next.channel_name || '')}</div>
				</div>
			</div>
			<div class="pl-next-btns">
				<div class="btn small" tabindex="0" id="pl-btn-play">${primary}</div>
				<div class="btn small" tabindex="0" id="pl-btn-stop">Stop</div>
			</div>`;
	}
	async function pickNext(id) {
		try {
			const items = (await client.related(id)).items || [];
			// Loop-guard (⇔ tvOS/Android): first unplayed-this-session-and-unwatched, else first unplayed, else
			// stop. Never fall back to items[0] — that can replay a watched neighbour and A↔B-loop forever.
			return items.find((v) => !playedIds.has(v.id) && !v.watched)
				|| items.find((v) => !playedIds.has(v.id))
				|| null;
		} catch (e) { return null; }
	}
	async function advanceTo(next) {
		clearInterval(countdown);
		hideNext();
		try {
			const det = await client.videoDetail(next.id);
			if (!exited) startVideo(det);
		} catch (e) { exit(); }
	}

	// ---- controls ----
	let hideTimer = null;
	// Subtitles on TV: no focusable controls exist in this overlay (playback is key-driven), and the
	// 2022 remotes have no colour keys to co-opt — so DOWN cycles tracks once the overlay is up, and
	// the overlay SAYS so. When a video has none the line still appears, greyed: "no subtitles" and
	// "this app can't do subtitles" must not look the same.
	function subsList() { return (d && d.playback && d.playback.subtitles) || []; }
	function updateSubsLabel() {
		var el = document.getElementById('plsubs');
		if (!el) return;
		var subs = subsList();
		if (!subs.length) {
			el.textContent = 'Subtitles: none available';
			el.className = 'pl-subs off';
			return;
		}
		var name = activeSub < 0 ? 'Off' : subs[activeSub].label;
		el.textContent = 'Subtitles: ' + name + '  (press \u25BC to change)';
		el.className = 'pl-subs' + (activeSub < 0 ? ' off' : '');
	}
	// AUDIO TRACKS. The <video> element plays whichever stream the container leads with and offers no
	// way to change it — so a different track means asking the SERVER to encode that stream
	// (`&a=<index>` on the HLS url, contract §Audio tracks) and re-sourcing here, resuming where we
	// were. Choosing the file's default goes back to direct play, which costs the server nothing.
	function audioList() { return (d && d.playback && d.playback.audioTracks) || []; }
	function canSwitchAudio() { return audioList().length > 1 && !!pb.hlsUrl; }

	function updateAudioLabel() {
		var el = document.getElementById('plaudio');
		if (!el) return;
		var list = audioList();
		if (!canSwitchAudio()) { el.textContent = ''; el.className = 'pl-audio off'; return; }
		var cur = null;
		for (var i = 0; i < list.length; i++) {
			if (activeAudio == null ? list[i].default : list[i].index === activeAudio) cur = list[i];
		}
		el.textContent = 'Audio: ' + ((cur && cur.label) || 'default') + '  (press \u25B2 to change)';
		el.className = 'pl-audio';
	}

	function cycleAudio() {
		var list = audioList();
		if (!canSwitchAudio()) return;
		var at = 0;
		for (var i = 0; i < list.length; i++) {
			if (activeAudio == null ? list[i].default : list[i].index === activeAudio) at = i;
		}
		var next = list[(at + 1) % list.length];
		switchAt = media.currentTime || 0;
		pendingSeek = switchAt;
		activeAudio = next.default ? null : next.index;
		// A viewer-chosen source, not a fallback rung — except a preferHls file, which must NEVER return
		// to the original (the default track is reached via hlsUrl without &a=, contract §preferHls).
		fbStage = preferHls() ? 2 : 0;
		clearHlsWatchdog();
		clearAudioWatchdog();
		setSource(!next.default || preferHls() ? hlsSrc() : pb.url); // the file's own track direct-plays; any other is encoded
		armAudioWatchdog(); // cleared by the first 'playing'; no-op when back on the file's own track
		media.play();
		showOverlay();
	}

	function cycleSubs() {
		var subs = subsList();
		if (!subs.length) return;
		activeSub = activeSub + 1 >= subs.length ? -1 : activeSub + 1; // … → last → Off → first → …
		loadCues(activeSub);
		updateSubsLabel();
		showOverlay();
	}

	function showOverlay() { overlay.classList.add('show'); clearTimeout(hideTimer); hideTimer = setTimeout(() => overlay.classList.remove('show'), 3500); }
	function togglePlay() { if (media.paused) media.play(); else media.pause(); showOverlay(); advanceCount = 0; }
	function seek(delta) { media.currentTime = Math.max(0, Math.min(media.duration || 0, media.currentTime + delta)); showOverlay(); advanceCount = 0; }
	function showMsg(m) { const el = document.getElementById('plmsg'); if (el) { el.textContent = m; el.classList.remove('hidden'); } }
	function hideMsg() { const el = document.getElementById('plmsg'); if (el) el.classList.add('hidden'); }
	function showNext(next, html) {
		nextCard._next = next; nextCard.innerHTML = html; nextCard.classList.remove('hidden');
		const play = document.getElementById('pl-btn-play'); // primary focused by default (⇔ tvOS/Android)
		if (play) play.focus();
	}
	function hideNext() { nextCard.classList.add('hidden'); nextCard.innerHTML = ''; nextCard._next = null; clearInterval(countdown); }

	function onKey(e) {
		if (!nextCard.classList.contains('hidden')) { // up-next / still-watching card is up
			const af = document.activeElement;
			if (e.keyCode === 13) { // OK → activate the FOCUSED button
				if (af && af.id === 'pl-btn-stop') exit(); // Stop → end the run (⇔ Back)
				else { advanceCount = 0; advanceTo(nextCard._next); } // Play now / Continue
			} else if (e.keyCode === 39) { const s = document.getElementById('pl-btn-stop'); if (s) s.focus(); } // Right → Stop
			else if (e.keyCode === 37) { const p = document.getElementById('pl-btn-play'); if (p) p.focus(); } // Left → primary
			else if (e.keyCode === 10009 || e.keyCode === 27) exit(); // Back → stop (always)
			e.preventDefault(); e.stopPropagation();
			return;
		}
		switch (e.keyCode) {
			case 13: case 10252: case 415: case 19: togglePlay(); break; // OK / PlayPause / Play / Pause
			case 37: case 412: seek(-10); break; // Left / Rewind
			case 39: case 417: seek(10); break; // Right / FastForward
			case 38: // Up → reveal the transport bar, and cycle AUDIO once it's already visible
				if (overlay.classList.contains('show')) cycleAudio();
				else showOverlay();
				break;
			case 40: // Down → reveal it, and cycle subtitles once it's already visible
				if (overlay.classList.contains('show')) cycleSubs();
				else showOverlay();
				break;
			case 10009: case 27: exit(); break; // Return/Back / Escape
			default: return;
		}
		e.preventDefault();
		e.stopPropagation();
	}

	function exit() {
		if (exited) return;
		exited = true;
		clearInterval(countdown);
		clearAudioWatchdog();
		savePos();
		document.removeEventListener('keydown', onKey, true);
		media.destroy();
		// Contract: leaving lands on the CURRENT (last-played) video's detail, not the launched-from one.
		// `d` is the video playing right now (advanced by startVideo/advanceTo), so hand its id to the nav
		// layer, which re-renders that detail IN PLACE of the launched-from detail (see browse.js).
		onExit(d && d.id);
	}
}

function esc(s) {
	return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
