import { ChangeDetectionStrategy, Component } from '@angular/core';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="shell">
      <h1>Angular Material example</h1>
      <p class="muted">
        Placeholder app is running. Add a component to <code>src/app/</code>
        and import it here to start building.
      </p>
    </main>
  `,
  styles: [`
    .shell {
      max-width: 720px;
      margin: 2rem auto;
      padding: 0 1rem;
    }
    h1 {
      font: 500 1.5rem/1.2 Roboto, sans-serif;
      margin-bottom: 1rem;
    }
    .muted { color: var(--mat-sys-on-surface-variant); }
    code {
      background: var(--mat-sys-surface-container);
      padding: 0.1rem 0.3rem;
      border-radius: 4px;
    }
  `],
})
export class AppComponent {}
