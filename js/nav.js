// Spatial focus navigation for the TV remote — the piece Android/tvOS get from the platform. Focusable
// elements carry class "focusable"; arrow keys move focus to the nearest focusable in that direction (by
// geometry). OK: a quick press "clicks" the focused element; a HOLD (~550ms) fires a `mvhold` event on it
// (the mark-watched-from-grid gesture, ⇔ tvOS press-and-hold / Android long-press). Back runs the
// registered back handler. Text inputs keep Left/Right for the cursor and handle OK themselves.

let backHandler = null;
// While a popup (the genre picker) is open, focus is TRAPPED inside it: geometric nav would otherwise
// walk straight out into the grid behind it, and the popup covers what it lands on.
let scopeEl = null;
let holdTimer = null;
let holdTarget = null;
let didHold = false;

export function setBack(fn) { backHandler = fn; }
export function getBack() { return backHandler; }
/** Confine arrow navigation to `el` (null = the whole screen again). */
export function setScope(el) { scopeEl = el || null; }
export function getScope() { return scopeEl; }

// LEFT from a grid's FIRST COLUMN is a gesture of its own (the browse panel — docs/tv-browse-
// panel-blueprint.md), not a geometric move: with nothing in the same row to the left, plain
// nearest-candidate geometry would otherwise hop to a library chip above-left. The screen that
// owns a grid registers a handler; move('left') calls it INSTEAD of the geometric fallback when the
// focused element is a grid card with no same-row candidate to its left. null = plain geometry.
let gridLeftEdge = null;
export function setGridLeftEdge(fn) { gridLeftEdge = fn || null; }

function focusables() {
	const root = scopeEl && scopeEl.isConnected ? scopeEl : document;
	return Array.from(root.querySelectorAll('.focusable')).filter((el) => el.offsetParent !== null && !el.disabled);
}

/** Focus the first focusable (optionally the first matching a selector), e.g. after a view renders.
 *  A missing selector falls back to the SELECTED tab, never blindly to focusables[0]: the first
 *  focusable on the browse shell is the Recent TAB, and tabs select on focus — so the old fallback
 *  could silently switch the whole view when a restore target had just been re-rendered away. */
export function focusFirst(selector) {
	const f = focusables();
	let target = selector ? f.find((el) => el.matches(selector)) : f[0];
	if (!target) target = f.find((el) => el.matches('.tab.sel')) || f[0];
	if (target) target.focus();
}

function center(el) {
	const r = el.getBoundingClientRect();
	return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function move(dir) {
	const all = focusables();
	if (!all.length) return;
	const cur = document.activeElement;
	if (!cur || !cur.classList || !cur.classList.contains('focusable')) {
		// Focus died (a re-render destroyed the focused element). Recover to the CURRENT tab — focusing
		// all[0] (the first tab, Recent) would also SWITCH to it, yanking the user off their screen.
		const sel = document.querySelector('.tab.sel');
		(sel || all[0]).focus();
		return;
	}
	const c = center(cur);
	const cr = cur.getBoundingClientRect();
	// VERTICAL moves follow three rules, each earned on the M8 (field reports 2026-08-18):
	//  1. Inside a tile grid, stay in the grid while it has rows in that direction — the grids
	//     scroll, so a row scrolled out of view sits at the same heights as the header chrome and
	//     pure geometry would teleport Up out of the catalog mid-scroll.
	//  2. Candidates inside the scrolling .content outrank the fixed shell chrome (tab bar), so
	//     leaving the grid walks the in-content bars before reaching the tabs.
	//  3. Within the chosen pool, land in the FIRST ROW of focusables in that direction — never
	//     jump over an intervening bar. The genre/sort/show-watched controls are right-aligned, so
	//     beam-priority from a left-side chip or card skipped them entirely (they were reachable
	//     only from the grid's rightmost column); nearest-row-first makes the ladder symmetric:
	//     tabs ↔ libraries ↔ controls ↔ grid rows, entered at the nearest element.
	// Horizontal moves keep plain beam-then-nearest geometry.
	const vert = dir === 'up' || dir === 'down';
	const curGrid = vert && cur.closest ? cur.closest('.grid') : null;
	const curContent = vert && cur.closest ? cur.closest('.content') : null;
	const cands = [];
	let best = null;
	for (const el of all) {
		if (el === cur) continue;
		const t = center(el);
		const dx = t.x - c.x;
		const dy = t.y - c.y;
		let primary;
		let cross;
		if (dir === 'left') { if (dx >= -1) continue; primary = -dx; cross = Math.abs(dy); }
		else if (dir === 'right') { if (dx <= 1) continue; primary = dx; cross = Math.abs(dy); }
		else if (dir === 'up') { if (dy >= -1) continue; primary = -dy; cross = Math.abs(dx); }
		else { if (dy <= 1) continue; primary = dy; cross = Math.abs(dx); }
		// "In the beam" = overlaps the CURRENT element's span on the cross axis — same ROW for
		// Left/Right, same COLUMN for Up/Down (keeps a grid column sticky while stepping rows).
		const r = el.getBoundingClientRect();
		const inBeam =
			dir === 'left' || dir === 'right'
				? r.bottom > cr.top && r.top < cr.bottom
				: r.right > cr.left && r.left < cr.right;
		cands.push({
			el,
			primary,
			score: primary + cross * 2, // nearest in-direction, penalise cross-axis drift
			inBeam,
			inGrid: !!(curGrid && el.closest && el.closest('.grid') === curGrid),
			inContent: !!(curContent && el.closest && el.closest('.content') === curContent)
		});
	}
	if (cands.length) {
		if (vert) {
			const pool = cands.some((x) => x.inGrid)
				? cands.filter((x) => x.inGrid)
				: cands.some((x) => x.inContent)
					? cands.filter((x) => x.inContent)
					: cands;
			// The first row = everything within a band of the nearest candidate; 90px separates the
			// bars/rows cleanly at 1080p while absorbing height differences within one bar.
			const minP = Math.min.apply(null, pool.map((x) => x.primary));
			const row = pool.filter((x) => x.primary <= minP + 90);
			const beam = row.filter((x) => x.inBeam);
			best = (beam.length ? beam : row).reduce((a, b) => (a.score <= b.score ? a : b)).el;
		} else {
			let beamBest = null;
			let beamBestScore = Infinity;
			let plain = null;
			let plainScore = Infinity;
			for (const x of cands) {
				if (x.inBeam && x.score < beamBestScore) { beamBestScore = x.score; beamBest = x.el; }
				if (x.score < plainScore) { plainScore = x.score; plain = x.el; }
			}
			// The grid's left edge (see setGridLeftEdge): a first-column card with nothing in its row
			// to the left hands the key to the screen's handler rather than hopping off the grid.
			if (dir === 'left' && !beamBest && gridLeftEdge && cur.closest && cur.closest('.grid') && cur.classList.contains('card')) {
				gridLeftEdge();
				return;
			}
			best = beamBest || plain;
		}
	} else if (dir === 'left' && gridLeftEdge && cur.closest && cur.closest('.grid') && cur.classList.contains('card')) {
		gridLeftEdge(); // no candidates at all (a one-column view) — still the edge gesture
		return;
	}
	if (best) {
		// Up into the tab bar always lands on the SELECTED tab, not the geometrically-nearest one — the tabs are
		// left-aligned, so "up" from a right-column card/field would otherwise select the wrong tab + switch views.
		if (dir === 'up' && best.classList && best.classList.contains('tab')) {
			const sel = document.querySelector('.tab.sel');
			if (sel) best = sel;
		}
		// Same rule for the LIBRARIES bar (M8 field report 2026-08-18): entering it from outside lands on
		// the ACTIVE library chip — the one whose grid you are looking at — not whichever chip happens to
		// sit nearest above the cursor. Moves WITHIN the bar (chip ↔ chip) stay geometric.
		if (
			best.classList && best.classList.contains('libtab') &&
			!(cur.classList && cur.classList.contains('libtab'))
		) {
			const act = document.querySelector('.libtab.active');
			if (act) best = act;
		}
		// And for the CATALOG: entering a grid from outside lands on its FIRST card (reading order),
		// not whichever card happens to sit under the control you left from — the genre/sort/watched
		// bar is right-aligned, so geometric entry dropped into column 4–6 (owner 2026-08-18). Moves
		// WITHIN the grid (row ↔ row) keep their column via the beam, as before.
		if (vert) {
			const bGrid = best.closest && best.closest('.grid');
			if (bGrid && bGrid !== curGrid) {
				const first = bGrid.querySelector('.card.focusable');
				if (first) best = first;
			}
		}
		best.focus();
		reveal(best);
	}
}

function onKeyDown(e) {
	const el = document.activeElement;
	const isInput = el && el.tagName === 'INPUT';
	switch (e.keyCode) {
		case 37: if (isInput) return; move('left'); break; // Left (let a text field keep its cursor)
		case 39: if (isInput) return; move('right'); break; // Right
		case 38: move('up'); break; // Up
		case 40: move('down'); break; // Down
		case 13: // OK — quick press = click (on keyup); hold = mvhold
			if (isInput) return;
			if (!e.repeat && el && el.classList && el.classList.contains('focusable')) {
				holdTarget = el;
				didHold = false;
				clearTimeout(holdTimer);
				holdTimer = setTimeout(() => {
					didHold = true;
					if (holdTarget) holdTarget.dispatchEvent(new CustomEvent('mvhold', { bubbles: true }));
				}, 550);
			}
			break;
		case 10009: case 27: // Return/Back / Escape
			// Samsung Return-key policy: this key must ALWAYS do something — back-navigate, or exit at
			// the root. If NO handler is registered (a boot state, or a screen that failed before wiring
			// one), fall through to app exit rather than swallowing the key: a dead Return is a CRITICAL
			// store rejection (Seller Office 2026-08-19, V0.1.17 on Tizen 7.0–10.0 panels we cannot
			// test locally).
			if (backHandler) backHandler();
			else exitAppFallback();
			break;
		default: return;
	}
	e.preventDefault();
}

function onKeyUp(e) {
	if (e.keyCode !== 13) return;
	clearTimeout(holdTimer);
	const el = holdTarget;
	holdTarget = null;
	if (!didHold && el && document.activeElement === el && el.tagName !== 'INPUT') el.click(); // short press → click
	didHold = false;
}

/** Last-resort app exit for an unhandled Return (see the 10009 case): exit() first; window.close()
 *  as the fallback some engines accept when the Tizen API is unavailable. */
function exitAppFallback() {
	try { window.tizen.application.getCurrentApplication().exit(); return; } catch (e) {}
	try { window.close(); } catch (e) {}
}

/** Reveal `el` inside its scrolling ancestors with the MINIMAL scroll — the tvOS feel: the cursor walks
 *  down (or across) the screen, and the list only moves once the tile nears an edge. Hand-rolled because
 *  scrollIntoView({block:'nearest'}) is Chromium 61+: Cr56 (the 2018 sets) takes the options OBJECT as the
 *  legacy boolean `true` — align-to-top — so the list moved up under a cursor pinned to the top row (owner
 *  2026-09-19). Rects are post-scale (the 1920×1080 stage is scaled to the window); scrollTop is CSS px. */
export function reveal(el) {
	if (!el || !el.getBoundingClientRect) return;
	const stage = document.getElementById('app');
	const scale = (stage && stage.getBoundingClientRect().width / 1920) || 1;
	const MARGIN = 48; // breathing room before an edge triggers a scroll (absorbs the focus scale too)
	let vDone = false, hDone = false;
	for (let sc = el.parentElement; sc && sc !== document.body && !(vDone && hDone); sc = sc.parentElement) {
		const cs = getComputedStyle(sc);
		const r = el.getBoundingClientRect(), c = sc.getBoundingClientRect();
		if (!vDone && (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && sc.scrollHeight > sc.clientHeight + 1) {
			const top = (r.top - c.top) / scale, bottom = (r.bottom - c.top) / scale, h = c.height / scale;
			if (bottom > h - MARGIN) sc.scrollTop += bottom - (h - MARGIN);
			else if (top < MARGIN) sc.scrollTop -= MARGIN - top;
			vDone = true;
		}
		if (!hDone && (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && sc.scrollWidth > sc.clientWidth + 1) {
			const left = (r.left - c.left) / scale, right = (r.right - c.left) / scale, w = c.width / scale;
			if (right > w - MARGIN) sc.scrollLeft += right - (w - MARGIN);
			else if (left < MARGIN) sc.scrollLeft -= MARGIN - left;
			hDone = true;
		}
	}
}

export function initNav() {
	document.addEventListener('keydown', onKeyDown);
	document.addEventListener('keyup', onKeyUp);
}
