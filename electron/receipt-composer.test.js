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

// ---- refund receipts ----------------------------------------------------

const refundJob = (over = {}, paperWidth = 80) => ({
  type: 'refund_receipt',
  _id: 'job1',
  order: 'o1',
  printerDetails: { paperWidth },
  receiptSettings: {},
  orderMetadata: { reference: 'A1', currencyCode: 'MUR', storeName: 'Cafe Ebene', storeAddress: 'Ebene', storePhone: '230 123' },
  refund: {
    refundNumber: 'RF-ABCD1234',
    orderReference: 'A1',
    kind: 'items',
    total: 33,
    reason: 'Wrong item served',
    note: 'Wrong burger',
    cashier: 'Ada Cashier',
    approvedBy: 'Bola Manager',
    createdAt: '2026-10-16T10:00:00Z',
    lines: [{ name: 'Burger', quantity: 2, unitPrice: 15, amount: 33 }],
    tenders: [{ method: 'Cash', amount: 18 }, { method: 'Card', amount: 15 }],
  },
  ...over,
});
const textOf = (out) => out.toString('utf8');

test('a refund receipt says REFUND, not RECEIPT, and carries the refund and the original sale', () => {
  const text = textOf(composeReceipt(refundJob()));
  assert.ok(text.includes('REFUND\n'));
  assert.ok(!text.includes('RECEIPT'));
  assert.ok(text.includes('Refund #RF-ABCD1234'));
  assert.ok(text.includes('Original sale #A1'));
  assert.ok(text.includes('Cafe Ebene'));
  assert.ok(text.includes('Cashier: Ada Cashier'));
  assert.ok(text.includes('Approved by: Bola Manager'));
  assert.ok(text.includes('Reason: Wrong item served'));
  assert.ok(text.includes('Wrong burger'));
});

test('a refund receipt lists the returned items and every tender the money goes back to', () => {
  const text = textOf(composeReceipt(refundJob()));
  assert.match(text, /2x {2}Burger\s+MUR 33\.00/);
  assert.ok(text.includes('@ MUR 15.00 each'));
  assert.ok(text.includes('Refunded via'));
  assert.match(text, / {2}Cash\s+MUR 18\.00/);
  assert.match(text, / {2}Card\s+MUR 15\.00/);
  assert.match(text, /REFUND\s+MUR 33\.00/);
});

test('a single tender prints on one line', () => {
  const text = textOf(composeReceipt(refundJob({ refund: { ...refundJob().refund, tenders: [{ method: 'Cash', amount: 33 }] } })));
  assert.match(text, /Refunded via\s+Cash/);
});

test('a goodwill refund with no items still prints, as an amount', () => {
  const text = textOf(composeReceipt(refundJob({ refund: { ...refundJob().refund, kind: 'amount', lines: [], total: 10, tenders: [{ method: 'Cash', amount: 10 }] } })));
  assert.match(text, /Amount refund\s+MUR 10\.00/);
});

test('an approver line only appears when someone approved it', () => {
  const text = textOf(composeReceipt(refundJob({ refund: { ...refundJob().refund, approvedBy: undefined } })));
  assert.ok(!text.includes('Approved by'));
});

test('a refund at a store that does not report sales carries no tax-authority block', () => {
  const out = composeReceipt(refundJob());
  assert.equal(out.indexOf(rasterHeader), -1);
  assert.ok(!textOf(out).includes('Credit Note'));
  assert.ok(!textOf(out).includes('FISCAL'));
});

test('a fiscalised credit note prints its CRN reference and QR, before the footer', () => {
  const credit = { authority: 'MRA', status: 'FISCALISED', referenceLabel: 'CRN', reference: IRN, qrCodePng: qrPng.toString('base64') };
  const out = composeReceipt(refundJob({ fiscal: credit, receiptSettings: { footerMessage: 'FOOTER-LINE' } }));
  const text = out.toString('latin1');
  assert.ok(text.includes('MRA Credit Note'));
  assert.ok(text.includes('CRN:'));
  assert.ok(text.includes('A'.repeat(32)));
  const qrAt = out.indexOf(rasterHeader);
  assert.ok(qrAt > text.indexOf('CRN:'));
  assert.ok(qrAt < text.indexOf('FOOTER-LINE'));
  assert.ok(!text.includes('e-Invoice')); // never labelled as a sale invoice
});

test('an unconfirmed credit note prints NOT YET FISCALISED in the QR position', () => {
  const text = textOf(composeReceipt(refundJob({ fiscal: { authority: 'MRA', status: 'NOT_YET_FISCALISED', referenceLabel: 'CRN' } })));
  assert.ok(text.includes('MRA Credit Note'));
  assert.ok(text.includes('NOT YET FISCALISED'));
});

test('58mm paper wraps the refund receipt at 32 columns', () => {
  const long = 'A very long reason that certainly cannot fit on a thin roll of paper in one go';
  const text = textOf(composeReceipt(refundJob({ refund: { ...refundJob().refund, reason: long } }, 58)));
  const reasonLines = text.split('\n').filter((l) => /^(Reason: |[a-z ]+$)/.test(l) && long.includes(l.replace('Reason: ', '').slice(0, 10)));
  assert.ok(reasonLines.length > 1);
  assert.ok(reasonLines.every((l) => l.length <= 32));
});

test('a job type this build does not know fails instead of printing the wrong document', () => {
  assert.throws(() => composeReceipt({ ...refundJob(), type: 'credit_slip_v9' }), /Unsupported print job type/);
});

test('sales receipts and tickets are unaffected by the new layout', () => {
  assert.ok(textOf(composeReceipt(job(undefined))).includes('RECEIPT'));
  assert.ok(textOf(composeReceipt({ ...job(undefined), type: 'kitchen_ticket', stationName: 'Grill' })).includes('Order'));
  assert.ok(textOf(composeReceipt({ ...job(undefined), type: undefined })).includes('RECEIPT')); // an old job with no type
});
