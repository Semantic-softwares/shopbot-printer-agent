/**
 * Composes ESC/POS receipt bytes from a PrintJob's raw data (items, orderMetadata,
 * printer capabilities, receiptSettings) — a port of what used to be
 * shopbot-server's PrintJobGeneratorService.generateStationReceipt/generateMasterReceipt.
 *
 * Composition moved here (onto the device that actually prints) so the backend only
 * has to decide WHAT goes on which ticket (station grouping, reprint served/new split)
 * and hand over structured data — not render printer-specific ESC/POS bytes itself.
 *
 * Every job now carries a uniform item shape, whether it's a station ticket or a
 * master receipt: { foodId, name, quantity, price, options, notes }, where `options`
 * is the FULL structured option-group array (each item with its own `selected` flag),
 * not a pre-filtered display string — same principle as the POS cart itself.
 */

const ESC = '\x1B';
const GS = '\x1D';

const CMD = {
  INIT: ESC + '\x40',
  ALIGN_LEFT: ESC + '\x61\x00',
  ALIGN_CENTER: ESC + '\x61\x01',
  ALIGN_RIGHT: ESC + '\x61\x02',
  BOLD_ON: ESC + '\x45\x01',
  BOLD_OFF: ESC + '\x45\x00',
  UNDERLINE_ON: ESC + '\x2D\x01',
  UNDERLINE_OFF: ESC + '\x2D\x00',
  FONT_NORMAL: ESC + '\x21\x00',
  FONT_BOLD: ESC + '\x21\x08',
  FONT_WIDE: ESC + '\x21\x20',
  FONT_TALL: ESC + '\x21\x10',
  FONT_LARGE: ESC + '\x21\x30',
  FONT_SMALL: ESC + '\x21\x01',
  FONT_SMALL_BOLD: ESC + '\x21\x09',
  LINE_SPACING_DEFAULT: ESC + '\x32',
  LINE_SPACING_TIGHT: ESC + '\x33\x18',
  LINE_SPACING_WIDE: ESC + '\x33\x3C',
  FEED: '\x0A',
  CUT: GS + '\x56\x00',
  PARTIAL_CUT: GS + '\x56\x01',
};

/** Split a line item's current quantity into served (already printed) vs new. */
function splitServedVsNew(foodId, currentQty, printedMap) {
  const printedQty = (printedMap && printedMap[foodId]) || 0;
  const servedQty = Math.min(printedQty, currentQty);
  return { servedQty, newQty: currentQty - servedQty };
}

/** Format currency as "CODE amount" (e.g. "MUR 250.00"). */
function fmtCurrency(amount, currencyCode) {
  const formatted = Number(amount || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${currencyCode || ''} ${formatted}`.trim();
}

/** Pad a line so `left` is left-aligned and `right` is right-aligned within `cols`. */
function padLine(left, right, cols) {
  if (!right) {
    if (left.length > cols) return left.substring(0, cols) + '\n';
    return left + '\n';
  }

  const gap = cols - left.length - right.length;
  if (gap >= 1) {
    return left + ' '.repeat(gap) + right + '\n';
  }

  const maxNameLen = cols - right.length - 2;
  if (maxNameLen > 8) {
    const truncated = left.substring(0, maxNameLen - 1) + '.';
    const truncGap = cols - truncated.length - right.length;
    return truncated + ' '.repeat(Math.max(1, truncGap)) + right + '\n';
  }

  return left + '\n' + ' '.repeat(Math.max(0, cols - right.length)) + right + '\n';
}

/** Draw a horizontal separator line using a repeated character. */
function drawLine(cols, char) {
  return (char || '-').repeat(cols) + '\n';
}

/** Format a date/time for receipt display. */
function formatDateTime(dateInput) {
  try {
    const d = new Date(dateInput);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${day}/${month}/${year} ${hours}:${minutes}`;
  } catch {
    return String(dateInput);
  }
}

/**
 * Render an item's selected options using small font, indented, right-aligned
 * prices. `options` is the full structured group array — only `selected: true`
 * entries are actually printed.
 */
function renderItemOptions(options, currencyCode, cols) {
  if (!options || !Array.isArray(options) || options.length === 0) return '';

  let r = '';
  r += CMD.FONT_SMALL;
  const smallCols = cols <= 32 ? 42 : 56;

  for (const optionGroup of options) {
    if (optionGroup.options && Array.isArray(optionGroup.options)) {
      for (const opt of optionGroup.options) {
        if (!opt.selected) continue;
        const qty = opt.quantity || 1;
        const price = opt.price || 0;
        const label = `  + ${qty > 1 ? qty + 'x ' : ''}${opt.name}`;
        const value = price > 0 ? fmtCurrency(price, currencyCode) : '';
        r += padLine(label, value, smallCols);
      }
    } else {
      const name = optionGroup.optionItemName || optionGroup.name;
      const qty = optionGroup.quantity || 1;
      const price = optionGroup.price || 0;
      const label = `  + ${qty > 1 ? qty + 'x ' : ''}${name}`;
      const value = price > 0 ? fmtCurrency(price, currencyCode) : '';
      r += padLine(label, value, smallCols);
    }
  }

  r += CMD.FONT_NORMAL;
  return r;
}

/**
 * Station ticket (kitchen/bar) — items only, no financial summary.
 * @param job - PrintJob-shaped object: { stationName, items, orderMetadata, receiptSettings, printerDetails }
 */
function composeStationReceipt(job) {
  const paperWidth = job.printerDetails?.paperWidth || 80;
  const cols = paperWidth <= 58 ? 32 : 48;
  const items = job.items || [];
  const meta = job.orderMetadata || {};
  const settings = job.receiptSettings || {};
  const currencyCode = meta.currencyCode || 'NGN';
  const stationName = job.stationName || 'STATION';

  let r = '';
  r += CMD.INIT;
  r += CMD.LINE_SPACING_DEFAULT;

  r += CMD.ALIGN_CENTER;
  r += CMD.FONT_LARGE;
  r += CMD.BOLD_ON;
  r += `${stationName.toUpperCase()}\n`;
  r += CMD.BOLD_OFF;
  r += CMD.FONT_NORMAL;
  r += CMD.FEED;

  r += CMD.ALIGN_LEFT;
  r += drawLine(cols, '-');
  r += CMD.BOLD_ON;
  r += `Order #${meta.reference || job.order}\n`;
  r += CMD.BOLD_OFF;
  if (meta.salesChannel === 'Qrcode') {
    r += CMD.FONT_SMALL_BOLD;
    r += `SELF-ORDER (QR)\n`;
    r += CMD.FONT_NORMAL;
  }
  r += `${formatDateTime(meta.createdAt)}\n`;
  if (meta.itemsEditedAt) {
    r += CMD.FONT_SMALL_BOLD;
    r += `EDITED ${formatDateTime(meta.itemsEditedAt)}\n`;
    r += CMD.FONT_NORMAL;
  }
  r += CMD.FONT_SMALL;
  r += `Printed: ${formatDateTime(new Date())}\n`;
  r += CMD.FONT_NORMAL;
  if (meta.type) r += `Type: ${meta.type}\n`;
  if (meta.table) {
    r += CMD.BOLD_ON;
    r += `Table: ${meta.table}\n`;
    r += CMD.BOLD_OFF;
  }
  if (settings.showCustomerName !== false && (meta.guestName || meta.guest)) {
    r += `Guest: ${meta.guestName || meta.guest}\n`;
  }
  if (settings.showSellerInfo !== false && meta.staff) {
    r += `Server: ${meta.staff}\n`;
  }

  const printedMap = meta.printedItemQuantities;
  const isReprint = printedMap && Object.keys(printedMap).length > 0;
  const hasNewItems = isReprint && items.some(
    (item) => splitServedVsNew(String(item.foodId), item.quantity || 1, printedMap).newQty > 0
  );

  r += drawLine(cols, '=');
  r += CMD.BOLD_ON;
  r += padLine('QTY  ITEM', 'PRICE', cols);
  r += CMD.BOLD_OFF;
  r += drawLine(cols, '-');
  if (hasNewItems) {
    r += CMD.FONT_SMALL;
    r += `*** (NEW) = added since last print ***\n`;
    r += CMD.FONT_NORMAL;
  }
  r += CMD.LINE_SPACING_TIGHT;

  items.forEach((item, idx) => {
    const qty = item.quantity || 1;
    const price = item.price || 0;
    const itemPrice = price > 0 ? fmtCurrency(price, currencyCode) : '';

    r += CMD.FONT_NORMAL;
    r += CMD.BOLD_ON;
    if (isReprint) {
      const { servedQty, newQty } = splitServedVsNew(String(item.foodId), qty, printedMap);
      if (servedQty > 0) {
        r += padLine(`${servedQty}x  ${item.name} (SERVED)`, itemPrice, cols);
      }
      if (newQty > 0) {
        r += padLine(`${newQty}x  ${item.name} (NEW)`, itemPrice, cols);
      }
    } else {
      r += padLine(`${qty}x  ${item.name}`, itemPrice, cols);
    }
    r += CMD.BOLD_OFF;

    r += renderItemOptions(item.options, currencyCode, cols);

    if (settings.showNote !== false && item.notes) {
      r += CMD.FONT_SMALL;
      r += `     ** ${item.notes}\n`;
      r += CMD.FONT_NORMAL;
    }

    // Only ever set on self-order lines — several phones can add to the same
    // shared table order, so this is who added *this* item, distinct from the
    // "Guest:" line above (whoever opened the tab). Same toggle as that line.
    if (settings.showCustomerName !== false && item.orderedBy) {
      r += CMD.FONT_SMALL;
      r += `     for: ${item.orderedBy}\n`;
      r += CMD.FONT_NORMAL;
    }

    if (idx < items.length - 1) {
      r += CMD.FEED;
    }
  });

  r += CMD.LINE_SPACING_DEFAULT;
  r += drawLine(cols, '=');
  r += CMD.ALIGN_CENTER;
  r += CMD.FONT_SMALL;
  r += `${items.length} item(s) for ${stationName}\n`;
  r += CMD.FONT_NORMAL;
  r += CMD.FEED;
  r += CMD.FEED;
  r += CMD.FEED;
  r += CMD.PARTIAL_CUT;

  return r;
}

/**
 * Master receipt — full store header, all items, financial summary, footer.
 * @param job - PrintJob-shaped object: { items, orderMetadata, receiptSettings, printerDetails }
 */
function composeMasterReceipt(job) {
  const paperWidth = job.printerDetails?.paperWidth || 80;
  const cols = paperWidth <= 58 ? 32 : 48;
  const products = job.items || [];
  const meta = job.orderMetadata || {};
  const settings = job.receiptSettings || {};
  const currencyCode = meta.currencyCode || 'NGN';

  let r = '';
  r += CMD.INIT;
  r += CMD.LINE_SPACING_DEFAULT;

  r += CMD.ALIGN_CENTER;
  if (settings.showStoreDetails !== false && meta.storeName) {
    const displayName = (settings.useCustomBusinessName && settings.businessName)
      ? settings.businessName
      : meta.storeName;
    r += CMD.FONT_LARGE;
    r += CMD.BOLD_ON;
    r += `${displayName}\n`;
    r += CMD.BOLD_OFF;
    r += CMD.FONT_NORMAL;
    if (meta.storeAddress) {
      r += CMD.FONT_SMALL;
      r += `${meta.storeAddress}\n`;
    }
    if (meta.storePhone) {
      r += CMD.FONT_SMALL;
      r += `Tel: ${meta.storePhone}\n`;
    }
    r += CMD.FONT_NORMAL;
    r += CMD.FEED;
  }

  r += CMD.FONT_WIDE;
  r += CMD.BOLD_ON;
  r += `RECEIPT\n`;
  r += CMD.BOLD_OFF;
  r += CMD.FONT_NORMAL;
  r += CMD.FEED;

  r += CMD.ALIGN_LEFT;
  r += drawLine(cols, '=');
  r += CMD.BOLD_ON;
  r += `Order #${meta.reference || job.order}\n`;
  r += CMD.BOLD_OFF;
  if (meta.salesChannel === 'Qrcode') {
    r += CMD.FONT_SMALL_BOLD;
    r += `SELF-ORDER (QR)\n`;
    r += CMD.FONT_NORMAL;
  }
  r += `Date: ${formatDateTime(meta.createdAt)}\n`;
  if (meta.itemsEditedAt) {
    r += CMD.FONT_SMALL_BOLD;
    r += `EDITED ${formatDateTime(meta.itemsEditedAt)}\n`;
    r += CMD.FONT_NORMAL;
  }
  r += CMD.FONT_SMALL;
  r += `Printed: ${formatDateTime(new Date())}\n`;
  r += CMD.FONT_NORMAL;
  if (meta.type) r += `Type: ${meta.type}\n`;
  if (meta.table) {
    r += CMD.BOLD_ON;
    r += `Table: ${meta.table}\n`;
    r += CMD.BOLD_OFF;
  }
  if (settings.showCustomerName !== false && (meta.guestName || meta.guest)) {
    r += `Guest: ${meta.guestName || meta.guest}\n`;
  }
  if (settings.showSellerInfo !== false && meta.staff) {
    r += `Server: ${meta.staff}\n`;
  }

  const printedMap = meta.printedItemQuantities;
  const isReprint = printedMap && Object.keys(printedMap).length > 0;
  const hasNewItems = isReprint && products.some(
    (p) => splitServedVsNew(String(p.foodId), p.quantity || 1, printedMap).newQty > 0
  );

  r += drawLine(cols, '=');
  r += CMD.BOLD_ON;
  r += padLine('QTY  ITEM', 'AMOUNT', cols);
  r += CMD.BOLD_OFF;
  r += drawLine(cols, '-');
  if (hasNewItems) {
    r += CMD.FONT_SMALL;
    r += `*** (NEW) = added since last print ***\n`;
    r += CMD.FONT_NORMAL;
  }
  r += CMD.LINE_SPACING_TIGHT;

  products.forEach((product, idx) => {
    const qty = product.quantity || 1;
    const price = product.price || 0;
    const lineTotal = qty * price;

    r += CMD.FONT_NORMAL;
    r += CMD.BOLD_ON;
    if (isReprint) {
      const { servedQty, newQty } = splitServedVsNew(String(product.foodId), qty, printedMap);
      if (servedQty > 0) {
        const servedPrice = servedQty * price;
        r += padLine(`${servedQty}x  ${product.name}`, servedPrice > 0 ? fmtCurrency(servedPrice, currencyCode) : '', cols);
      }
      if (newQty > 0) {
        const newPrice = newQty * price;
        r += padLine(`${newQty}x  ${product.name} (NEW)`, newPrice > 0 ? fmtCurrency(newPrice, currencyCode) : '', cols);
      }
    } else {
      const itemLabel = `${qty}x  ${product.name}`;
      const itemPrice = lineTotal > 0 ? fmtCurrency(lineTotal, currencyCode) : '';
      r += padLine(itemLabel, itemPrice, cols);
    }
    r += CMD.BOLD_OFF;

    if (qty > 1 && price > 0) {
      r += CMD.FONT_SMALL;
      r += `     @ ${fmtCurrency(price, currencyCode)} each\n`;
      r += CMD.FONT_NORMAL;
    }

    r += renderItemOptions(product.options, currencyCode, cols);

    if (product.notes) {
      r += CMD.FONT_SMALL;
      r += `     ** ${product.notes}\n`;
      r += CMD.FONT_NORMAL;
    }

    // Only ever set on self-order lines — several phones can add to the same
    // shared table order, so this is who added *this* item, distinct from the
    // "Guest:" line above (whoever opened the tab). Same toggle as that line.
    if (settings.showCustomerName !== false && product.orderedBy) {
      r += CMD.FONT_SMALL;
      r += `     for: ${product.orderedBy}\n`;
      r += CMD.FONT_NORMAL;
    }

    if (idx < products.length - 1) {
      r += CMD.FEED;
    }
  });

  r += CMD.LINE_SPACING_DEFAULT;
  r += drawLine(cols, '=');

  const { subtotal, tax, discount, shippingFee, serviceFee, total } = meta;

  if (subtotal !== undefined) {
    r += padLine('Subtotal', fmtCurrency(subtotal, currencyCode), cols);
  }
  if (settings.showTax !== false && tax && tax > 0) {
    r += padLine('Tax', fmtCurrency(tax, currencyCode), cols);
  }
  if (discount && discount > 0) {
    r += padLine('Discount', '-' + fmtCurrency(discount, currencyCode), cols);
  }
  if (shippingFee && shippingFee > 0) {
    r += padLine('Delivery', fmtCurrency(shippingFee, currencyCode), cols);
  }
  if (serviceFee && serviceFee > 0) {
    r += padLine('Service Fee', fmtCurrency(serviceFee, currencyCode), cols);
  }

  if (total !== undefined) {
    r += drawLine(cols, '-');
    r += CMD.FONT_WIDE;
    r += CMD.BOLD_ON;
    const wideCols = Math.floor(cols / 2);
    r += padLine('TOTAL', fmtCurrency(total, currencyCode), wideCols);
    r += CMD.BOLD_OFF;
    r += CMD.FONT_NORMAL;
  }

  r += drawLine(cols, '-');
  if (meta.payment) {
    r += padLine('Paid via', meta.payment, cols);
  }
  if (meta.paymentStatus) {
    r += padLine('Status', meta.paymentStatus, cols);
  }

  if (settings.showNote !== false && meta.note) {
    r += drawLine(cols, '-');
    r += CMD.ALIGN_CENTER;
    r += CMD.FONT_SMALL_BOLD;
    r += 'NOTE\n';
    r += CMD.FONT_SMALL;
    r += `${meta.note}\n`;
    r += CMD.FONT_NORMAL;
    r += CMD.ALIGN_LEFT;
  }

  r += drawLine(cols, '=');
  r += CMD.ALIGN_CENTER;
  r += CMD.FEED;
  const footerMessage = settings.footerMessage || 'Thank you for your patronage!';
  r += CMD.BOLD_ON;
  r += `${footerMessage}\n`;
  r += CMD.BOLD_OFF;
  if (settings.disclaimer) {
    r += CMD.FONT_SMALL;
    r += `${settings.disclaimer}\n`;
    r += CMD.FONT_NORMAL;
  }
  r += CMD.ALIGN_LEFT;
  r += CMD.FEED;
  r += CMD.FEED;
  r += CMD.FEED;
  r += CMD.PARTIAL_CUT;

  return r;
}

/**
 * Compose a job into a Buffer of raw ESC/POS bytes, dispatching by job.type.
 * Station/kitchen/bar tickets get the items-only layout; everything else
 * (master_receipt, or any unrecognized type) gets the full receipt layout.
 */
function composeReceipt(job) {
  const text = job.type === 'station_ticket' || job.type === 'kitchen_ticket' || job.type === 'bar_ticket'
    ? composeStationReceipt(job)
    : composeMasterReceipt(job);
  // Matches the encoding the backend generator used before this moved here
  // (`Buffer.from(receiptData)` with no explicit encoding = utf8 default).
  return Buffer.from(text, 'utf8');
}

module.exports = {
  composeReceipt,
  composeStationReceipt,
  composeMasterReceipt,
};
