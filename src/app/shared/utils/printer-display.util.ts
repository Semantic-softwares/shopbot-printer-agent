/** Presentation helpers shared by printer-card, list-printers, and printer-details. */

export function getPrinterIcon(type: string): string {
  switch (type) {
    case 'network':
      return '🖨️';
    case 'usb':
      return '💾';
    case 'bluetooth':
      return '📡';
    default:
      return '🔧';
  }
}

export function getPrinterTypeName(type: string): string {
  switch (type) {
    case 'network':
      return 'Network Printer';
    case 'usb':
      return 'USB Printer';
    case 'bluetooth':
      return 'Bluetooth Printer';
    default:
      return 'Unknown';
  }
}

export function getPrinterDetails(printer: any): string {
  switch (printer.type) {
    case 'network':
      return `${printer.ip}:${printer.port}`;
    case 'usb':
      return `${printer.vendorId}:${printer.productId}`;
    case 'bluetooth':
      return `${printer.macAddress} (Ch: ${printer.channel})`;
    default:
      return 'N/A';
  }
}

export function formatPrinterTime(timestamp: string): string {
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return 'N/A';
  }
}

/** Zero-padded 4-digit hex with 0x prefix, e.g. 1048 -> "0x0418" */
export function formatUsbHex(value: number | undefined | null): string {
  if (value === undefined || value === null) return 'N/A';
  return '0x' + value.toString(16).toUpperCase().padStart(4, '0');
}
