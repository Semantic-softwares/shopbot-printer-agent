/**
 * Turns a PNG into ESC/POS raster bytes ("GS v 0"), so a QR code issued as an
 * image (the MRA's is a 350×350 1-bit PNG) can print on any receipt printer.
 *
 * Kept as a Buffer producer because the composer builds receipts as text: raw
 * image bytes would be mangled by a string round-trip through UTF-8.
 */
const { PNG } = require('pngjs');

const GS = 0x1d;
/** Some printers choke on one very tall raster block; consecutive bands print seamlessly. */
const BAND_ROWS = 128;

/**
 * @param {Buffer} png          PNG file bytes
 * @param {number} maxDots      printable width in dots (≈576 for 80mm, ≈384 for 58mm)
 * @returns {Buffer} ESC/POS bytes, or an empty Buffer if the image can't be decoded
 */
function pngToEscPosRaster(png, maxDots = 384) {
  let image;
  try {
    image = PNG.sync.read(png);
  } catch {
    return Buffer.alloc(0);
  }

  // Never enlarge (that would blur a QR); shrink only when the paper is narrower than the image.
  const scale = Math.min(1, maxDots / image.width);
  const width = Math.max(1, Math.floor(image.width * scale));
  const height = Math.max(1, Math.floor(image.height * scale));
  const bytesPerRow = Math.ceil(width / 8);

  const isBlack = (x, y) => {
    // Average the source pixels this output dot covers, so a shrunk QR keeps its structure.
    const x0 = Math.floor(x / scale);
    const y0 = Math.floor(y / scale);
    const x1 = Math.max(x0 + 1, Math.floor((x + 1) / scale));
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) / scale));
    let sum = 0;
    let n = 0;
    for (let sy = y0; sy < Math.min(y1, image.height); sy++) {
      for (let sx = x0; sx < Math.min(x1, image.width); sx++) {
        const i = (sy * image.width + sx) * 4;
        const alpha = image.data[i + 3] / 255;
        const luminance = 0.299 * image.data[i] + 0.587 * image.data[i + 1] + 0.114 * image.data[i + 2];
        sum += luminance * alpha + 255 * (1 - alpha); // transparent counts as paper
        n++;
      }
    }
    return n > 0 && sum / n < 128;
  };

  const bands = [];
  for (let top = 0; top < height; top += BAND_ROWS) {
    const rows = Math.min(BAND_ROWS, height - top);
    const data = Buffer.alloc(bytesPerRow * rows);
    for (let row = 0; row < rows; row++) {
      for (let x = 0; x < width; x++) {
        if (isBlack(x, top + row)) data[row * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
    bands.push(Buffer.from([GS, 0x76, 0x30, 0x00, bytesPerRow & 0xff, bytesPerRow >> 8, rows & 0xff, rows >> 8]), data);
  }
  return Buffer.concat(bands);
}

module.exports = { pngToEscPosRaster };
