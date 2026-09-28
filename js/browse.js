// Slice 2 — the authenticated browse shell (tabs), grids, channel/video detail, tag feed, and Settings,
// mirroring the tvOS reference against /api/v1. Spatial focus comes from nav.js. Wire shapes per the
// contract: videos {items,page:{nextOffset}}, channels {items}, channel/[id] {channel,videos},
// related {items}. Playback (the Play button) arrives in Slice 3.

import * as nav from './nav.js';
import { metaLine, durationText, abbreviateCount, episodeLabel } from './format.js';
import { playDetail } from './player.js';

const app = document.getElementById('app');
const PROMOTE_MAX = 5; // library tab promotion cap — per-platform FIT calibration (⇔ tvOS 5 / GTV 5)

/** The top-bar model (⇔ tvOS TVRootView / GTV Skeleton): 2..PROMOTE_MAX libraries PROMOTE into the
 *  bar, each landing straight on its grid or wall; outside that range the single Library tab with
 *  the inner libbar stands. Rebuilt whenever the library set changes (refreshLibraries). */
function tabList() {
	const libs = librariesCache || [];
	if (libs.length >= 2 && libs.length <= PROMOTE_MAX) {
		return [{ label: 'Recent', kind: 'recent' }]
			.concat(libs.map((l) => ({ label: cap(l.name), kind: 'lib', lib: l })))
			.concat([{ label: 'Search', kind: 'search' }, { label: 'Settings', kind: 'settings' }]);
	}
	return [
		{ label: 'Recent', kind: 'recent' },
		{ label: 'Library', kind: 'library' },
		{ label: 'Search', kind: 'search' },
		{ label: 'Settings', kind: 'settings' },
	];
}

let session = null;
let client = null;
let currentTab = 0;
let userPrefs = { autoplayNext: true, stillWatchingAfter: 3 }; // cached for the player's autoplay / still-watching
let browsePrefs = {}; // per-LIBRARY saved sort+genre (contract §Browse persistence), keyed by String(libId)
let currentLibrary = null; // selected library id in the Channels tab (null = all / no libraries configured)
let librariesCache = null; // fetched once from /api/v1/libraries (empty array = none, or none visible)

// ---- browse persistence (contract §Browse persistence) -------------------------------------------
// The library's saved sort+genre is a USER preference: applied when the grid/wall opens, written on
// every change, synced non-blocking on entry so a choice made on another device lands here in
// seconds. An entry REPLACES that library's state whole; both-at-defaults clears it.

function browsePref(libId) {
	return libId == null ? null : browsePrefs[String(libId)] || null;
}

function saveBrowsePref(libId, sort, genre, defaultSort) {
	if (libId == null) return;
	const key = String(libId);
	let entry = null;
	if ((sort && sort !== defaultSort) || genre) {
		entry = {};
		if (sort && sort !== defaultSort) entry.sort = sort;
		if (genre) entry.genre = genre;
	}
	if (entry) browsePrefs[key] = entry;
	else delete browsePrefs[key]; // local cache mirrors the server's library-level merge
	const patch = { browse: {} };
	patch.browse[key] = entry;
	client.updatePrefs(patch).catch(() => {});
}

/** Entry sync: refresh the map in the background and hand the CURRENT surface a chance to re-apply
 *  (grids open instantly on the cached state — the fetch must never sit in the open path). */
function syncBrowsePrefs(onFresh) {
	client
		.me()
		.then((me) => {
			if (me && me.prefs) {
				userPrefs = me.prefs;
				browsePrefs = me.prefs.browse || {};
			}
			if (onFresh) onFresh();
		})
		.catch(() => {});
}

/** Re-render helper for a background re-apply: keep the viewer's focus where it was (the innerHTML
 *  rebuild destroys the focused node — the die-on-body trap every interactive path already avoids). */
function refocusAfter(rerender) {
	const key = focusKeyOf(document.activeElement);
	rerender();
	const el = key && document.querySelector(key);
	if (el) el.focus();
}

// Back-navigation stack: navTo() remembers the screen you're leaving, so Back pops ONE level (channel→video
// →Back returns to the channel) instead of always jumping to root. `currentScreen` re-renders wherever you
// are; an empty stack at the root → Back exits the app (⇔ tvOS/Android). Every screen sets nav.setBack(handleBack).
const backStack = [];
let currentScreen = () => drawShell();
let pendingFocusKey = null; // on Back, the selector of the item to re-focus on the screen we return to
function navTo(render) {
	backStack.push({ render: currentScreen, key: focusKeyOf(document.activeElement) }); // remember where + WHAT was focused
	pendingFocusKey = null; // forward nav — no restore
	clearBrowseUi(); // the panel + sliver belong to the grid screen being left
	render();
}
function handleBack() {
	const entry = backStack.pop();
	if (!entry) return exitApp();
	pendingFocusKey = entry.key; // Back → re-focus the item we left from
	clearBrowseUi();
	entry.render();
}
function exitApp() {
	// exit() is the Samsung-documented termination; window.close() is the fallback if the Tizen API
	// is unavailable or throws — Return at the root must NEVER be a no-op (Return-key policy).
	try { window.tizen.application.getCurrentApplication().exit(); return; } catch (e) {}
	try { window.close(); } catch (e) {}
}
/** A stable selector for a focusable so Back can re-focus it after the screen re-renders (cards survive by id). */
function focusKeyOf(el) {
	if (el && el.dataset && el.dataset.video != null) return `.card[data-video="${el.dataset.video}"]`;
	if (el && el.dataset && el.dataset.channel != null) return `.card[data-channel="${el.dataset.channel}"]`;
	return el && el.id ? `#${el.id}` : null;
}
/** Focus the pending (Back) target if present on this screen, else the default; consumes the pending key. */
function focusRestore(defaultSel) {
	const key = pendingFocusKey;
	pendingFocusKey = null;
	if (key) {
		const el = document.querySelector(key);
		if (el) { el.focus(); nav.reveal(el); return; }
	}
	if (defaultSel) nav.focusFirst(defaultSel);
}

export function renderShell(sess) {
	session = sess;
	client = sess.client();
	currentTab = 0;
	pendingFocusKey = null;
	drawShell();
	client
		.me()
		.then((me) => {
			if (me && me.prefs) {
				userPrefs = me.prefs;
				browsePrefs = me.prefs.browse || {}; // warm cache: first Library entry opens on saved state
			}
		})
		.catch(() => {});
	refreshLibraries();
}

/** Fetch the library set for tab promotion; rebuild the bar only when it actually changed (the
 *  redraw resets focus to the selected tab — a no-op refresh must not disturb the viewer). */
function refreshLibraries() {
	client
		.libraries()
		.then((r) => {
			const items = (r && r.items) || [];
			const sig = (ls) => JSON.stringify(ls.map((l) => [l.id, l.name, l.format]));
			const changed = sig(items) !== sig(librariesCache || []);
			librariesCache = items;
			if (items.length > 1 && currentLibrary == null) currentLibrary = items[0].id;
			if (changed) drawShell();
		})
		.catch(() => {});
}

function drawShell() {
	const list = tabList();
	if (currentTab >= list.length) currentTab = 0; // the tab set can shrink (library removed)
	const tabs = list
		.map(
			(t, i) => `<div class="tab focusable${i === currentTab ? ' sel' : ''}" tabindex="0" role="tab" aria-selected="${i === currentTab}" data-tab="${i}">${esc(t.label)}</div>`,
		)
		.join('');
	app.innerHTML = `<div class="shell"><div class="tabbar" role="tablist" aria-label="Sections">${tabs}</div><div class="content" id="content" role="main"></div></div>`;
	app.querySelectorAll('.tab').forEach((el) => el.addEventListener('focus', () => selectTab(+el.dataset.tab)));
	currentScreen = () => drawShell();
	backStack.length = 0; // root — clear history; Back here exits the app
	nav.setBack(handleBack);
	renderTab(currentTab);
	nav.focusFirst('.tab.sel');
}

function selectTab(i) {
	if (i === currentTab) return;
	pendingFocusKey = null; // switching tabs is a fresh nav, not a Back-restore
	currentTab = i;
	app.querySelectorAll('.tab').forEach((el) => el.classList.toggle('sel', +el.dataset.tab === i));
	renderTab(i);
}

function renderTab(i) {
	const content = document.getElementById('content');
	content.innerHTML = '';
	clearBrowseUi(); // only the grid surfaces mount it (channelsGrid)
	const tab = tabList()[i] || { kind: 'recent' };
	if (tab.kind === 'recent') recentView(content);
	else if (tab.kind === 'library') channelsGrid(content);
	else if (tab.kind === 'lib') channelsGrid(content, tab.lib); // promoted: straight to its grid/wall
	else if (tab.kind === 'search') searchView(content);
	else if (tab.kind === 'settings') settingsView(content);
}

/** Recent feed. NO Show-watched control on TV (owner decision 2026-09-20: with the library grids'
 *  panel carrying sort/genre/reveal, a reveal on the feed reads as redundant — this was the only TV
 *  client that had one; web/mobile keep theirs, presentation follows the input model). autoFocus=false
 *  so selecting the tab doesn't yank focus off the tab bar into the grid (you arrow down to enter). */
function recentView(content) {
	content.innerHTML = `<div id="feedwrap"></div>`;
	feedGrid(document.getElementById('feedwrap'), (offset) => client.videos({ offset }), {
		autoFocus: false,
		// Distinguish a first-run scan from a truly-empty library (⇔ tvOS/Android), via /api/v1/status.
		emptyMsg: async () => {
			try { const s = await client.status(); if (s && (s.scanning || !s.everScanned)) return 'Indexing your library…'; } catch (e) {}
			return 'Nothing here yet.';
		},
	});
}

// ---- grids -------------------------------------------------------------------------------------

/** A paginated video grid that loads more when focus nears the end (⇔ FeedStore + VideoGrid).
 *  `autoFocus=false` for search, so results don't steal focus from the query field mid-type. */
async function feedGrid(container, fetchPage, opts = {}) {
	const { autoFocus = true, showsWatched = false, emptyMsg = 'Nothing here yet.' } = opts;
	// data-hide-watched drives mark-watched-from-grid live-hide per view (Recent/channel own their own state).
	container.innerHTML = `<div class="grid" id="grid" data-hide-watched="${showsWatched ? '0' : '1'}"></div>`;
	const grid = container.querySelector('#grid');
	const st = { offset: 0, loading: false, done: false };
	async function more() {
		if (st.loading || st.done) return;
		st.loading = true;
		try {
			const page = await fetchPage(st.offset);
			const items = page.items || [];
			grid.insertAdjacentHTML('beforeend', items.map(videoCard).join(''));
			wireVideoCards(grid);
			const next = page.page ? page.page.nextOffset : null;
			if (next == null) st.done = true;
			else st.offset = next;
			if (!grid.children.length) {
				const msg = typeof emptyMsg === 'function' ? await emptyMsg() : emptyMsg; // e.g. "Indexing…" vs "Nothing here"
				grid.innerHTML = `<div class="empty muted">${msg}</div>`;
			}
		} catch (e) {
			if (!grid.querySelector('.card')) grid.innerHTML = `<div class="empty muted">Couldn't load.</div>`;
		} finally {
			st.loading = false;
		}
	}
	grid.addEventListener('focusin', (e) => {
		const cards = grid.querySelectorAll('.card');
		const card = e.target.closest('.card');
		if (!card) return;
		if (Array.prototype.indexOf.call(cards, card) >= cards.length - 8) more();
	});
	await more();
	focusRestore(autoFocus ? '#grid .card' : null); // Back → the card you left from; else the default
}

async function channelsGrid(container, fixedLib) {
	// `fixedLib` pins the grid to ONE promoted library (its top tab) — no inner selector (⇔ tvOS
	// fixedLibrary / GTV promoted tabs). Without it: >1 library → a selector row (mirrors the web
	// tabs / Apple picker); 0-1 → the grid is the whole (single) library, no selector.
	if (librariesCache == null) {
		try { librariesCache = (await client.libraries()).items || []; } catch (e) { librariesCache = []; }
		if (librariesCache.length > 1 && currentLibrary == null) currentLibrary = librariesCache[0].id;
	}
	const libs = librariesCache;
	const multi = !fixedLib && libs.length > 1;
	const libBar = multi
		? `<div class="libbar">${libs.map((l) =>
			`<div class="libtab focusable${l.id === currentLibrary ? ' active' : ''}" tabindex="0" role="button" data-lib="${l.id}">${esc(cap(l.name))}</div>`).join('')}</div>`
		: '';
	// Contract §Movies: a movies library's tab lands STRAIGHT on its poster wall — never a channels
	// grid holding the one synthetic tile (⇔ web/Android/Apple inline walls).
	const curLib = fixedLib || (multi ? libs.find((l) => l.id === currentLibrary) : null);
	const isMoviesLib = !!(curLib && curLib.format === 'movies');
	container.innerHTML = libBar +
		`<div class="grid ${isMoviesLib ? 'movies' : 'channels'}" id="grid"></div>`;
	// Library chips select on FOCUS, not on OK (owner decision 2026-08-18 — ⇔ the tvOS segmented
	// picker, and our own top tabs): landing on a chip IS choosing that library. The accepted cost:
	// walking the bar flips libraries as you pass. Guard on the current id, else the refocus after
	// re-render would loop. (A mouse click focuses first, so click needs no handler of its own.)
	container.querySelectorAll('.libtab[data-lib]').forEach((el) =>
		el.addEventListener('focus', () => {
			if (+el.dataset.lib === currentLibrary) return;
			currentLibrary = +el.dataset.lib;
			// channelsGrid re-renders the libbar synchronously (before its first await), destroying the
			// focused chip — refocus the newly-active one, else focus dies on <body> and the next arrow
			// press recovers to the top of the page (⇔ the watchedToggle re-render does the same).
			channelsGrid(container);
			nav.focusFirst('.libtab.active');
		}));
	const grid = container.querySelector('#grid');
	if (isMoviesLib) {
		// The wall hides watched movies by default SERVER-side (contract §Movies since the 2026-08-12
		// reversal) — the count and the tiles agree because both are the response. `Show watched` is a
		// REFETCH with ?watched=1, and the control appears only when it has something to reveal.
		let wall;
		let all = [];
		let genres = [];
		let wallWatched = false;
		let wallHidden = 0;
		let wallControl = false; // sticky once shown — same vanish-on-toggle-back trap as the shows grid
		async function loadWall() {
			wall = await client.channel('movies:' + curLib.id, wallWatched);
			all = wall.videos || [];
			genres = (wall.channel && wall.channel.genres) || [];
			wallHidden = wallWatched
				? 0
				: Math.max(0, ((wall.channel && wall.channel.video_count) || all.length) - all.length);
			wallControl = wallControl || wallHidden > 0 || wallWatched;
		}
		try {
			await loadWall();
		} catch (e) {
			grid.innerHTML = `<div class="empty muted">Couldn't load.</div>`;
			return;
		}
		// LOCAL sort + genre over the fully-delivered wall (contract §Movies invariant): a cycling sort
		// button + the genre picker, in one row (⇔ tvOS TVMoviesWall). Both open on the library's
		// SAVED state (§Browse persistence); a saved genre matching nothing here must not filter —
		// its picker option is absent, so an applied-but-invisible filter would blank the wall.
		const wallPref = browsePref(curLib.id);
		let sortKey = wallPref && ['title', 'year', 'added'].indexOf(wallPref.sort) >= 0 ? wallPref.sort : 'title';
		let genre = (wallPref && wallPref.genre) || null;
		if (genre && genres.indexOf(genre) < 0) genre = null; // effective-genre guard (stored pref untouched)
		let wallTouched = false; // a background sync must never override what the viewer JUST set
		const byTitle = (a, b) => (a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1);
		function currentList() {
			let items = genre ? all.filter((v) => (v.genres || []).indexOf(genre) >= 0) : all.slice();
			if (sortKey === 'year') items.sort((a, b) => (b.year || 0) - (a.year || 0) || byTitle(a, b));
			else if (sortKey === 'added') items.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0) || byTitle(a, b));
			else items.sort(byTitle);
			return items;
		}
		// The wall is delivered COMPLETE (contract §Movies — that invariant is about the DATA, so sort
		// and genre stay local), but it is RENDERED in chunks: one innerHTML of the whole collection put
		// ~1,600 tiles + posters in the DOM at once, and every D-pad press then measured every tile's
		// rect in the spatial nav — the one big movies library navigated visibly laggier than every
		// other (M8 field report 2026-08-18). Chunks keep the DOM bounded to what the viewer is near;
		// more rows append as focus approaches the end, same pattern as feedGrid's paging.
		const WALL_CHUNK = 90; // 15 rows of 6 — well ahead of the cursor, cheap to render
		let wallList = [];
		let wallDrawn = 0;
		function appendWallChunk() {
			if (wallDrawn >= wallList.length) return;
			const next = wallList.slice(wallDrawn, wallDrawn + WALL_CHUNK);
			wallDrawn += next.length;
			grid.insertAdjacentHTML('beforeend', next.map(movieCard).join(''));
			wireVideoCards(grid); // _wired guard makes re-wiring appended cards safe
		}
		function renderWall() {
			wallList = currentList();
			wallDrawn = 0;
			grid.innerHTML = '';
			if (!wallList.length) { grid.innerHTML = `<div class="empty muted">No movies.</div>`; return; }
			appendWallChunk();
		}
		grid.addEventListener('focusin', (e) => {
			const card = e.target.closest('.card');
			if (!card) return;
			const cards = grid.querySelectorAll('.card');
			if (Array.prototype.indexOf.call(cards, card) >= cards.length - 18) appendWallChunk(); // ~3 rows out
		});
		// The §Browse-controls set lives in the LEFT PANEL (setBrowseUi — docs/tv-browse-panel-blueprint.md),
		// not in a row above the wall: this is the surface's state + actions; the panel keeps the viewer's
		// focus on the control they used, and the wall re-renders behind it.
		function renderControls() {
			setBrowseUi({
				count: countLabel(currentList().length, 'movies'),
				genres: genres, genre: genre,
				sortLabel: sortLabel(sortKey), sortIsDefault: sortKey === 'title',
				watchedLabel: wallControl ? (wallWatched ? 'Hide watched' : 'Show watched') : null,
				showWatched: wallWatched,
				onSortNext: function () {
					sortKey = nextSort(sortKey);
					wallTouched = true;
					saveBrowsePref(curLib.id, sortKey, genre, 'title');
					renderControls();
					renderWall();
				},
				onGenre: function (g) {
					genre = g;
					wallTouched = true;
					saveBrowsePref(curLib.id, sortKey, genre, 'title');
					renderControls();
					renderWall();
				},
				onToggleWatched: async function () {
					wallWatched = !wallWatched;
					renderControls(); // label first — the refetch is a network hop
					try { await loadWall(); } catch (e) {
						wallWatched = !wallWatched; // fetch failed — the wall on screen is still the OLD set
						renderControls();
						return;
					}
					renderControls();
					renderWall();
				}
			});
		}
		renderControls();
		renderWall();
		focusRestore(null);
		// Entry sync (§Browse persistence): a change made on another device re-applies within a
		// second of opening the wall — unless the viewer already touched the controls here.
		syncBrowsePrefs(() => {
			if (wallTouched) return;
			const p = browsePref(curLib.id);
			const s = p && ['title', 'year', 'added'].indexOf(p.sort) >= 0 ? p.sort : 'title';
			let g = (p && p.genre) || null;
			if (g && genres.indexOf(g) < 0) g = null;
			if (s === sortKey && g === genre) return;
			sortKey = s;
			genre = g;
			refocusAfter(() => { renderControls(); renderWall(); });
		});
		return;
	}
	// Shows/channels grid. Genre filters LOCALLY; SORT is a refetch — the keys (`updated`, `unwatched`)
	// are server-owned orderings the payload can't reproduce (contract §Browse controls). Both open
	// on the library's SAVED state (§Browse persistence). The persistence key is the library —
	// including the lone library of a single-library setup (⇔ tvOS 2026-09-17 fix); only the
	// zero-library legacy view has nothing to key on.
	const persistLib = curLib ? curLib.id : libs.length === 1 ? libs[0].id : null;
	const gridPref = browsePref(persistLib);
	let items = [];
	let showGenres = [];
	let showsGenre = (gridPref && gridPref.genre) || null; // loadChannels()'s option guard vets it
	let channelSort =
		gridPref && ['name', 'updated', 'unwatched'].indexOf(gridPref.sort) >= 0 ? gridPref.sort : 'name';
	let gridTouched = false; // a background sync must never override what the viewer JUST set
	let showWatchedGrid = false; // reveal server-hidden fully-watched shows (contract §channels)
	let watchedHidden = 0;
	// STICKY once shown: while revealing everything the response hides nothing (watchedHidden=0), so a
	// naive per-render condition made the button VANISH on "Hide watched" — and the focus restore then
	// fell through to the first focusable on the page, the Recent tab, which selects on focus (M8
	// field report 2026-08-18: toggling back teleported to Recent).
	let watchedControl = false;
	const libFormat = curLib ? curLib.format : 'channels';

	async function loadChannels() {
		const resp = await client.channels(curLib ? curLib.id : undefined, channelSort, showWatchedGrid);
		items = resp.items || [];
		watchedHidden = resp.watchedHidden || 0;
		watchedControl = watchedControl || watchedHidden > 0 || showWatchedGrid;
		// Genre options come from what the server delivered, so a sort never changes the option list.
		showGenres = [];
		items.forEach((c) => (c.genres || []).forEach((g) => { if (showGenres.indexOf(g) < 0) showGenres.push(g); }));
		showGenres.sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
		if (showsGenre && showGenres.indexOf(showsGenre) < 0) showsGenre = null;
	}
	function shownChannels() {
		return showsGenre ? items.filter((c) => (c.genres || []).indexOf(showsGenre) >= 0) : items;
	}
	function renderChannels() {
		grid.innerHTML = shownChannels().map(channelCard).join('') || `<div class="empty muted">No channels.</div>`;
		grid.querySelectorAll('.card[data-channel]').forEach((el) =>
			el.addEventListener('click', () => navTo(() => showChannelDetail(el.dataset.channel))),
		);
	}
	// The §Browse-controls set lives in the LEFT PANEL (setBrowseUi — docs/tv-browse-panel-blueprint.md):
	// state + actions for this grid; the panel keeps focus on the control used, the grid updates behind.
	function renderControls() {
		setBrowseUi({
			count: countLabel(shownChannels().length, libFormat),
			genres: showGenres, genre: showsGenre,
			sortLabel: channelSortLabel(channelSort), sortIsDefault: channelSort === 'name',
			watchedLabel: watchedControl ? (showWatchedGrid ? 'Hide watched' : 'Show watched') : null,
			showWatched: showWatchedGrid,
			onSortNext: async function () {
				const prev = channelSort;
				channelSort = nextChannelSort(channelSort);
				gridTouched = true;
				renderControls(); // label first — the refetch is a network hop, and a dead button reads as broken
				try { await loadChannels(); } catch (e) {
					channelSort = prev; // the fetch failed — the list is still in the OLD order, say so
					renderControls();
					return;
				}
				saveBrowsePref(persistLib, channelSort, showsGenre, 'name'); // persist only what actually applied
				renderControls();
				renderChannels();
			},
			onGenre: function (g) {
				showsGenre = g;
				gridTouched = true;
				saveBrowsePref(persistLib, channelSort, showsGenre, 'name');
				renderControls();
				renderChannels();
			},
			onToggleWatched: async function () {
				showWatchedGrid = !showWatchedGrid;
				renderControls(); // label first — the refetch is a network hop
				try { await loadChannels(); } catch (e) {
					showWatchedGrid = !showWatchedGrid; // fetch failed — the grid still shows the OLD set
					renderControls();
					return;
				}
				renderControls();
				renderChannels();
			}
		});
	}

	try {
		await loadChannels();
	} catch (e) {
		grid.innerHTML = `<div class="empty muted">Couldn't load.</div>`;
		return;
	}
	if (!items.length) {
		grid.innerHTML = `<div class="empty muted">No channels.</div>`;
		return;
	}
	renderControls();
	renderChannels();
	focusRestore(null); // Back → the channel you left from; fresh nav → stay on the tab (arrow down to enter)
	// Entry sync (§Browse persistence): a change made on another device re-applies within a second
	// of opening the grid — unless the viewer already touched the controls here. A sort difference
	// is a REFETCH (server-owned ordering); genre re-filters locally.
	syncBrowsePrefs(async () => {
		if (gridTouched) return;
		const p = browsePref(persistLib);
		const s = p && ['name', 'updated', 'unwatched'].indexOf(p.sort) >= 0 ? p.sort : 'name';
		const g = (p && p.genre) || null;
		const genreChanged = g !== showsGenre && (g == null || showGenres.indexOf(g) >= 0);
		if (s === channelSort && !genreChanged) return;
		if (genreChanged) showsGenre = g;
		if (s !== channelSort) {
			channelSort = s;
			try { await loadChannels(); } catch (e) { return; } // keep the on-screen set on a blip
			if (gridTouched) return; // the viewer got there first while we fetched
		}
		refocusAfter(() => { renderControls(); renderChannels(); });
	});
}

// ---- picker menu (⇔ tvOS `Menu`) ---------------------------------------------------------------
//
// tvOS settled on a compact "Genre: All" control that opens a LIST, after a shelf of genre chips bled
// past the screen edge at 10 feet (TVChannelsView / TVMoviesWall carry that note); Google TV
// transcribed it (docs/gtv-phase3-blueprints.md §Genre+Sort — "the chip shelf is REJECTED on TV,
// twice"). Tizen was the last TV client still shelving chips. Same control, same reason: a library
// with twenty genres cannot show them in a row, and a strip that scrolls sideways hides most of its
// options behind a D-pad journey.
//
// Focus is trapped in the popup while it's open (nav.setScope) and Back closes it, restoring both the
// scope and the screen's own Back handler — a popup that leaked either would strand the viewer.
function openPicker(anchor, options, current, onPick) {
	const pop = document.createElement('div');
	pop.className = 'menu-pop';
	pop.setAttribute('role', 'menu');
	pop.innerHTML = options
		.map(
			(o, i) =>
				// No visible checkmark — the closed label already says what's active (GTV blueprint D3,
				// literal tvOS parity). aria-checked still carries it for a screen reader.
				`<div class="menu-item focusable" tabindex="0" role="menuitemradio" aria-checked="${o.value === current}" data-i="${i}">${esc(o.label)}</div>`
		)
		.join('');
	const scrim = document.createElement('div');
	scrim.className = 'menu-scrim';
	// Into the STAGE, not the body: #app is a fixed 1920×1080 surface scaled to the window, and anything
	// outside it renders at the wrong size. Positions are therefore in stage coordinates — measured
	// rects are post-scale, so divide back out.
	const stage = document.getElementById('app');
	stage.appendChild(scrim);
	stage.appendChild(pop);
	const sr = stage.getBoundingClientRect();
	const scale = sr.width / 1920 || 1;
	const r = anchor.getBoundingClientRect();
	// Anchored under the control, kept on screen (a genre menu opened from the right-hand end of the
	// row would otherwise run off the edge).
	pop.style.top = Math.max(24, Math.min((r.bottom - sr.top) / scale + 8, 1080 - pop.offsetHeight - 24)) + 'px';
	pop.style.left = Math.max(24, Math.min((r.left - sr.left) / scale, 1920 - pop.offsetWidth - 24)) + 'px';

	const prevBack = nav.getBack();
	const prevScope = nav.getScope(); // opened from inside the browse panel → hand its scope back, not the screen
	function close() {
		nav.setScope(prevScope && prevScope.isConnected ? prevScope : null);
		nav.setBack(prevBack);
		pop.remove();
		scrim.remove();
		if (anchor.isConnected) anchor.focus();
	}
	nav.setScope(pop);
	nav.setBack(close);
	pop.querySelectorAll('.menu-item').forEach((el) =>
		el.addEventListener('click', () => {
			const chosen = options[+el.dataset.i];
			close();
			onPick(chosen.value);
		})
	);
	const start = pop.querySelector('.menu-item'); // first item, as on tvOS/GTV
	if (start) start.focus();
}

/** The genre control: one button that says what's active, opening the picker. `genres` may be long. */
function genreButton(id, current) {
	return `<button class="btn small focusable" tabindex="0" id="${id}">Genre: ${esc(current || 'All')}</button>`;
}
function genreOptions(genres) {
	return [{ label: 'All', value: null }].concat(genres.map((g) => ({ label: g, value: g })));
}

// ---- browse panel (docs/tv-browse-panel-blueprint.md — the tvOS-accepted design, ported) -------------
//
// The §Browse-controls set lives OFF the grid: collapsed, a NON-FOCUSABLE sliver of icons at the stage's
// left edge inside the content gutter (amber when a control differs from its default — one mechanism
// for discoverability AND the tell that makes a persisted genre filter safe); expanded, a left panel
// with the count and the Sort / Genre / Show-watched controls. LEFT from the grid's first column opens
// it (nav.setGridLeftEdge — a gesture, not geometry); RIGHT or Back closes it and hands focus back to
// the card it came from. Focus is trapped inside while open (nav.setScope), as the picker does.
var browseUi = null; // { cfg, sliver, panel, scrim, fromKey, prevBack, prevScope }

const ICON_SORT = '<svg viewBox="0 0 24 24"><path d="M8 4v16M4 16l4 4 4-4M16 20V4M12 8l4-4 4 4"/></svg>';
const ICON_GENRE = '<svg viewBox="0 0 24 24"><path d="M4 6h16M7 12h10M10 18h4"/></svg>';
const ICON_EYE = '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';

/** The current surface's browse state + actions. Called by the surface on EVERY state change (its
 *  renderControls); mounts the sliver on first call, updates it on later ones, and re-renders the panel
 *  in place if it is open — keeping focus on the control the viewer is on. */
function setBrowseUi(cfg) {
	const stage = document.getElementById('app');
	if (!browseUi) browseUi = { cfg: cfg, sliver: null, panel: null, scrim: null, fromKey: null, prevBack: null, prevScope: null };
	browseUi.cfg = cfg;
	if (!browseUi.sliver) {
		const s = document.createElement('div');
		s.className = 'g-sliver';
		s.id = 'gsliver';
		stage.appendChild(s);
		browseUi.sliver = s;
	}
	renderSliver();
	if (browseUi.panel) renderPanel(document.activeElement && document.activeElement.id);
	nav.setGridLeftEdge(openBrowsePanel);
}

function renderSliver() {
	const c = browseUi.cfg;
	browseUi.sliver.innerHTML =
		`<span class="${c.sortIsDefault ? '' : 'on'}">${ICON_SORT}</span>` +
		(c.genres && c.genres.length ? `<span class="${c.genre ? 'on' : ''}">${ICON_GENRE}</span>` : '') +
		(c.watchedLabel ? `<span class="eye ${c.showWatched ? 'on' : ''}">${ICON_EYE}</span>` : '');
}

/** Tear the sliver + hook down when the screen changes (every screen re-render goes through renderTab
 *  or navTo). The panel, if open, closes with it. */
function clearBrowseUi() {
	if (!browseUi) return;
	if (browseUi.panel) closeBrowsePanel(false);
	if (browseUi.sliver) browseUi.sliver.remove();
	browseUi = null;
	nav.setGridLeftEdge(null);
}

function renderPanel(keepFocusId) {
	const c = browseUi.cfg;
	browseUi.panel.innerHTML =
		`<div class="count">${esc(c.count)}</div>` +
		`<button class="btn small focusable" tabindex="0" id="gp-sort">Sort: ${esc(c.sortLabel)}</button>` +
		(c.genres && c.genres.length ? genreButton('gp-genre', c.genre) : '') +
		(c.watchedLabel ? `<button class="btn small focusable" tabindex="0" id="gp-watched">${esc(c.watchedLabel)}</button>` : '');
	const sort = document.getElementById('gp-sort');
	sort.addEventListener('click', () => { browseUi.cfg.onSortNext(); });
	const g = document.getElementById('gp-genre');
	if (g) g.addEventListener('click', () => openPicker(g, genreOptions(browseUi.cfg.genres), browseUi.cfg.genre, (v) => browseUi.cfg.onGenre(v)));
	const w = document.getElementById('gp-watched');
	if (w) w.addEventListener('click', () => { browseUi.cfg.onToggleWatched(); });
	const keep = keepFocusId && document.getElementById(keepFocusId);
	(keep || sort).focus();
}

function openBrowsePanel() {
	if (!browseUi || browseUi.panel) return;
	const stage = document.getElementById('app');
	browseUi.fromKey = focusKeyOf(document.activeElement); // the card to hand focus back to
	const scrim = document.createElement('div');
	scrim.className = 'menu-scrim';
	const panel = document.createElement('div');
	panel.className = 'g-panel';
	panel.setAttribute('role', 'dialog');
	stage.appendChild(scrim);
	stage.appendChild(panel);
	browseUi.scrim = scrim;
	browseUi.panel = panel;
	browseUi.prevBack = nav.getBack();
	browseUi.prevScope = nav.getScope();
	browseUi.sliver.style.visibility = 'hidden';
	// RIGHT closes (back toward the grid) — intercepted before the spatial nav sees it. Back closes too.
	panel.addEventListener('keydown', (e) => {
		if (e.keyCode === 39) { e.preventDefault(); e.stopPropagation(); closeBrowsePanel(true); }
	});
	nav.setScope(panel);
	nav.setBack(() => closeBrowsePanel(true));
	renderPanel(null); // focus lands on Sort (⇔ tvOS)
}

function closeBrowsePanel(refocus) {
	if (!browseUi || !browseUi.panel) return;
	nav.setScope(browseUi.prevScope && browseUi.prevScope.isConnected ? browseUi.prevScope : null);
	nav.setBack(browseUi.prevBack);
	browseUi.panel.remove();
	browseUi.scrim.remove();
	browseUi.panel = null;
	browseUi.scrim = null;
	browseUi.sliver.style.visibility = '';
	if (!refocus) return;
	// Hand focus back to the card it came from; the grid may have re-rendered behind the panel (a sort
	// or filter), so fall back to the grid's first card rather than letting focus die on <body>.
	const back = browseUi.fromKey && document.querySelector(browseUi.fromKey);
	if (back) { back.focus(); nav.reveal(back); }
	else nav.focusFirst('#grid .card');
}

/**
 * THE browse-controls row (contract §Browse controls — count · genre · sort). One markup for every
 * grid: the count of what's on screen at the LEFT, Genre then Sort at the RIGHT, controls with
 * nothing to offer simply absent. The movies wall and the shows/channels grid differ in their sort
 * KEYS, never in this layout — they used to differ in both, which is how the count ended up on one
 * screen and not the other.
 */
function browseControls(o) {
	return `<div class="row wallbar">` +
		`<span class="muted">${esc(o.count)}</span>` +
		`<span class="grow"></span>` +
		(o.genres && o.genres.length ? genreButton(o.genreId, o.genre) : '') +
		(o.sortLabel ? `<button class="btn small focusable" tabindex="0" id="${o.sortId}">Sort: ${esc(o.sortLabel)}</button>` : '') +
		(o.watchedLabel ? `<button class="btn small focusable" tabindex="0" id="${o.watchedId}">${esc(o.watchedLabel)}</button>` : '') +
		`</div>`;
}

// Shows/channels sort — SERVER-side keys (?sort=), because the ordering is a decision the payload
// can't reproduce: `updated` is the newest item in each channel, `unwatched` this user's unwatched
// count. Same keys and labels as the web /channels select.
function nextChannelSort(s) { return s === 'name' ? 'updated' : s === 'updated' ? 'unwatched' : 'name'; }
function channelSortLabel(s) { return s === 'updated' ? 'Recently updated' : s === 'unwatched' ? 'Most unwatched' : 'Name'; }
/** "12 shows" / "1 movie" — the noun comes from the library format (contract: count of what's ON SCREEN). */
function countLabel(n, format) {
	const noun = format === 'movies' ? 'movie' : format === 'series' ? 'show' : 'channel';
	return n + ' ' + noun + (n === 1 ? '' : 's');
}

// ---- cards -------------------------------------------------------------------------------------

/** What a screen reader should say for a card: the tile's own facts, in reading order. Duration is
 *  spoken as minutes because "seven forty-four" is not a length. */
function ariaCard(v, sub) {
	var bits = [v.title];
	if (sub) bits.push(sub);
	if (v.duration) bits.push(Math.max(1, Math.round(v.duration / 60)) + ' minutes');
	if (v.watched) bits.push('watched');
	else if (v.position > 0) bits.push('partly watched');
	return bits.join(', ');
}

function videoCard(v) {
	const thumb = client.sized(v.thumb, 480);
	// Uniform 16:9 tiles like tvOS — vertical videos cover-crop in the grid (isVertical drives the player, not the card).
	const resume =
		!v.watched && v.position > 1 && v.duration
			? `<div class="resume" style="width:${Math.min(100, (v.position / v.duration) * 100)}%"></div>`
			: '';
	const check = v.watched ? `<div class="check">✓</div>` : '';
	const dur = durationText(v.duration);
	const durBadge = dur ? `<div class="dur">${dur}</div>` : '';
	// Series episode: lead the meta line with the SxE label (channel = the series name).
	// Movie: the year leads (channel = the library name) — ⇔ web/Android/Apple card subtitles.
	const ep = episodeLabel(v.season_number, v.episode_number);
	const sub = ep
		? (v.channel_name ? ep + ' · ' + esc(v.channel_name) : ep)
		: v.year
			? (v.channel_name ? v.year + ' · ' + esc(v.channel_name) : String(v.year))
			: esc(v.channel_name || '');
	// role+aria-label: the card is a <div> we made focusable, so Samsung's Voice Guide has nothing to
	// announce unless we say what it is and what it says. The label carries the same facts a sighted
	// viewer gets from the tile — title, source, length, and whether it's been watched.
	return `<div class="card focusable" tabindex="0" role="button" aria-label="${esc(ariaCard(v, sub))}" data-video="${v.id}" data-watched="${v.watched ? '1' : '0'}">
		<div class="thumb">${thumb ? `<img src="${thumb}" alt="" onerror="this.remove()">` : ''}${resume}${durBadge}${check}</div>
		<div class="card-title">${esc(v.title)}</div>
		<div class="card-sub">${sub}</div>
	</div>`;
}

/** 2:3 movie poster tile (contract §Movies; ⇔ web/Android/Apple walls): the movies-only signed
 *  `poster` (thumb stays the 16:9 fanart for Recent/rails), title + year, watched check + resume.
 *  Emits the same data-video/data-watched shape as videoCard, so wireVideoCards works unchanged. */
function movieCard(v) {
	const img = client.sized(v.poster, 320);
	const resume =
		!v.watched && v.position > 1 && v.duration
			? `<div class="resume" style="width:${Math.min(100, (v.position / v.duration) * 100)}%"></div>`
			: '';
	const check = v.watched ? `<div class="check">✓</div>` : '';
	return `<div class="card focusable" tabindex="0" role="button" aria-label="${esc(ariaCard(v, v.year ? String(v.year) : ''))}" data-video="${v.id}" data-watched="${v.watched ? '1' : '0'}">
		<div class="thumb poster">${img ? `<img src="${img}" alt="" loading="lazy" onerror="this.remove()">` : ''}${resume}${check}</div>
		<div class="card-title">${esc(v.title)}</div>
		<div class="card-sub">${v.year || ''}</div>
	</div>`;
}

function channelCard(c) {
	// 1:1 poster to match the tvOS reference + web (not 16:9 fanart) — a channel tile reads as identity, not art.
	const img = client.sized(c.poster || c.fanart, 320);
	// Unread-style badge: items this user hasn't watched (episodes for a series). "episodes" vs "videos" by kind.
	const badge = c.unwatched > 0 ? `<div class="unwatched-badge">${c.unwatched > 999 ? '999+' : c.unwatched}</div>` : '';
	const noun = c.kind === 'series' ? 'episodes' : 'videos';
	return `<div class="card focusable" tabindex="0" data-channel="${c.id}">
		<div class="thumb ${c.kind === 'series' ? 'poster' : 'square'}">${img ? `<img src="${img}" alt="" onerror="this.remove()">` : ''}${badge}</div>
		<div class="card-title">${esc(c.name)}</div>
		<div class="card-sub">${c.video_count} ${noun}</div>
	</div>`;
}

function wireVideoCards(container) {
	container.querySelectorAll('.card[data-video]').forEach((el) => {
		if (el._wired) return;
		el._wired = true;
		el.addEventListener('click', () => navTo(() => showVideoDetail(el.dataset.video)));
		el.addEventListener('mvhold', () => toggleCardWatched(el)); // hold OK on a card = mark watched/unwatched
	});
}

/** Mark-watched from the grid (optimistic): toggle the card's watched state; if it becomes watched and the
 *  feed hides watched, live-hide the card and move focus to a neighbour. */
function toggleCardWatched(el) {
	const watched = el.dataset.watched !== '1';
	el.dataset.watched = watched ? '1' : '0';
	client.postWatch(el.dataset.video, { watched }).catch(() => {});
	// Live-hide only if THIS view hides watched (Recent/channel each own their state — was leaking the global).
	const grid = el.closest('.grid');
	const hideWatched = !grid || grid.dataset.hideWatched !== '0';
	if (watched && hideWatched) {
		const nb = el.nextElementSibling || el.previousElementSibling;
		el.remove();
		if (nb && nb.classList.contains('card')) nb.focus();
		return;
	}
	let chk = el.querySelector('.check');
	if (watched && !chk) {
		chk = document.createElement('div');
		chk.className = 'check';
		chk.textContent = '✓';
		el.querySelector('.thumb').appendChild(chk);
	} else if (!watched && chk) {
		chk.remove();
	}
}

// ---- pushed views (tab bar hidden, ⇔ tvOS) -----------------------------------------------------

async function showChannelDetail(id) {
	currentScreen = () => showChannelDetail(id);
	nav.setBack(handleBack);
	app.innerHTML = `<div class="page"><div class="page-head" id="head"><span class="muted">Loading…</span></div><div class="grid" id="grid" data-hide-watched="1"></div></div>`;
	let chShowWatched = false; // channel-local (⇔ tvOS scopes it per screen)
	let resp;
	try {
		resp = await client.channel(id, chShowWatched);
	} catch (e) {
		document.getElementById('head').innerHTML = `<span class="muted">Couldn't load channel.</span>`;
		return;
	}
	const ch = resp.channel;
	let hidden = !!ch.isHidden; // this user unsubscribed it from their feed
	const isSeries = ch.kind === 'series';
	// Contract §Movies (⇔ web/Android/Apple): the wall carries NO Subscribe/Show-watched/Mark-all —
	// it always shows everything (watched = badge, not absence) as a 2:3 poster grid.
	const isMovies = ch.kind === 'movies';
	const subs = abbreviateCount(ch.follower_count); // abbreviated + omitted when absent (⇔ tvOS)
	const meta = [subs && `${subs} subscribers`, `${ch.video_count} ${isSeries ? 'episodes' : isMovies ? 'movies' : 'videos'}`]
		.filter(Boolean).join(' · ');
	document.getElementById('head').innerHTML = `
		<div class="ch-head">
			<div><div class="page-title">${esc(ch.name)}</div><div class="muted">${meta}</div></div>
			${isMovies ? '' : `<div class="row">
				<button class="btn small focusable" tabindex="0" id="watched">Show watched</button>
				<button class="btn small focusable" tabindex="0" id="markall">${isSeries ? 'Mark show watched' : 'Mark all watched'}</button>
				<button class="btn small focusable" tabindex="0" id="markallun">Mark all unwatched</button>
				<button class="btn small focusable" tabindex="0" id="sub">${hidden ? 'Subscribe' : 'Unsubscribe'}</button>
			</div>`}
		</div>`;
	const grid = document.getElementById('grid');
	if (isMovies) {
		grid.className = 'grid movies';
		grid.dataset.hideWatched = '0'; // the wall never live-hides watched cards
	}
	// SERIES: the server returns EVERY episode regardless of ?watched (showAll — next-episode logic
	// and season context need the full set), so watched-filtering is CLIENT-side here: default view
	// = unwatched episodes only, the toggle reveals all (⇔ the web page, the working reference — the
	// old refetch-only path made the toggle a no-op on series; owner field report 2026-08-18).
	const episodeView = (videos) =>
		isSeries && !chShowWatched ? (videos || []).filter((v) => !v.watched) : videos;
	function renderVideos(videos) {
		grid.innerHTML = (videos || []).map(isMovies ? movieCard : videoCard).join('') || `<div class="empty muted">No videos.</div>`;
		wireVideoCards(grid);
	}
	renderVideos(episodeView(resp.videos));
	if (!isMovies) {
		document.getElementById('sub').addEventListener('click', async () => {
			hidden = !hidden; // optimistic
			document.getElementById('sub').textContent = hidden ? 'Subscribe' : 'Unsubscribe';
			try { await client.setChannelHidden(ch.id, hidden); } catch (e) { /* keep optimistic */ }
		});
		document.getElementById('watched').addEventListener('click', async () => {
			chShowWatched = !chShowWatched;
			grid.dataset.hideWatched = chShowWatched ? '0' : '1';
			document.getElementById('watched').textContent = chShowWatched ? 'Hide watched' : 'Show watched';
			// Series could re-render from the response already in hand, but a refetch also picks up
			// state changed elsewhere (another device) — and flat channels need it anyway.
			try { renderVideos(episodeView((await client.channel(id, chShowWatched)).videos)); } catch (e) { /* keep current */ }
			nav.focusFirst('#grid .card');
		});
		// Bulk mark every video/episode here watched/unwatched for this user, then reload the grid.
		async function reloadCh() {
			try { renderVideos(episodeView((await client.channel(id, chShowWatched)).videos)); } catch (e) { /* keep current */ }
		}
		document.getElementById('markall').addEventListener('click', async () => {
			try { await client.setChannelWatched(ch.id, true); } catch (e) { /* keep */ }
			await reloadCh();
		});
		document.getElementById('markallun').addEventListener('click', async () => {
			try { await client.setChannelWatched(ch.id, false); } catch (e) { /* keep */ }
			await reloadCh();
		});
	}
	focusRestore('#grid .card'); // Back → the video you left from; else browse-first (buttons one arrow-up away)
}

async function showVideoDetail(id) {
	currentScreen = () => showVideoDetail(id);
	nav.setBack(handleBack);
	app.innerHTML = `<div class="page" id="page"><span class="muted">Loading…</span></div>`;
	let d;
	try {
		d = await client.videoDetail(id);
	} catch (e) {
		document.getElementById('page').innerHTML = `<div class="empty muted">Couldn't load.</div>`;
		return;
	}
	let related = [];
	try {
		related = (await client.related(id)).items || [];
	} catch (e) { /* related is optional */ }

	const poster = client.sized(d.playback && d.playback.poster, 1280);
	let watched = !!(d.watch && d.watch.watched);
	const tags = (d.tags || [])
		.map((t) => `<div class="chip focusable" tabindex="0" data-tag="${esc(t)}">#${esc(t)}</div>`)
		.join('');

	document.getElementById('page').innerHTML = `
		<div class="hero">
			<div class="hero-poster">${poster ? `<img src="${poster}" alt="" onerror="this.remove()">` : ''}</div>
			<div class="hero-info">
				<div class="page-title">${esc(d.title)}</div>
				<div class="muted">${esc(d.channel_name || '')}</div>
				<div class="muted small">${esc(metaLine(d))}</div>
				<div class="row">
					<button class="btn focusable" tabindex="0" id="play">Play</button>
					<button class="btn focusable" tabindex="0" id="markw">${watched ? 'Mark as Unwatched' : 'Mark as Watched'}</button>
				</div>
			</div>
		</div>
		${d.description ? `<div class="desc muted">${esc(d.description)}</div>` : ''}
		${tags ? `<div class="chips">${tags}</div>` : ''}
		${related.length ? `<div class="page-title small">Related</div><div class="grid rail" id="rel">${related.map(videoCard).join('')}</div>` : ''}`;

	// The player reports the CURRENT (last-played) video id on exit. Re-rendering its detail REPLACES the
	// launched-from detail in the screen stack (showVideoDetail sets currentScreen but doesn't push backStack),
	// so after leaving one more Back lands on the feed/channel below — not the player, not the started video.
	// currentId === d.id (a no-op) when no autoplay advanced.
	document.getElementById('play').addEventListener('click', () => playDetail(client, session, d, userPrefs, (currentId) => showVideoDetail(currentId || d.id)));
	const markw = document.getElementById('markw');
	markw.addEventListener('click', async () => {
		watched = !watched;
		markw.textContent = watched ? 'Mark as Unwatched' : 'Mark as Watched';
		try {
			await client.postWatch(d.id, { watched });
		} catch (e) { /* optimistic */ }
	});
	app.querySelectorAll('.chip[data-tag]').forEach((el) => el.addEventListener('click', () => navTo(() => showTag(el.dataset.tag))));
	const rel = document.getElementById('rel');
	if (rel) wireVideoCards(rel);
	focusRestore('#play'); // Back → the related card you left from; else the Play button
}

function showTag(tag) {
	currentScreen = () => showTag(tag);
	nav.setBack(handleBack);
	app.innerHTML = `<div class="page"><div class="page-title">#${esc(tag)}</div><div id="tagwrap"></div></div>`;
	feedGrid(document.getElementById('tagwrap'), (offset) => client.videos({ offset, tag }));
}

// ---- search (debounced live title search) ------------------------------------------------------

function searchView(container) {
	container.innerHTML = `
		<div class="search-wrap">
			<input class="field focusable" id="q" placeholder="Search your library" autocomplete="off">
			<div class="results" id="results"><div class="empty muted">Type to search your library.</div></div>
		</div>`;
	const input = document.getElementById('q');
	// Up from the (full-width, centered) field returns to the selected Search tab. Pure geometric nav would
	// pick the tab nearest screen-centre — Settings — because the tabs are left-aligned; override that here.
	input.addEventListener('keydown', (e) => {
		if (e.keyCode !== 38) return; // Up
		e.stopPropagation();
		e.preventDefault();
		const sel = document.querySelector('.tab.sel');
		if (sel) sel.focus();
	});
	let timer = null;
	input.addEventListener('input', () => {
		clearTimeout(timer);
		const q = input.value.trim();
		const results = document.getElementById('results');
		timer = setTimeout(() => {
			if (!q) { results.innerHTML = `<div class="empty muted">Type to search your library.</div>`; return; }
			// no auto-focus — keep the field focused; a query-specific empty message (⇔ tvOS), not "Nothing here".
			feedGrid(results, (offset) => client.videos({ offset, q }), { autoFocus: false, emptyMsg: `No results for “${esc(q)}”` });
		}, 280);
	});
	// Focus rests on the Search TAB when selected (like Recent/Channels); arrow DOWN into the field to
	// search. Auto-focusing #q on tab-landing opened the IME every time and trapped left/right traversal.
}

// ---- settings (⇔ tvOS TVSettingsView) ----------------------------------------------------------

async function settingsView(container) {
	container.innerHTML = `
		<div class="settings">
			<img class="wordmark" src="wordmark.png" alt="MytView">
			<div class="stats" id="stats"></div>
			<div class="setrows" id="prefs"></div>
			<button class="btn focusable" tabindex="0" id="signout">Sign Out</button>
			<div class="footer muted" id="foot"></div>
		</div>`;
	document.getElementById('signout').addEventListener('click', () => session.logout());
	// Focus rests on the Settings TAB (like Recent/Channels) — arrow DOWN to enter; don't yank to Sign Out.
	focusRestore(null);

	try {
		const st = await client.status();
		document.getElementById('stats').innerHTML =
			`<div class="stat"><b>${st.videos.toLocaleString()}</b><span>Videos</span></div>` +
			`<div class="stat"><b>${st.channels.toLocaleString()}</b><span>Channels</span></div>`;
	} catch (e) { /* stats optional */ }

	let me = null;
	try { me = await client.me(); } catch (e) { /* prefs fall back to defaults */ }
	if (me && me.prefs) userPrefs = me.prefs;
	renderPrefs(userPrefs); // mutated in place by the toggles → the player sees the latest
	// The Samsung TV app is FREE by design (the funnel): gently point at the paid mobile apps, and
	// carry the qrcode.js attribution (MIT) — the one third-party dependency in this client.
	document.getElementById('foot').innerHTML =
		`${me ? 'Signed in as ' + esc(me.username) + '<br>' : ''}Server: ${esc(session.baseUrl || '')}<br>MytView ${esc(appVersion())}` +
		'<br><br>MytView is free on Samsung TV. The iPhone/iPad and Android/Google TV apps are one-time purchases that support development.' +
		'<br>Built with qrcode.js (MIT License).';

	// Every row is the same shape: activate to cycle to the next value, PATCH it, re-render, keep focus.
	// Caption size/colour are stored per USER on the server (not per device), so setting them here also
	// sets them on the phone — the point of an accessibility preference.
	function renderPrefs(p) {
		const still = p.stillWatchingAfter <= 0 ? 'Off' : `After ${p.stillWatchingAfter} videos`;
		document.getElementById('prefs').innerHTML =
			row('autoplay', 'Autoplay next video', p.autoplayNext ? 'On' : 'Off') +
			(p.autoplayNext ? row('still', 'Ask “Are you still watching?”', still) : '') +
			row('subsize', 'Subtitle size', cap(p.subtitleSize || 'medium')) +
			row('subcolor', 'Subtitle colour', cap(p.subtitleColor || 'white'));
		bind('autoplay', () => { p.autoplayNext = !p.autoplayNext; return { autoplayNext: p.autoplayNext }; });
		bind('still', () => { p.stillWatchingAfter = nextStill(p.stillWatchingAfter); return { stillWatchingAfter: p.stillWatchingAfter }; });
		bind('subsize', () => { p.subtitleSize = nextSubSize(p.subtitleSize); return { subtitleSize: p.subtitleSize }; });
		bind('subcolor', () => { p.subtitleColor = p.subtitleColor === 'yellow' ? 'white' : 'yellow'; return { subtitleColor: p.subtitleColor }; });

		function row(id, label, value) {
			return `<div class="setrow focusable" tabindex="0" id="${id}"><span>${label}</span><span>${esc(value)}</span></div>`;
		}
		function bind(id, advance) {
			const el = document.getElementById(id);
			if (!el) return;
			el.addEventListener('click', async () => {
				const patch = advance();
				try { await client.updatePrefs(patch); } catch (e) { /* the local value still applies this session */ }
				renderPrefs(p);
				nav.focusFirst('#' + id);
			});
		}
	}
}

function nextStill(n) { return n === 0 ? 3 : n === 3 ? 5 : n === 5 ? 10 : 0; }
function nextSubSize(s) { return s === 'small' ? 'medium' : s === 'medium' ? 'large' : 'small'; }

// Movies-wall local sort — the three contract keys (§Movies; ⇔ every other client).
function nextSort(s) { return s === 'title' ? 'year' : s === 'year' ? 'added' : 'title'; }
function sortLabel(s) { return s === 'year' ? 'Year' : s === 'added' ? 'Recently added' : 'Title'; }

// ---- utils -------------------------------------------------------------------------------------

/** The app version from config.xml on Tizen (Application API); a constant fallback in the browser. */
function appVersion() {
	try { return window.tizen.application.getCurrentApplication().appInfo.version; } catch (e) { return '0.1.0'; }
}

function esc(s) {
	return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Capitalize the first letter — library names are usually lowercase ("shows"); tidies the nav tab.
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
