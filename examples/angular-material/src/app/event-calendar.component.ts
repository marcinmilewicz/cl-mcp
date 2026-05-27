import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import {
  MAT_SINGLE_DATE_SELECTION_MODEL_PROVIDER,
  MatCalendar,
  MatCalendarCellClassFunction,
} from '@angular/material/datepicker';
import { MatCard, MatCardContent, MatCardTitle } from '@angular/material/card';

interface CalendarEvent {
  date: Date;
  title: string;
}

@Component({
  selector: 'app-event-calendar',
  standalone: true,
  imports: [MatCalendar, MatCard, MatCardContent, MatCardTitle],
  providers: [MAT_SINGLE_DATE_SELECTION_MODEL_PROVIDER],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <mat-card appearance="outlined">
      <mat-card-title>Pick a date</mat-card-title>
      <mat-card-content>
        <mat-calendar
          [selected]="selected()"
          [dateClass]="dateClass()"
          (selectedChange)="onDateSelected($event)"
        />

        @if (selectedEvent(); as evt) {
          <p class="event-detail">
            <strong>{{ evt.title }}</strong>
          </p>
        } @else if (selected()) {
          <p class="event-detail muted">No events on this date.</p>
        }
      </mat-card-content>
    </mat-card>
  `,
  styles: [`
    mat-card { padding: 1rem; }
    mat-card-title { margin-bottom: 0.75rem; }
    .event-detail { margin-top: 1rem; }
    .muted { color: var(--mat-sys-on-surface-variant); }
  `],
})
export class EventCalendarComponent {
  readonly events = signal<CalendarEvent[]>([
    { date: new Date(2026, 3, 20), title: 'Sprint planning' },
    { date: new Date(2026, 3, 22), title: 'Design review' },
    { date: new Date(2026, 3, 28), title: 'Release cut' },
  ]);

  readonly selected = signal<Date | null>(null);

  readonly selectedEvent = computed(() => {
    const picked = this.selected();
    if (!picked) return null;
    return this.events().find((e) => sameDay(e.date, picked)) ?? null;
  });

  /**
   * Returns a `dateClass` function that highlights event days.
   * Wrapped in `computed` so the calendar re-renders when events() changes.
   */
  readonly dateClass = computed<MatCalendarCellClassFunction<Date>>(() => {
    const eventDays = buildEventDaySet(this.events());
    return (date, view) => {
      // TODO(you): implement the lookup.
      // See event-calendar.component.ts — function `classFor` below.
      return classFor(date, view, eventDays);
    };
  });

  onDateSelected(date: Date | null): void {
    this.selected.set(date);
  }
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function buildEventDaySet(events: CalendarEvent[]): Set<string> {
  return new Set(events.map((e) => toKey(e.date)));
}

function toKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * TODO(you): decide which cells get the `event-day` class.
 *
 * Contract:
 *   - `view` is 'month' | 'year' | 'multi-year'. Only 'month' shows individual days.
 *   - Return '' for no styling, or a space-separated list of CSS class names.
 *   - `event-day` is already defined in src/styles.scss (draws a dot under the date).
 *
 * Trade-offs to consider:
 *   1. Should 'year' / 'multi-year' views also highlight months that contain events,
 *      or is that visual noise? (Many apps skip it.)
 *   2. Do you want multiple classes — e.g. 'event-day' + 'event-day--urgent' —
 *      to style different event types? If so, extend CalendarEvent with a `kind`
 *      field and add matching CSS in styles.scss.
 *   3. Today's date already gets Material's own highlight. Decide whether
 *      "today + has event" should stack both, or suppress one.
 */
function classFor(
  date: Date,
  view: 'month' | 'year' | 'multi-year',
  eventDays: Set<string>,
): string {
  // TODO: your 5–10 lines go here.
  return '';
}
