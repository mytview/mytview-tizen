// Thin wrapper over the vendored qrcode-generator (loaded in index.html as a classic script, which
// defines the global `qrcode`). Returns a PNG data-URL to drop into an <img src>.
export function qrDataUrl(text, cellSize = 8, margin = 4) {
	const qr = window.qrcode(0, 'M'); // typeNumber 0 = auto-size to the smallest type that fits; EC level M
	qr.addData(text);
	qr.make();
	return qr.createDataURL(cellSize, margin);
}
