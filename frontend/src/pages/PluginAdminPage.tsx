// Host renderer for generic plugin admin pages (v2). Plugins send bounded data;
// everything here is Aurral's own markup, components and design tokens.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import type {
  PluginPageV2Action,
  PluginPageV2Data,
  PluginPageV2Field,
} from "../../../backend/services/plugins/pluginPages.ts";
import { pluginsClient } from "../utils/api/clients/plugins.ts";
import { readApiError } from "./Settings/utils/apiError.ts";
import { Select } from "../components/Select";
import PillToggle from "../components/PillToggle";
import StatePanel from "../components/StatePanel";
import { ConfirmModal } from "../components/ConfirmModal";
import { DotLoader } from "../components/DotLoader";
import TooltipButton from "../components/TooltipButton";
import { AlertCircle, ChevronLeft, ChevronRight, Search, X } from "../components/icons";
import "./Settings/settings.css";
import "./PluginAdminPage.css";

type Section = NonNullable<PluginPageV2Data["view"]>["sections"][number];
type Row = PluginPageV2Data["list"]["items"][number];
type FieldValue = PluginPageV2Field["value"];
type Values = Record<string, FieldValue>;
type Tone = "default" | "muted" | "success" | "warning" | "error";
export type AdminParams = { selection: string; q: string; offset: string; tab: string };

const PAGE_SIZE = 100;

function Badge({ label, tone = "default" }: { label: string; tone?: Tone }) {
  return <span className={`plugin-admin__badge plugin-admin__badge--${tone}`}>{label}</span>;
}

function initialValues(fields: PluginPageV2Field[]): Values {
  return Object.fromEntries(fields.map((field) => [field.key, field.value]));
}

function LookupField({
  id,
  field,
  value,
  label,
  disabled,
  pluginId,
  pageId,
  onChange,
}: {
  id: string;
  field: PluginPageV2Field;
  value: string;
  label: string;
  disabled: boolean;
  pluginId: string;
  pageId: string;
  onChange: (value: string, label: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<{ value: string; label: string; detail?: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const listId = useId();
  useEffect(() => {
    if (!open) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      parseResponse(
        pluginsClient[":id"].pages[":pageId"].$get(
          { param: { id: pluginId, pageId }, query: { lookup: field.lookup ?? "", q: query } },
          { init: { signal: controller.signal } },
        ),
      )
        .then((result) => {
          if ("lookup" in result) setOptions(result.options);
        })
        .catch(() => setOptions([]))
        .finally(() => setLoading(false));
    }, 200);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [open, query, field.lookup, pluginId, pageId]);
  return (
    <div className="plugin-admin__lookup">
      <div className="activity-toolbar__filter plugin-admin__lookup-input">
        <Search aria-hidden="true" />
        <input
          id={id}
          type="search"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          autoComplete="off"
          disabled={disabled}
          placeholder={field.placeholder || "Search"}
          value={open ? query : label}
          onFocus={() => {
            setQuery("");
            setOpen(true);
          }}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
          }}
        />
        {value && !open ? (
          <TooltipButton
            label={`Clear ${field.label.toLowerCase()}`}
            className="btn"
            disabled={disabled}
            onClick={() => onChange("", "")}
          >
            <X aria-hidden="true" />
          </TooltipButton>
        ) : null}
      </div>
      {open ? (
        <ul id={listId} role="listbox" className="plugin-admin__lookup-list">
          {loading && !options.length ? (
            <li className="plugin-admin__lookup-empty">
              <DotLoader size="xs" label={null} /> Searching…
            </li>
          ) : options.length ? (
            options.map((option) => (
              <li key={option.value} role="option" aria-selected={option.value === value}>
                <button
                  type="button"
                  className="plugin-admin__lookup-option"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    onChange(option.value, option.label);
                    setOpen(false);
                  }}
                >
                  <span>{option.label}</span>
                  {option.detail ? (
                    <span className="plugin-admin__lookup-detail">{option.detail}</span>
                  ) : null}
                </button>
              </li>
            ))
          ) : (
            <li className="plugin-admin__lookup-empty">No matches</li>
          )}
        </ul>
      ) : null}
    </div>
  );
}

function FieldMeta({
  field,
  disabled,
  onAction,
}: {
  field: PluginPageV2Field;
  disabled: boolean;
  onAction: (action: PluginPageV2Action) => void;
}) {
  if (!field.meta && !field.actions.length) return null;
  return (
    <div className="plugin-admin__meta">
      {field.meta ? (
        <Badge
          label={`${field.meta.source}${field.meta.pinned ? " · Pinned" : ""}`}
          tone={field.meta.pinned ? "default" : "muted"}
        />
      ) : null}
      {field.meta?.provider ? (
        <span className="plugin-admin__provider">{field.meta.provider}</span>
      ) : null}
      {field.actions.map((action) => (
        <button
          key={action.command + action.label}
          type="button"
          className="plugin-admin__link"
          disabled={disabled}
          onClick={() => onAction(action)}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}

function FormSection({
  section,
  disabled,
  pluginId,
  pageId,
  onDirty,
  onSubmit,
  onAction,
}: {
  section: Extract<Section, { type: "form" }>;
  disabled: boolean;
  pluginId: string;
  pageId: string;
  onDirty: (dirty: boolean) => void;
  onSubmit: (values: Values) => void;
  onAction: (action: PluginPageV2Action) => void;
}) {
  const base = useMemo(() => initialValues(section.fields), [section.fields]);
  const [values, setValues] = useState<Values>(base);
  const [labels, setLabels] = useState<Record<string, string>>(() =>
    Object.fromEntries(section.fields.map((field) => [field.key, field.valueLabel ?? ""])),
  );
  const dirty = JSON.stringify(values) !== JSON.stringify(base);
  useEffect(() => {
    onDirty(dirty);
    return () => onDirty(false);
  }, [dirty, onDirty]);
  const formId = useId();
  const set = (key: string, value: FieldValue) =>
    setValues((current) => ({ ...current, [key]: value }));
  const control = (field: PluginPageV2Field, id: string): ReactNode => {
    const value = values[field.key];
    switch (field.type) {
      case "checkbox":
        return (
          <PillToggle
            id={id}
            aria-label={field.label}
            checked={value === true}
            disabled={disabled}
            onChange={(event) => set(field.key, event.target.checked)}
          />
        );
      case "select":
        return (
          <Select
            id={id}
            aria-label={field.label}
            value={String(value)}
            options={field.options}
            disabled={disabled}
            onChange={(next) => set(field.key, next)}
          />
        );
      case "textarea":
      case "lines":
        return (
          <textarea
            id={id}
            className={`input settings-textarea${field.type === "lines" ? " plugin-admin__lines" : ""}`}
            rows={field.type === "lines" ? 3 : 4}
            maxLength={10000}
            required={field.required}
            placeholder={field.placeholder}
            disabled={disabled}
            value={Array.isArray(value) ? value.join("\n") : String(value)}
            onChange={(event) =>
              set(
                field.key,
                field.type === "lines" ? event.target.value.split("\n") : event.target.value,
              )
            }
          />
        );
      case "lookup":
        return (
          <LookupField
            id={id}
            field={field}
            value={String(value)}
            label={labels[field.key] ?? ""}
            disabled={disabled}
            pluginId={pluginId}
            pageId={pageId}
            onChange={(next, label) => {
              set(field.key, next);
              setLabels((current) => ({ ...current, [field.key]: label }));
            }}
          />
        );
      case "mapping":
        return null;
      default:
        return (
          <input
            id={id}
            className="input"
            maxLength={10000}
            required={field.required}
            placeholder={field.placeholder}
            disabled={disabled}
            value={String(value)}
            onChange={(event) => set(field.key, event.target.value)}
          />
        );
    }
  };
  return (
    <form
      className="settings-card plugin-admin__form"
      onSubmit={(event) => {
        event.preventDefault();
        // Lines are edited as text; send them back without blank entries.
        const cleaned = Object.fromEntries(
          section.fields.map((field): [string, FieldValue] => {
            const value = values[field.key] ?? field.value;
            return [
              field.key,
              field.type === "lines" && Array.isArray(value)
                ? value.map((line) => line.trim()).filter(Boolean)
                : value,
            ];
          }),
        );
        onSubmit(cleaned);
      }}
    >
      {section.note ? <p className="settings-group__note">{section.note}</p> : null}
      {section.fields.map((field) => {
        const id = `${formId}-${field.key}`;
        if (field.type === "mapping") {
          const mapped = Array.isArray(values[field.key]) ? (values[field.key] as string[]) : [];
          return (
            <div
              key={field.key}
              className="plugin-admin__mapping"
              role="group"
              aria-label={field.label}
            >
              {field.rows.map((row, index) => (
                <div className="settings-row" key={index}>
                  <div className="settings-row__copy">
                    <span className="settings-row__label">{row.label}</span>
                    {row.detail ? <p className="settings-row__help">{row.detail}</p> : null}
                  </div>
                  <div className="settings-row__control">
                    <Select
                      aria-label={`${field.label} for ${row.label}`}
                      value={mapped[index] ?? ""}
                      options={field.options}
                      disabled={disabled}
                      onChange={(next) => {
                        const updated = field.rows.map((_, i) => mapped[i] ?? "");
                        updated[index] = next;
                        set(field.key, updated);
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          );
        }
        const stack = ["textarea", "lines", "lookup"].includes(field.type);
        return (
          <div key={field.key} className={`settings-row${stack ? " settings-row--stack" : ""}`}>
            <div className="settings-row__copy">
              <label className="settings-row__label" htmlFor={id}>
                {field.label}
              </label>
              {field.help ? <p className="settings-row__help">{field.help}</p> : null}
              <FieldMeta field={field} disabled={disabled || dirty} onAction={onAction} />
            </div>
            <div className="settings-row__control">{control(field, id)}</div>
          </div>
        );
      })}
      <div className="settings-actions plugin-admin__form-actions">
        <button type="submit" className="btn btn-primary" disabled={disabled}>
          {section.submitLabel}
        </button>
        {dirty ? (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={disabled}
            onClick={() => {
              setValues(base);
              setLabels(
                Object.fromEntries(
                  section.fields.map((field) => [field.key, field.valueLabel ?? ""]),
                ),
              );
            }}
          >
            Discard changes
          </button>
        ) : null}
      </div>
    </form>
  );
}

function RowItem({
  row,
  active = false,
  disabled,
  onSelect,
  onAction,
}: {
  row: Row;
  active?: boolean;
  disabled: boolean;
  onSelect: (selection: string) => void;
  onAction: (action: PluginPageV2Action) => void;
}) {
  const body = (
    <>
      <span className="settings-service__name">
        {row.label}
        {row.detail ? <span className="settings-service__detail">{row.detail}</span> : null}
      </span>
      {row.badge ? <Badge label={row.badge.label} tone={row.badge.tone} /> : null}
    </>
  );
  return (
    <div className={`plugin-admin__row${active ? " is-active" : ""}`}>
      {row.selection ? (
        <button
          type="button"
          aria-current={active ? "page" : undefined}
          className="settings-service plugin-admin__row-main"
          onClick={() => onSelect(row.selection!)}
        >
          {body}
          <ChevronRight className="settings-service__chevron" aria-hidden="true" />
        </button>
      ) : (
        <div className="settings-service plugin-admin__row-main">{body}</div>
      )}
      {row.actions.length ? (
        <div className="plugin-admin__row-actions">
          {row.actions.map((action) => (
            <button
              key={action.command + action.label}
              type="button"
              className={`btn btn-sm ${action.tone === "danger" ? "btn-ghost plugin-admin__danger" : "btn-ghost"}`}
              aria-label={`${action.label}: ${row.label}`}
              disabled={disabled}
              onClick={() => onAction(action)}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Group({
  title,
  actions,
  children,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section className="settings-group" aria-labelledby={title ? headingId : undefined}>
      {title || actions ? (
        <div className="settings-group__head">
          {title ? (
            <h3 id={headingId} className="settings-group__title">
              {title}
            </h3>
          ) : null}
          {actions ? <div className="settings-group__actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

function ActionButtons({
  actions,
  disabled,
  onAction,
}: {
  actions: PluginPageV2Action[];
  disabled: boolean;
  onAction: (action: PluginPageV2Action) => void;
}) {
  return (
    <>
      {actions.map((action) => (
        <button
          key={action.command + action.label}
          type="button"
          className={`btn btn-sm ${action.tone === "danger" ? "btn-ghost plugin-admin__danger" : "btn-secondary"}`}
          disabled={disabled}
          onClick={() => onAction(action)}
        >
          {action.label}
        </button>
      ))}
    </>
  );
}

export default function PluginAdminPage({
  pluginId,
  pageId,
  data,
  params,
  fetching,
  onNavigate,
  onRefetch,
}: {
  pluginId: string;
  pageId: string;
  data: PluginPageV2Data;
  params: AdminParams;
  fetching: boolean;
  onNavigate: (next: Partial<AdminParams>) => void;
  onRefetch: () => Promise<unknown>;
}) {
  const [search, setSearch] = useState(params.q);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<{ text: string; conflict: boolean } | null>(null);
  const [dirtyForms, setDirtyForms] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<Partial<AdminParams> | null>(null);
  const [confirming, setConfirming] = useState<PluginPageV2Action | null>(null);
  const dirty = Object.values(dirtyForms).some(Boolean);
  const detailRef = useRef<HTMLDivElement>(null);
  const dirtySetters = useRef(new Map<string, (dirty: boolean) => void>());
  const dirtyFor = (id: string) => {
    let setter = dirtySetters.current.get(id);
    if (!setter) {
      setter = (value: boolean) =>
        setDirtyForms((current) => (current[id] === value ? current : { ...current, [id]: value }));
      dirtySetters.current.set(id, setter);
    }
    return setter;
  };

  useEffect(() => setSearch(params.q), [params.q]);

  // Links inside the detail view clear the tab so the plugin shows the list
  // that matches the opened item.
  const open = (selection: string) => go({ selection, tab: "", q: "", offset: "0" });
  const go = (next: Partial<AdminParams>, force = false) => {
    if (dirty && !force) {
      setPending(next);
      return;
    }
    setMessage("");
    setError(null);
    setDirtyForms({});
    onNavigate(next);
    detailRef.current?.scrollTo?.({ top: 0 });
  };

  const mutation = useMutation({
    mutationFn: async ({ command, values }: { command: string; values: Values }) =>
      parseResponse(
        pluginsClient[":id"].pages[":pageId"].$post({
          param: { id: pluginId, pageId },
          json: { command, values, revision: data.revision },
        }),
      ),
    onMutate: () => {
      setMessage("");
      setError(null);
    },
    onSuccess: async (result) => {
      setDirtyForms({});
      const text = "message" in result ? result.message : "Saved";
      if (
        "selection" in result &&
        typeof result.selection === "string" &&
        result.selection !== params.selection
      )
        onNavigate(
          result.selection
            ? { selection: result.selection, tab: "", q: "", offset: "0" }
            : { selection: "" },
        );
      // Report the result once the updated page is on screen.
      else await onRefetch();
      setMessage(text);
    },
    onError: (failure: unknown) => {
      setMessage("");
      const details = readApiError(failure);
      setError({
        text: details.error || details.message || details.text || "Couldn't save. Try again.",
        conflict: details.status === 409,
      });
    },
  });
  const busy = mutation.isPending;
  const run = (command: string, values: Values) => mutation.mutate({ command, values });
  const runAction = (action: PluginPageV2Action) => {
    if (action.confirm) setConfirming(action);
    else run(action.command, action.arguments);
  };

  const view = data.view;
  const total = data.list.total;
  const offset = data.list.offset;

  return (
    <div className="plugin-admin" data-view={view ? "detail" : "list"}>
      <header className="plugin-admin__head">
        <h1 className="plugin-admin__title">{data.title}</h1>
        {data.description ? <p className="plugin-admin__description">{data.description}</p> : null}
      </header>
      {data.tabs.length ? (
        <div className="activity-toolbar plugin-admin__toolbar">
          <div className="activity-status-tabs" role="group" aria-label="Browse">
            {data.tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`activity-status-tab${tab.id === data.tab ? " is-active" : ""}`}
                aria-pressed={tab.id === data.tab}
                onClick={() => go({ tab: tab.id, q: "", offset: "0", selection: "" })}
              >
                {tab.label}
                {tab.count != null ? (
                  <span className="activity-status-tab__count">{tab.count}</span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {data.notes.map((note, index) => (
        <p
          key={index}
          className={`settings-note settings-note--${note.tone === "error" ? "error" : note.tone === "warning" ? "warning" : "default"} plugin-admin__note`}
        >
          {note.tone === "error" || note.tone === "warning" ? (
            <AlertCircle aria-hidden="true" />
          ) : null}
          <span>{note.text}</span>
        </p>
      ))}
      <div className="plugin-admin__layout">
        <aside className="plugin-admin__list" aria-label="Items">
          <form
            role="search"
            className="plugin-admin__search"
            onSubmit={(event) => {
              event.preventDefault();
              go({ q: search, offset: "0" });
            }}
          >
            <label className="activity-toolbar__filter plugin-admin__filter">
              <Search aria-hidden="true" />
              <input
                type="search"
                aria-label={data.list.placeholder || "Search"}
                placeholder={data.list.placeholder || "Search"}
                maxLength={200}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              {search ? (
                <TooltipButton
                  label="Clear search"
                  className="btn"
                  onClick={() => {
                    setSearch("");
                    go({ q: "", offset: "0" });
                  }}
                >
                  <X aria-hidden="true" />
                </TooltipButton>
              ) : null}
            </label>
          </form>
          {data.list.actions.length ? (
            <div className="plugin-admin__list-actions">
              <ActionButtons actions={data.list.actions} disabled={busy} onAction={runAction} />
            </div>
          ) : null}
          {data.list.items.length ? (
            <div className="settings-card plugin-admin__list-card">
              {data.list.items.map((item) => (
                <RowItem
                  key={item.id}
                  row={item}
                  active={!!item.selection && item.selection === params.selection}
                  disabled={busy}
                  onSelect={(selection) => go({ selection })}
                  onAction={runAction}
                />
              ))}
            </div>
          ) : (
            <p className="settings-group__note plugin-admin__empty">
              {data.list.empty || "Nothing here yet."}
            </p>
          )}
          {total > PAGE_SIZE ? (
            <div className="plugin-admin__pager">
              <span>
                {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
              </span>
              <TooltipButton
                label="Previous page"
                className="btn btn-ghost btn-icon btn-sm"
                disabled={!offset}
                onClick={() => go({ offset: String(Math.max(0, offset - PAGE_SIZE)) })}
              >
                <ChevronLeft aria-hidden="true" />
              </TooltipButton>
              <TooltipButton
                label="Next page"
                className="btn btn-ghost btn-icon btn-sm"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => go({ offset: String(offset + PAGE_SIZE) })}
              >
                <ChevronRight aria-hidden="true" />
              </TooltipButton>
            </div>
          ) : null}
        </aside>
        <div className="plugin-admin__detail" ref={detailRef}>
          {view ? (
            <>
              <nav className="plugin-admin__crumbs" aria-label="Breadcrumb">
                <button
                  type="button"
                  className="plugin-admin__crumb"
                  onClick={() => go({ selection: "" })}
                >
                  <ChevronLeft aria-hidden="true" className="plugin-admin__crumb-back" />
                  {data.tabs.find((tab) => tab.id === data.tab)?.label || "All"}
                </button>
                {view.crumbs.map((crumb) => (
                  <button
                    key={crumb.selection}
                    type="button"
                    className="plugin-admin__crumb"
                    onClick={() => open(crumb.selection)}
                  >
                    {crumb.label}
                  </button>
                ))}
              </nav>
              <div className="plugin-admin__view-head">
                <div className="plugin-admin__view-title">
                  <h2>{view.title}</h2>
                  {view.subtitle ? <p>{view.subtitle}</p> : null}
                  {view.badges.length ? (
                    <div className="plugin-admin__badges">
                      {view.badges.map((item) => (
                        <Badge key={item.label} label={item.label} tone={item.tone} />
                      ))}
                    </div>
                  ) : null}
                </div>
                {view.actions.length ? (
                  <div className="plugin-admin__view-actions">
                    <ActionButtons actions={view.actions} disabled={busy} onAction={runAction} />
                  </div>
                ) : null}
              </div>
              <div className="plugin-admin__status" role="status" aria-live="polite">
                {busy ? (
                  <>
                    <DotLoader size="xs" label={null} /> Saving…
                  </>
                ) : message ? (
                  message
                ) : null}
              </div>
              {error ? (
                <div
                  className="settings-note settings-note--error plugin-admin__error"
                  role="alert"
                >
                  <AlertCircle aria-hidden="true" />
                  <span>{error.text}</span>
                  {error.conflict ? (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => {
                        setError(null);
                        setDirtyForms({});
                        void onRefetch();
                      }}
                    >
                      Reload
                    </button>
                  ) : null}
                </div>
              ) : null}
              <div className="plugin-admin__sections">
                {view.sections.map((section) => {
                  if (section.type === "form")
                    return (
                      // Entries share section ids such as "details", so the key names
                      // what the form edits; otherwise one entry's edits carry into the next.
                      <Group
                        key={`${section.id}:${data.revision}:${section.command}:${JSON.stringify(section.arguments)}`}
                        title={section.title}
                      >
                        <FormSection
                          section={section}
                          disabled={busy || fetching}
                          pluginId={pluginId}
                          pageId={pageId}
                          onDirty={dirtyFor(section.id)}
                          onAction={runAction}
                          onSubmit={(values) =>
                            run(section.command, { ...section.arguments, ...values })
                          }
                        />
                      </Group>
                    );
                  if (section.type === "rows")
                    return (
                      <Group
                        key={section.id}
                        title={section.title}
                        actions={
                          section.actions.length ? (
                            <ActionButtons
                              actions={section.actions}
                              disabled={busy}
                              onAction={runAction}
                            />
                          ) : null
                        }
                      >
                        {section.note ? (
                          <p className="settings-group__note">{section.note}</p>
                        ) : null}
                        {section.rows.length ? (
                          <div className="settings-card">
                            {section.rows.map((row) => (
                              <RowItem
                                key={row.id}
                                row={row}
                                disabled={busy}
                                onSelect={open}
                                onAction={runAction}
                              />
                            ))}
                          </div>
                        ) : (
                          <p className="settings-group__note">{section.empty || "None yet."}</p>
                        )}
                      </Group>
                    );
                  return (
                    <Group key={section.id} title={section.title}>
                      <div className="settings-card">
                        {section.items.map((item) => (
                          <div className="settings-row" key={item.label}>
                            <div className="settings-row__copy">
                              <span className="settings-row__label">{item.label}</span>
                            </div>
                            <div className="settings-row__control settings-row__value">
                              {item.selection ? (
                                <button
                                  type="button"
                                  className="plugin-admin__link"
                                  onClick={() => item.selection && open(item.selection)}
                                >
                                  {item.value}
                                </button>
                              ) : (
                                item.value
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </Group>
                  );
                })}
              </div>
            </>
          ) : (
            <StatePanel
              title="Nothing selected"
              message="Choose an item from the list, or create a new one."
            />
          )}
        </div>
      </div>
      <ConfirmModal
        open={pending !== null}
        title="Discard unsaved changes?"
        body="You have edits that haven't been saved."
        confirmLabel="Discard"
        busyLabel="Discarding"
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const next = pending;
          setPending(null);
          if (next) go(next, true);
        }}
      />
      <ConfirmModal
        open={confirming !== null}
        title={confirming?.label || "Confirm"}
        body={confirming?.confirm || ""}
        confirmLabel={confirming?.label || "Confirm"}
        tone={confirming?.tone === "danger" ? "danger" : "primary"}
        busyLabel="Working"
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const action = confirming;
          setConfirming(null);
          if (action) run(action.command, action.arguments);
        }}
      />
    </div>
  );
}
