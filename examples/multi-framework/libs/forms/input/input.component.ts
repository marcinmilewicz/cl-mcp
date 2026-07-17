import { Component, EventEmitter, Input, Output } from "@angular/core";

/** A single-line text input. */
@Component({
  selector: "org-input",
  standalone: true,
  template: `<input [value]="value" [placeholder]="placeholder" /><ng-content select="[suffix]" />`,
})
export class OrgInput {
  /** Current value. */
  @Input({ required: true }) value!: string;
  /** Placeholder text. */
  @Input() placeholder = "";
  /** Emitted on every change. */
  @Output() valueChange = new EventEmitter<string>();
}
