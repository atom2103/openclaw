import { html } from "lit";
import "../styles/filter-controls.css";

export function renderFilterSwitch(props: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return html`<label class="filter-row filter-switch">
    <span>${props.label}</span>
    <input
      type="checkbox"
      role="switch"
      .checked=${props.checked}
      @change=${(event: Event) => {
        if (event.currentTarget instanceof HTMLInputElement) {
          props.onChange(event.currentTarget.checked);
        }
      }}
    />
  </label>`;
}
