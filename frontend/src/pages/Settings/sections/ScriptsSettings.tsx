import { useState, type FormEvent, type ReactNode } from "react";
import { parseResponse } from "hono/client";
import { useQuery } from "@tanstack/react-query";
import PillToggle from "../../../components/PillToggle";
import { DotLoader } from "../../../components/DotLoader";
import { scriptSettingsClient } from "../../../utils/api/clients/scriptSettings.ts";
import { SettingsInput, SettingsTextarea } from "../components/SettingsField";
import { useServerSettings } from "../SettingsProviders";
import { SettingsLink, useSettingsRoute } from "../settingsRoute";
import type { SettingsState } from "../utils";
import { readApiError } from "../utils/apiError.ts";
import {
  SettingsActions,
  SettingsGroup,
  SettingsPage,
  SettingsRow,
  SettingsServiceRow,
} from "../SettingsLayout";

// Custom script hooks. The server only sends script settings while
// AURRAL_SCRIPTS_DIR is set, so none of this renders without it.

type Integrations = SettingsState["integrations"];
type Script = NonNullable<Integrations["scripts"]>[number];
type ScriptRun = Awaited<ReturnType<typeof runTest>>;

const MAX_SCRIPTS = 10;
const OUTPUT_TAIL = 4000;

const runTest = (json: { name: string; file: string; args: string[]; timeoutSec: number }) =>
  parseResponse(scriptSettingsClient.test.$post({ json }));

export const scriptsEnabled = (integrations: Integrations) => Array.isArray(integrations.scripts);

export function resolveScriptItem(scripts: Script[] | undefined, item: string | null) {
  if (!scripts) return null;
  if (item === "script") return { index: null };
  const match = item?.match(/^script-(\d+)$/);
  const index = match ? Number(match[1]) : -1;
  return index >= 0 && index < scripts.length ? { index } : null;
}

function describeRun(run: ScriptRun) {
  const seconds = (run.durationMs / 1000).toFixed(1);
  if (run.timedOut) return `Timed out after ${seconds}s.`;
  if (run.exitCode === null) return `Stopped by ${run.signal} after ${seconds}s.`;
  return `Exit code ${run.exitCode} after ${seconds}s.`;
}

export function ScriptDetail({ index }: { index: number | null }) {
  const { settings, updateSettings } = useServerSettings();
  const route = useSettingsRoute();
  const scripts = settings.integrations.scripts ?? [];
  const existing = index === null ? undefined : scripts[index];
  const [name, setName] = useState(existing?.name ?? "");
  const [file, setFile] = useState(existing?.file ?? "");
  const [args, setArgs] = useState((existing?.args ?? []).join("\n"));
  const [timeoutSec, setTimeoutSec] = useState(String(existing?.timeoutSec ?? 60));
  const [enabled, setEnabled] = useState(existing?.enabled !== false);
  const [missingFile, setMissingFile] = useState(false);
  const [testing, setTesting] = useState(false);
  const [run, setRun] = useState<ScriptRun | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const files = useQuery({
    queryKey: ["settings", "scripts", "files"],
    queryFn: () => parseResponse(scriptSettingsClient.files.$get()),
  });

  const draft = {
    name: name.trim(),
    file: file.trim(),
    args: args.split("\n").filter((arg) => arg !== ""),
    timeoutSec: Math.max(1, Math.floor(Number(timeoutSec)) || 60),
  };

  const edited =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      setRun(null);
      setTestError(null);
      set(value);
    };

  const save = (next: Script[]) =>
    updateSettings({ ...settings, integrations: { ...settings.integrations, scripts: next } });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft.file) {
      setMissingFile(true);
      return;
    }
    const script = { ...draft, enabled };
    save(
      index === null
        ? [...scripts, script]
        : scripts.map((entry, i) => (i === index ? script : entry)),
    );
    route.back();
  };

  const remove = () => {
    if (index === null) return;
    save(scripts.filter((_entry, i) => i !== index));
    route.back();
  };

  const test = async () => {
    setTesting(true);
    setRun(null);
    setTestError(null);
    try {
      setRun(await runTest(draft));
    } catch (error) {
      const reason = readApiError(error);
      setTestError(reason.message || reason.error || reason.text || "Test failed.");
    } finally {
      setTesting(false);
    }
  };

  const status = missingFile
    ? { tone: "error" as const, message: "Choose a script file." }
    : testError
      ? { tone: "error" as const, message: testError }
      : run
        ? {
            tone: run.success ? ("success" as const) : ("error" as const),
            message: describeRun(run),
          }
        : null;

  return (
    <SettingsPage title={index === null ? "Add script" : "Script"} back="Notifications">
      <SettingsGroup>
        <form onSubmit={submit}>
          <SettingsRow label="Name" htmlFor="script-name">
            <SettingsInput
              id="script-name"
              placeholder="Tag new albums"
              autoComplete="off"
              value={name}
              onChange={(event) => edited(setName)(event.target.value)}
            />
          </SettingsRow>
          <SettingsRow
            label="File"
            htmlFor="script-file"
            help="An executable in the scripts folder. Aurral runs it directly, without a shell."
          >
            <SettingsInput
              id="script-file"
              list="script-files"
              placeholder="script.sh"
              spellCheck={false}
              autoComplete="off"
              value={file}
              onChange={(event) => {
                setMissingFile(false);
                edited(setFile)(event.target.value);
              }}
            />
            <datalist id="script-files">
              {(files.data?.files ?? []).map((entry) => (
                <option key={entry.name} value={entry.name}>
                  {entry.executable ? entry.name : `${entry.name} (not executable)`}
                </option>
              ))}
            </datalist>
          </SettingsRow>
          <SettingsRow
            label="Arguments"
            htmlFor="script-args"
            help="One per line, passed as-is. Event details arrive as AURRAL_* environment variables and as JSON on standard input."
            stack
          >
            <SettingsTextarea
              id="script-args"
              rows={3}
              spellCheck={false}
              autoComplete="off"
              value={args}
              onChange={(event) => edited(setArgs)(event.target.value)}
            />
          </SettingsRow>
          <SettingsRow label="Timeout (seconds)" htmlFor="script-timeout">
            <SettingsInput
              id="script-timeout"
              type="number"
              min={1}
              max={3600}
              value={timeoutSec}
              onChange={(event) => edited(setTimeoutSec)(event.target.value)}
            />
          </SettingsRow>
          <SettingsRow label="Enabled" htmlFor="script-enabled">
            <PillToggle
              id="script-enabled"
              checked={enabled}
              aria-label="Enabled"
              onChange={(event) => setEnabled(event.target.checked)}
            />
          </SettingsRow>
          <SettingsActions status={status}>
            <button type="submit" className="btn btn-primary btn-sm">
              {index === null ? "Add script" : "Save"}
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={test}
              disabled={testing || !draft.file}
            >
              {testing ? <DotLoader size="xs" label={null} /> : null}
              Test
            </button>
            {index === null ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={route.back}>
                Cancel
              </button>
            ) : (
              <button type="button" className="btn btn-ghost btn-sm" onClick={remove}>
                Delete
              </button>
            )}
          </SettingsActions>
          {run ? (
            <SettingsRow label="Output" stack>
              <pre className="settings-script-output">
                {run.output
                  ? `${run.truncated || run.output.length > OUTPUT_TAIL ? "…" : ""}${run.output.slice(-OUTPUT_TAIL)}`
                  : "No output."}
              </pre>
            </SettingsRow>
          ) : null}
        </form>
      </SettingsGroup>
    </SettingsPage>
  );
}

export function ScriptsGroups({
  eventToggles,
}: {
  eventToggles: (scriptEvents: NonNullable<Integrations["scriptEvents"]>) => ReactNode;
}) {
  const { settings } = useServerSettings();
  const { scripts, scriptEvents } = settings.integrations;
  if (!scripts || !scriptEvents) return null;
  return (
    <>
      <SettingsGroup
        title="Scripts"
        actions={
          scripts.length < MAX_SCRIPTS ? (
            <SettingsLink to="notifications/script" className="btn btn-secondary btn-sm">
              Add script
            </SettingsLink>
          ) : null
        }
      >
        {scripts.length === 0 ? (
          <p className="settings-group__note">No scripts yet.</p>
        ) : (
          scripts.map((script, index) => (
            <SettingsServiceRow
              key={`${script.file}-${index}`}
              to={`notifications/script-${index}`}
              name={script.name || script.file}
              status={script.enabled === false ? { label: "Off" } : undefined}
            />
          ))
        )}
      </SettingsGroup>
      {scripts.length > 0 ? (
        <SettingsGroup title="Script events">{eventToggles(scriptEvents)}</SettingsGroup>
      ) : null}
    </>
  );
}
