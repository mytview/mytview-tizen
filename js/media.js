// The playback ENGINE facade — one surface, two implementations, chosen per device at player mount:
//
//  - avMedia: Samsung's NATIVE player (webapis.avplay) — the same decoder path Plex/Jellyfin use.
//    The HTML5 <video> pipeline on older panels is a NARROWER door to the same silicon: the field
//    case (Q7FN 2018, HEVC+E-AC3 episode, 2026-09-18) direct-played with a perfect media clock and
//    zero errors while the PICTURE stuttered and macroblocked — and every observable channel
//    (frame stats, stall events, canvas taps) reported a healthy world, so no client code could
//    even DETECT it. AVPlay gets the full decoder AND has real error callbacks.
//  - htmlMedia: the field-debugged <video> element — kept byte-for-byte in behavior as the
//    fallback for desktop previews (no webapis) and as the safety net if AVPlay ever regresses.
//
// The facade exposes exactly what player.js consumes: the <video> event names (loadedmetadata,
// canplay, playing, waiting, stalled, timeupdate, pause, ended, error), currentTime get/set,
// duration, paused, errorCode (MediaError-shaped: 2 network-ish / 3 decode-ish — the fail-open
// ladder's contract), setSrc, play, pause, destroy.

// Debug surface for the sdb/CDP loop: window.__media carries the engine, every opened URL, and
// raw engine callbacks with timestamps — the <video>-element probes went blind with AVPlay.
function trace(kind, detail) {
	try {
		var m = (window.__media = window.__media || { events: [] });
		m.events.push([Date.now(), kind, detail == null ? '' : String(detail).slice(0, 300)]);
		if (m.events.length > 400) m.events.shift();
	} catch (e) {}
}

export function createMedia(root, forceHtml) {
	var hasAv = !forceHtml && !!(window.webapis && window.webapis.avplay);
	trace('engine', hasAv ? 'avplay' : 'video');
	return hasAv ? avMedia(root) : htmlMedia(root);
}

function htmlMedia(root) {
	var v = document.createElement('video');
	v.id = 'video';
	v.setAttribute('playsinline', '');
	v.setAttribute('aria-label', 'Video player');
	root.insertBefore(v, root.firstChild);
	return {
		engine: 'video',
		on: function (t, fn) { v.addEventListener(t, fn); },
		get currentTime() { return v.currentTime || 0; },
		set currentTime(s) { try { v.currentTime = s; } catch (e) {} },
		get duration() { return v.duration || 0; },
		get paused() { return v.paused; },
		get errorCode() { return v.error ? v.error.code : 0; },
		setSrc: function (url) { v.src = url; v.load(); },
		play: function () { try { var p = v.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {} },
		pause: function () { try { v.pause(); } catch (e) {} },
		destroy: function () {
			try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {}
			if (v.parentNode) v.parentNode.removeChild(v);
		}
	};
}

function avMedia(root) {
	var av = window.webapis.avplay;
	// The video renders in a HARDWARE PLANE behind the browser surface: the <object> reserves the
	// spot, and .avplay-mode (app.css) makes everything above it transparent — an opaque background
	// anywhere in the chain paints over the picture (the classic Tizen AVPlay gotcha).
	var obj = document.createElement('object');
	obj.type = 'application/avplayer';
	obj.id = 'avobj';
	root.insertBefore(obj, root.firstChild);
	document.documentElement.classList.add('avplay-mode');

	var handlers = {};
	var timeMs = 0, timeWall = 0, durMs = 0;
	var playing = false, prepared = false, destroyed = false, lastErr = 0, ticker = null;
	function emit(t) { var hs = handlers[t] || []; for (var i = 0; i < hs.length; i++) { try { hs[i](); } catch (e) {} } }
	// oncurrentplaytime ticks ~1Hz; interpolate against the wall clock while playing so the cue
	// painter and the transport bar stay as smooth as the <video> engine's ~4Hz timeupdate.
	function nowTime() {
		var s = timeMs / 1000;
		if (playing) s += (Date.now() - timeWall) / 1000;
		return s > 0 ? s : 0;
	}
	// Fail-open mapping (contract): network-ish failures → 2 (an honest error on the original);
	// everything else → 3 (decode-ish, the ladder advances). AVPlay reports strings, not codes.
	function mapError(e) {
		var s = String((e && (e.name || e.message)) || e || '');
		return /CONNECTION|NO_SUCH|URI|NETWORK/i.test(s) ? 2 : 3;
	}
	function listener() {
		return {
			onbufferingstart: function () { trace('bufferingstart'); emit('waiting'); },
			onbufferingcomplete: function () { trace('bufferingcomplete'); emit('playing'); },
			oncurrentplaytime: function (ms) { timeMs = ms; timeWall = Date.now(); emit('timeupdate'); },
			onstreamcompleted: function () { trace('streamcompleted'); playing = false; emit('ended'); },
			onerror: function (e) { trace('error', e && (e.name || e.message) || e); lastErr = mapError(e); playing = false; emit('error'); },
			onevent: function () {}, onsubtitlechange: function () {}, ondrmevent: function () {}
		};
	}
	function open(url) {
		trace('open', url);
		try { av.stop(); } catch (e) {}
		try { av.close(); } catch (e) {}
		prepared = false; playing = false; lastErr = 0; timeMs = 0; timeWall = Date.now();
		try {
			av.open(url);
			av.setListener(listener());
			try { av.setDisplayRect(0, 0, 1920, 1080); } catch (e) {} // stage-native panel coords (scale=1 on the set)
			try { av.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX'); } catch (e) {}
			av.prepareAsync(function () {
				trace('prepared');
				if (destroyed) return;
				prepared = true;
				try { durMs = av.getDuration() || 0; } catch (e) { durMs = 0; }
				emit('loadedmetadata');
				emit('canplay');
				try { av.play(); playing = true; timeWall = Date.now(); startTicker(); emit('playing'); }
				catch (e) { lastErr = mapError(e); emit('error'); }
			}, function (e) {
				trace('prepare-fail', e && (e.name || e.message) || e);
				if (!destroyed) { lastErr = mapError(e); emit('error'); }
			});
		} catch (e) {
			trace('open-throw', e && (e.name || e.message) || e);
			lastErr = mapError(e);
			setTimeout(function () { if (!destroyed) emit('error'); }, 0);
		}
	}
	function startTicker() {
		if (!ticker) ticker = setInterval(function () { if (playing) emit('timeupdate'); }, 250);
	}
	return {
		engine: 'avplay',
		on: function (t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
		get currentTime() { return nowTime(); },
		set currentTime(s) {
			var ms = Math.round(s * 1000);
			if (ms < 0) ms = 0;
			timeMs = ms; timeWall = Date.now(); // optimistic — tryResume's "did it take" check reads this back
			try { av.seekTo(ms, function () {}, function () {}); } catch (e) {}
		},
		get duration() { return durMs / 1000; },
		get paused() { return !playing; },
		get errorCode() { return lastErr; },
		setSrc: open,
		play: function () {
			if (!prepared) return; // prepareAsync's success callback starts playback itself
			try { av.play(); playing = true; timeWall = Date.now(); startTicker(); emit('playing'); } catch (e) {}
		},
		pause: function () {
			try { av.pause(); } catch (e) {}
			playing = false;
			emit('pause');
		},
		destroy: function () {
			destroyed = true;
			if (ticker) { clearInterval(ticker); ticker = null; }
			try { av.stop(); } catch (e) {}
			try { av.close(); } catch (e) {}
			document.documentElement.classList.remove('avplay-mode');
			if (obj.parentNode) obj.parentNode.removeChild(obj);
		}
	};
}
