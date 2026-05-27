import { ChangeDetectionStrategy, Component } from '@angular/core';
import { EventCalendarComponent } from './event-calendar.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [EventCalendarComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="shell">
      <h1>Team event calendar</h1>
      <app-event-calendar />
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
  `],
})
export class AppComponent {}
