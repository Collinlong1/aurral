import { parseResponse } from "hono/client";
import { DotLoader } from "../../../components/DotLoader";
import { downloadClientSettingsClient } from "../../../utils/api/clients/downloadClientSettings.ts";
import { SettingsTextarea } from "../components/SettingsField";
import { SettingsActions, SettingsRow } from "../SettingsLayout";

// A webhook's optional body for each event, each with its own test. An empty
// body falls back to the webhook's default body.

type TestJson = Parameters<typeof downloadClientSettingsClient.webhook.test.$post>[0]["json"];
type EventKey = NonNullable<TestJson["testEvent"]>;
type WebhookDraft = Omit<TestJson, "testEvent">;
export type EventBodies = Partial<Record<EventKey, string>>;
type UseTest = (
  send: () => Promise<unknown>,
  success: string,
  failure: string,
  label: string,
) => {
  testing: boolean;
  status: { tone: "success" | "error"; message: string } | null;
  run: () => void;
  reset: () => void;
};

// The webhook's saved event bodies, as editable text.
export const editableEventBodies = (saved: Record<string, unknown> = {}) =>
  Object.fromEntries(
    Object.entries(saved).map(([key, value]) => [key, value ?? ""]),
  ) as EventBodies;

// Only the event bodies that hold text, so an empty one falls back to the
// default body.
export const filledEventBodies = (eventBodies: EventBodies): EventBodies =>
  Object.fromEntries(
    Object.entries(eventBodies)
      .map(([key, value]) => [key, (value ?? "").trim()])
      .filter(([, value]) => value),
  );

function EventBodyRow({
  event,
  label,
  draft,
  value,
  onChange,
  useTest,
}: {
  event: EventKey;
  label: string;
  draft: WebhookDraft;
  value: string;
  onChange: (value: string) => void;
  useTest: UseTest;
}) {
  const test = useTest(
    () =>
      parseResponse(
        downloadClientSettingsClient.webhook.test.$post({ json: { ...draft, testEvent: event } }),
      ),
    `Test ${label.toLowerCase()} webhook sent.`,
    "Test failed. Check the URL, body, and headers, then retry.",
    "Webhook",
  );
  return (
    <SettingsRow
      label={`${label} body`}
      htmlFor={`webhook-body-${event}`}
      help="Optional. Leave blank to send the default body for this event."
      stack
    >
      <SettingsTextarea
        id={`webhook-body-${event}`}
        rows={3}
        maxLength={1000}
        spellCheck={false}
        autoComplete="off"
        value={value}
        onChange={(changeEvent) => {
          test.reset();
          onChange(changeEvent.target.value);
        }}
      />
      <SettingsActions status={test.status}>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={test.run}
          disabled={test.testing || !draft.url}
        >
          {test.testing ? <DotLoader size="xs" label={null} /> : null}
          Test
        </button>
      </SettingsActions>
    </SettingsRow>
  );
}

// The Notifications page passes its own event list and test hook, so the
// rows test and read like the rest of the webhook form.
export function WebhookEventBodies({
  events,
  draft,
  values,
  onChange,
  useTest,
}: {
  events: readonly (readonly [EventKey, string])[];
  draft: WebhookDraft;
  values: EventBodies;
  onChange: (values: EventBodies) => void;
  useTest: UseTest;
}) {
  return events.map(([key, label]) => (
    <EventBodyRow
      key={key}
      event={key}
      label={label}
      draft={draft}
      value={values[key] ?? ""}
      onChange={(value) => onChange({ ...values, [key]: value })}
      useTest={useTest}
    />
  ));
}
