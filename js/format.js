// Shared display formatting — the JS mirror of MytViewKit `Format.swift` + `core/model/Format.kt`, so
// counts/dates/durations render identically across clients. Counts are bare (no unit); the caller
// appends "views"/"likes". The /api/v1 video fields are snake_case (view_count, upload_date, …).

export function abbreviateCount(n) {
	if (n == null || n <= 0) return null;
	const trim = (v, suffix) => {
		const s = v.toFixed(1);
		return (s.endsWith('.0') ? s.slice(0, -2) : s) + suffix;
	};
	if (n >= 1e6) return trim(n / 1e6, 'M');
	if (n >= 1e3) return trim(n / 1e3, 'K');
	return String(n);
}

export function durationText(seconds) {
	if (seconds == null || seconds <= 0) return null;
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	const p = (x) => (x < 10 ? '0' + x : '' + x); // NOT padStart: it's Chromium 57, and Tizen 4.0 is ~Cr56
	return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

export function mediumDate(uploadDate, timestamp) {
	let d = null;
	if (timestamp && timestamp > 0) d = new Date(timestamp * 1000);
	else if (uploadDate && /^\d{8}$/.test(uploadDate)) {
		d = new Date(+uploadDate.slice(0, 4), +uploadDate.slice(4, 6) - 1, +uploadDate.slice(6, 8));
	}
	if (!d || isNaN(d.getTime())) return null;
	return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Series episode label — mirrors the pinned `fmtEpisode` (Format.swift / api-client-contract): both
 *  present → "S1·E2" (separator is a middle dot, U+00B7); episode only → "E2"; season only → "S1"; neither
 *  → null. No padStart — the numbers render as-is (S1·E2, not S01·E02), matching every client. */
export function episodeLabel(season, episode) {
	const s = season != null ? 'S' + season : '';
	const e = episode != null ? 'E' + episode : '';
	if (s && e) return s + '·' + e;
	return s || e || null;
}

/** "11.3K views · 613 likes · Jul 14, 2026 · 19:27" from a detail object (snake_case fields). */
export function metaLine(d) {
	// Movies (contract §Movies, ⇔ web/Android/Apple): year · runtime — film NFOs carry no views/likes,
	// and a movie's timestamp is its ADDED date (feed ordering), not a display date.
	if (d.channel_kind === 'movies') {
		return [d.year, durationText(d.duration)].filter(Boolean).join(' · ');
	}
	const views = abbreviateCount(d.view_count);
	const likes = abbreviateCount(d.like_count);
	return [
		views && `${views} views`,
		likes && `${likes} likes`,
		mediumDate(d.upload_date, d.timestamp),
		durationText(d.duration),
	].filter(Boolean).join(' · ');
}
