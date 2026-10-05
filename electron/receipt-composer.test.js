// Run with: node --test electron/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PNG } = require('pngjs');
const { composeReceipt } = require('./receipt-composer');
const { pngToEscPosRaster } = require('./escpos-image');

const qrPng = fs.readFileSync(path.join(__dirname, 'test-fixtures', 'mra-qr-sample.png'));
const IRN = 'A'.repeat(32) + 'B'.repeat(32);

const job = (fiscal, paperWidth = 80) => ({
  type: 'master_receipt',
  printerDetails: { paperWidth },
  receiptSettings: {},
  items: [{ foodId: 'f1', name: 'Burger', quantity: 2, price: 100, options: [] }],
  orderMetadata: { reference: 'R1', subtotal: 200, tax: 30, total: 230, paymentStatus: 'Paid', storeName: 'Shopbot', currencyCode: 'MUR' },
  fiscal,
});

const fiscalised = { authority: 'MRA', status: 'FISCALISED', referenceLabel: 'IRN', reference: IRN, qrCodePng: qrPng.toString('base64') };
const rasterHeader = Buffer.from([0x1d, 0x76, 0x30, 0x00]);

/** Reads GS v 0 bands back into a [row][x] bitmap. */
function decodeRaster(buffer) {
  const rows = [];
  let at = 0;
  let width = 0;
  while ((at = buffer.indexOf(rasterHeader, at)) !== -1) {
    const bytesPerRow = buffer[at + 4] + (buffer[at + 5] << 8);
    const height = buffer[at + 6] + (buffer[at + 7] << 8);
    width = bytesPerRow * 8;
    let p = at + 8;
    for (let r = 0; r < height; r++, p += bytesPerRow) {
      rows.push(Array.from({ length: width }, (_, x) => (buffer[p + (x >> 3)] & (0x80 >> (x & 7))) !== 0));
    }
    at = p;
  }
  return rows;
}

test('a store without e-invoicing gets exactly the receipt it always did', () => {
  const out = composeReceipt(job(undefined));
  assert.equal(out.indexOf(rasterHeader), -1);
  assert.ok(!out.toString('utf8').includes('e-Invoice'));
  assert.ok(!out.toString('utf8').includes('FISCAL'));
});

test('a fiscalised sale prints the IRN and the QR code before the footer', () => {
  const out = composeReceipt(job(fiscalised));
  const text = out.toString('latin1');
  assert.ok(text.includes('MRA e-Invoice'));
  assert.ok(text.includes('IRN:'));
  const afterLabel = text.slice(text.indexOf('IRN:') + 4, text.indexOf('\x1d\x76\x30'));
  assert.equal(afterLabel.replace(/[^AB]/g, ''), IRN, 'the whole IRN prints, wrapped to the paper width');
  const rasterAt = out.indexOf(rasterHeader);
  assert.ok(rasterAt > out.indexOf('IRN:'), 'QR comes after the IRN');
  assert.ok(rasterAt < out.indexOf('Thank you'), 'QR comes before the footer');
  assert.ok(!text.includes('NOT YET FISCALISED'));
  assert.ok(!text.includes('\u0000FISCAL_QR'));
});

test('the printed QR is pixel-for-pixel the image MRA issued', () => {
  const rows = decodeRaster(composeReceipt(job(fiscalised)));
  const png = PNG.sync.read(qrPng);
  assert.equal(rows.length, png.height);
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      assert.equal(rows[y][x], png.data[(y * png.width + x) * 4] < 128, `pixel ${x},${y}`);
    }
  }
  for (let y = 0; y < rows.length; y++) for (let x = png.width; x < rows[y].length; x++) assert.equal(rows[y][x], false); // padding is paper
});

test('an unconfirmed sale prints NOT YET FISCALISED in the QR position', () => {
  const out = composeReceipt(job({ authority: 'MRA', status: 'NOT_YET_FISCALISED', referenceLabel: 'IRN' }));
  const text = out.toString('latin1');
  assert.ok(text.includes('NOT YET FISCALISED'));
  assert.equal(out.indexOf(rasterHeader), -1);
  assert.ok(text.indexOf('NOT YET FISCALISED') < text.indexOf('Thank you'));
});

test('a QR that cannot be decoded still prints the IRN and says the QR is unavailable', () => {
  const out = composeReceipt(job({ ...fiscalised, qrCodePng: Buffer.from('not a png').toString('base64') }));
  const text = out.toString('latin1');
  assert.ok(text.includes('IRN:') && text.includes('(QR code unavailable)'));
  assert.equal(out.indexOf(rasterHeader), -1);
});

test('58mm paper shrinks only if the image is wider than the paper', () => {
  assert.equal(decodeRaster(pngToEscPosRaster(qrPng, 384))[0].length, 352); // 350 fits: not scaled
  const narrow = decodeRaster(pngToEscPosRaster(qrPng, 200));
  assert.equal(narrow.length, 200);
  assert.ok(narrow.some((row) => row.some(Boolean)), 'shrunk QR still has dark modules');
});

test('station tickets never carry the fiscal block', () => {
  const out = composeReceipt({ ...job(fiscalised), type: 'station_ticket', stationName: 'Kitchen' });
  assert.equal(out.indexOf(rasterHeader), -1);
  assert.ok(!out.toString('latin1').includes('e-Invoice'));
});

test('garbage input to the rasteriser yields nothing instead of throwing', () => {
  assert.equal(pngToEscPosRaster(Buffer.from('nope')).length, 0);
});

test('write a preview of the full receipt for eyeballing', { skip: !process.env.PREVIEW_OUT }, () => {
  const rows = decodeRaster(composeReceipt(job(fiscalised)));
  const png = new PNG({ width: rows[0].length, height: rows.length });
  rows.forEach((row, y) => row.forEach((on, x) => { const i = (y * png.width + x) * 4; png.data.fill(on ? 0 : 255, i, i + 3); png.data[i + 3] = 255; }));
  fs.writeFileSync(process.env.PREVIEW_OUT, PNG.sync.write(png));
});
