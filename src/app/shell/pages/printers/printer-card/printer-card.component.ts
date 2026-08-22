import { Component, ChangeDetectionStrategy, input, output, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterLink } from '@angular/router';
import {
  getPrinterIcon,
  getPrinterTypeName,
  getPrinterDetails,
  formatPrinterTime,
} from '../../../../shared/utils/printer-display.util';

@Component({
  selector: 'app-printer-card',
  standalone: true,
  imports: [CommonModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './printer-card.component.html',
})
export class PrinterCardComponent {
  printer = input.required<any>();

  test = output<any>();
  remove = output<string>();

  icon = computed(() => getPrinterIcon(this.printer().type));
  typeName = computed(() => getPrinterTypeName(this.printer().type));
  details = computed(() => getPrinterDetails(this.printer()));
  addedAt = computed(() => formatPrinterTime(this.printer().createdAt));
}
