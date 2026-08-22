import { Component, ChangeDetectionStrategy, input, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * A labeled value row with a copy-to-clipboard button. Manages its own
 * "copied" flash state internally, so multiple instances on a page never
 * need to coordinate a shared "which field was just copied" signal.
 */
@Component({
  selector: 'app-copy-field',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex items-center justify-between px-3 py-2">
      <div>
        <p class="text-[11px] uppercase tracking-wide text-gray-400 dark:text-slate-500">{{ label() }}</p>
        <p class="text-sm font-mono text-gray-900 dark:text-white">{{ effectiveDisplayValue() }}</p>
      </div>
      <button
        (click)="copy()"
        class="p-1.5 rounded-md text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors text-xs">
        {{ copied() ? '✓' : '📋' }}
      </button>
    </div>
  `,
})
export class CopyFieldComponent {
  label = input.required<string>();
  /** The raw value copied to the clipboard. */
  value = input.required<string>();
  /** What's shown on screen; falls back to `value` if omitted. */
  displayValue = input<string>();

  copied = signal(false);

  effectiveDisplayValue = computed(() => this.displayValue() ?? this.value());

  copy(): void {
    navigator.clipboard.writeText(this.value()).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    });
  }
}
