import { Component, ChangeDetectionStrategy, input, computed } from '@angular/core';
import { CommonModule } from '@angular/common';

export type SpinnerSize = 'sm' | 'md' | 'lg';
export type SpinnerColor = 'indigo' | 'white';

const SIZE_CLASSES: Record<SpinnerSize, string> = {
  sm: 'w-5 h-5 border-2',
  md: 'w-8 h-8 border-4',
  lg: 'w-10 h-10 border-4',
};

const COLOR_CLASSES: Record<SpinnerColor, string> = {
  indigo: 'border-indigo-200 dark:border-indigo-800 border-t-indigo-600 dark:border-t-indigo-400',
  // For use on solid colored buttons (e.g. the indigo "Sign in" button)
  white: 'border-white/30 border-t-white',
};

/** Reusable CSS ring spinner — same visual used across login, printer scans, and list loading states. */
@Component({
  selector: 'app-loading-spinner',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div [class]="spinnerClass()"></div>
  `,
})
export class LoadingSpinnerComponent {
  size = input<SpinnerSize>('md');
  color = input<SpinnerColor>('indigo');

  spinnerClass = computed(
    () => `${SIZE_CLASSES[this.size()]} ${COLOR_CLASSES[this.color()]} rounded-full animate-spin`
  );
}
