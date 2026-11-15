// Host renderer for generic plugin admin pages (v2). Plugins send bounded data;
// everything here is Aurral's own markup, components and design tokens.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { useBlocker } from "react-router";
import type {
  PluginPageV2Action,
  PluginPageV2Data,
  PluginPageV2Field,
} from "../../../backend/services/plugins/pluginPages.ts";
import { pluginsClient } from "../utils/api/clients/plugins.ts";
import { readApiError } from "../utils/api/errors.ts";
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
export type AdminNavigation = { preserveScroll?: boolean };
type GoOptions = AdminNavigation & { force?: boolean; focus?: string };
// Where an action started: a section id, "list" for the browse list or
// "view" for the entry's header. Its result is reported there.
type Origin = string;
type Request = { command: string; values: Values; origin: Origin };

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
  const [activeIndex, setActiveIndex] = useState(-1);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    query: string;
    options: { value: string; label: string; detail?: string }[];
    error: boolean;
  } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  const statusId = useId();
  const loading = result?.query !== query;
  const options = !loading && result && !result.error ? result.options : [];
  const activeId = open && options[activeIndex] ? `${listId}-${activeIndex}` : undefined;
  const begin = () => {
    setQuery("");
    setResult(null);
    setActiveIndex(-1);
    setOpen(true);
  };
  const retry = () => {
    setResult(null);
    setAttempt((current) => current + 1);
  };
  const choose = (option: (typeof options)[number]) => {
    onChange(option.value, option.label);
    setOpen(false);
    setActiveIndex(-1);
  };
  useEffect(() => {
    if (!open || disabled) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      parseResponse(
        pluginsClient[":id"].pages[":pageId"].$get(
          { param: { id: pluginId, pageId }, query: { lookup: field.lookup ?? "", q: query } },
          { init: { signal: controller.signal } },
        ),
      )
        .then((response) => {
          if (controller.signal.aborted) return;
          if (!("lookup" in response)) throw new Error("Invalid lookup response");
          setResult({ query, options: response.options, error: false });
        })
        .catch(() => {
          if (!controller.signal.aborted) setResult({ query, options: [], error: true });
        });
    }, 200);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [open, disabled, query, field.lookup, pluginId, pageId, attempt]);
  useEffect(() => {
    const menu = list.current;
    const option = menu?.children[activeIndex];
    if (!menu || !(option instanceof HTMLElement)) return;
    if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight)
      menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight;
  }, [activeIndex, activeId]);
  return (
    <div
      className="plugin-admin__lookup"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <div className="activity-toolbar__filter plugin-admin__lookup-input">
        <Search aria-hidden="true" />
        <input
          ref={input}
          id={id}
          type="search"
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={activeId}
          aria-describedby={open ? statusId : undefined}
          aria-autocomplete="list"
          aria-required={field.required || undefined}
          autoComplete="off"
          maxLength={200}
          disabled={disabled}
          placeholder={field.placeholder || "Search"}
          value={open ? query : label}
          onFocus={() => {
            if (!open) begin();
          }}
          onChange={(event) => {
            if (open && event.target.value === query) return;
            setQuery(event.target.value);
            setResult(null);
            setActiveIndex(-1);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (!open) begin();
              else if (options.length)
                setActiveIndex((current) =>
                  event.key === "ArrowDown"
                    ? Math.min(current + 1, options.length - 1)
                    : current <= 0
                      ? options.length - 1
                      : current - 1,
                );
            } else if (open && options.length && (event.key === "Home" || event.key === "End")) {
              event.preventDefault();
              setActiveIndex(event.key === "Home" ? 0 : options.length - 1);
            } else if (open && event.key === "Enter") {
              event.preventDefault();
              if (result?.error && !loading) retry();
              else if (options[activeIndex]) choose(options[activeIndex]);
            }
          }}
        />
        {value && !open ? (
          <TooltipButton
            label={`Clear ${field.label.toLowerCase()}`}
            className="btn"
            disabled={disabled}
            onClick={() => {
              onChange("", "");
              input.current?.focus();
              setOpen(false);
            }}
          >
            <X aria-hidden="true" />
          </TooltipButton>
        ) : null}
      </div>
      {open ? (
        <div className="plugin-admin__lookup-list">
          <div
            id={statusId}
            role="status"
            aria-live="polite"
            className="plugin-admin__lookup-empty"
          >
            {loading ? (
              <>
                <DotLoader size="xs" label={null} /> Searching…
              </>
            ) : result?.error ? (
              <>
                <AlertCircle aria-hidden="true" />
                <span>{"Couldn't load results."}</span>
                <button
                  type="button"
                  className="plugin-admin__link"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    retry();
                    input.current?.focus();
                  }}
                >
                  Try again
                </button>
              </>
            ) : options.length ? (
              `${options.length} result${options.length === 1 ? "" : "s"}. Use arrow keys and Enter to choose.`
            ) : query ? (
              "No matches"
            ) : (
              "Type to search"
            )}
          </div>
          {/* Scroll containers can be implicit tab stops; keep focus in the combobox. */}
          <ul
            ref={list}
            tabIndex={-1}
            id={listId}
            role="listbox"
            aria-label={`${field.label} results`}
            aria-busy={loading}
            className="plugin-admin__lookup-options"
          >
            {options.map((option, index) => (
              <li
                key={option.value}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === activeIndex}
              >
                <button
                  type="button"
                  tabIndex={-1}
                  className="plugin-admin__lookup-option"
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => setActiveIndex(index)}
                  onClick={() => choose(option)}
                >
                  <span>{option.label}</span>
                  {option.detail ? (
                    <span className="plugin-admin__lookup-detail">{option.detail}</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
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
  saving,
  feedback,
  pluginId,
  pageId,
  onDirty,
  onSubmit,
  onAction,
}: {
  section: Extract<Section, { type: "form" }>;
  disabled: boolean;
  // This form's own submit is in flight.
  saving: boolean;
  // The result of this form's last action, shown in its footer.
  feedback: ReactNode;
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
        if (disabled) return;
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
      {/* Stays at the bottom of the screen while a long form scrolls past. */}
      <div className="plugin-admin__form-footer" data-dirty={dirty}>
        <div className="settings-actions plugin-admin__form-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={disabled}
            aria-busy={saving || undefined}
          >
            {saving ? (
              <>
                <DotLoader size="xs" label={null} /> Saving…
              </>
            ) : (
              section.submitLabel
            )}
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
          {section.actions.map((action) => (
            <button
              key={action.command + action.label}
              type="button"
              className={`btn ${action.tone === "danger" ? "btn-ghost plugin-admin__danger" : "btn-ghost"}`}
              disabled={disabled}
              onClick={() => onAction(action)}
            >
              {action.label}
            </button>
          ))}
          {dirty && !saving ? <span className="plugin-admin__unsaved">Unsaved changes</span> : null}
        </div>
        {feedback}
      </div>
    </form>
  );
}

function RowItem({
  row,
  active = false,
  disabled,
  ticked,
  onTick,
  onSelect,
  onAction,
}: {
  row: Row;
  active?: boolean;
  disabled: boolean;
  // Set when the section lets a person tick rows for bulk actions.
  ticked?: boolean;
  onTick?: (ticked: boolean) => void;
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
      {onTick ? (
        <input
          type="checkbox"
          className="plugin-admin__tick"
          aria-label={`Select ${row.label}`}
          checked={Boolean(ticked)}
          disabled={disabled}
          onChange={(event) => onTick(event.target.checked)}
        />
      ) : null}
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
  id,
  title,
  actions,
  children,
}: {
  // The plugin's section id: a command result can bring it into view.
  id?: string;
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      id={id ? `plugin-section-${id}` : undefined}
      className="settings-group plugin-admin__group"
      aria-labelledby={title ? headingId : undefined}
    >
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

type RowsSelect = Extract<Section, { type: "rows" }>["select"];

// Ticks rows and runs an action on them: "3 selected · Select all · Clear".
function BulkBar({
  select,
  rows,
  ticked,
  disabled,
  onTick,
  onAction,
}: {
  select: NonNullable<RowsSelect>;
  rows: Row[];
  ticked: string[];
  disabled: boolean;
  onTick: (ids: string[]) => void;
  onAction: (action: PluginPageV2Action, ids: string[]) => void;
}) {
  const all = rows.map((row) => row.id);
  return (
    <div
      className="plugin-admin__bulk"
      data-selected={ticked.length > 0}
      role="group"
      aria-label="Selected items"
    >
      <span className="plugin-admin__bulk-count">
        {ticked.length ? `${ticked.length} selected` : "None selected"}
      </span>
      <button
        type="button"
        className="plugin-admin__link"
        disabled={disabled || ticked.length === all.length}
        onClick={() => onTick(all)}
      >
        Select all {all.length}
      </button>
      {ticked.length ? (
        <button
          type="button"
          className="plugin-admin__link"
          disabled={disabled}
          onClick={() => onTick([])}
        >
          Clear
        </button>
      ) : null}
      <div className="plugin-admin__bulk-actions">
        {select.actions.map((action) => (
          <button
            key={action.command + action.label}
            type="button"
            className={`btn btn-sm ${action.tone === "danger" ? "btn-ghost plugin-admin__danger" : "btn-secondary"}`}
            disabled={disabled || !ticked.length}
            onClick={() => onAction(action, ticked)}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// "1–100 of 640 ‹ ›", shown above and below a long list so nobody scrolls
// to the end to change pages.
function Pager({
  label,
  previous,
  next,
  disabled = false,
  onPrevious,
  onNext,
}: {
  label: string;
  previous: boolean;
  next: boolean;
  disabled?: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <div className="plugin-admin__pager">
      <span>{label}</span>
      <TooltipButton
        label="Previous page"
        className="btn btn-ghost btn-icon btn-sm"
        disabled={disabled || !previous}
        onClick={onPrevious}
      >
        <ChevronLeft aria-hidden="true" />
      </TooltipButton>
      <TooltipButton
        label="Next page"
        className="btn btn-ghost btn-icon btn-sm"
        disabled={disabled || !next}
        onClick={onNext}
      >
        <ChevronRight aria-hidden="true" />
      </TooltipButton>
    </div>
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
  onNavigate: (next: Partial<AdminParams>, options?: AdminNavigation) => void;
  onRefetch: () => Promise<unknown>;
}) {
  const [search, setSearch] = useState(params.q);
  const searchHelpId = useId();
  const [message, setMessage] = useState("");
  const [error, setError] = useState<{ text: string; conflict: boolean } | null>(null);
  const [dirtyForms, setDirtyForms] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<{ next: Partial<AdminParams>; options: GoOptions } | null>(
    null,
  );
  const [pendingMutation, setPendingMutation] = useState<(Request & { forms: string[] }) | null>(
    null,
  );
  // The last action's origin, and the section its result brought into view.
  const [report, setReport] = useState<{ origin: Origin; focus: string | null }>({
    origin: "view",
    focus: null,
  });
  const [pendingReload, setPendingReload] = useState(false);
  const [formReset, setFormReset] = useState(0);
  // A section to bring into view once the page shows it (a step of a task
  // further down the page, or a section's next page).
  const [focus, setFocus] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<(PluginPageV2Action & { origin: Origin }) | null>(
    null,
  );
  // Ticked rows, per section ("list" for the browse list).
  const [ticked, setTicked] = useState<Record<string, string[]>>({});
  const tickedIn = (id: string, rows: Row[]) => {
    const shown = new Set(rows.map((row) => row.id));
    return (ticked[id] ?? []).filter((rowId) => shown.has(rowId));
  };
  const tick = (id: string, ids: string[]) => setTicked((current) => ({ ...current, [id]: ids }));
  const toggle = (id: string, rowId: string, on: boolean) =>
    setTicked((current) => {
      const rest = (current[id] ?? []).filter((entry) => entry !== rowId);
      return { ...current, [id]: on ? [...rest, rowId] : rest };
    });
  const dirty = Object.values(dirtyForms).some(Boolean);
  // Internal page links use go's guard below; the router also covers the
  // surrounding app navigation and browser back/forward.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation, historyAction }) =>
      dirty && (historyAction === "POP" || currentLocation.pathname !== nextLocation.pathname),
  );
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
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
  // that matches the opened item, and leave the list's page to the plugin
  // (an empty offset): it shows the page that holds the opened item.
  const open = (selection: string) => go({ selection, tab: "", q: "", offset: "" });
  const go = (next: Partial<AdminParams>, options: GoOptions = {}) => {
    if (dirty && !options.force) {
      setPending({ next, options });
      return;
    }
    setMessage("");
    setError(null);
    setDirtyForms({});
    setTicked({});
    setFocus(options.focus ?? null);
    onNavigate(next, { preserveScroll: Boolean(options.preserveScroll || options.focus) });
  };
  // Bring the focused section into view once it is on screen.
  useEffect(() => {
    if (!focus || fetching) return;
    const node = document.getElementById(`plugin-section-${focus}`);
    if (!node) return;
    setFocus(null);
    node.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, [focus, fetching, data]);

  const mutation = useMutation({
    mutationFn: async ({ command, values }: Request) =>
      parseResponse(
        pluginsClient[":id"].pages[":pageId"].$post({
          param: { id: pluginId, pageId },
          json: { command, values, revision: data.revision },
        }),
      ),
    onMutate: ({ origin }) => {
      setMessage("");
      setError(null);
      setReport({ origin, focus: null });
    },
    onSuccess: async (result, { command, origin }) => {
      setDirtyForms({});
      setFormReset((current) => current + 1);
      setTicked({});
      // Album pages and work pages read the catalogue the plugin just changed.
      void queryClient.invalidateQueries({ queryKey: ["plugin-album-presentation"] });
      void queryClient.invalidateQueries({ queryKey: ["plugin-resource", pluginId] });
      const text = "message" in result ? result.message : "Saved";
      const target = "focus" in result && typeof result.focus === "string" ? result.focus : null;
      if (
        "selection" in result &&
        typeof result.selection === "string" &&
        result.selection !== params.selection
      ) {
        // The list keeps its tab, search and page: resolving one review
        // item opens the next without losing the person's place. A step of
        // the same task keeps the reader where they are (or brings its
        // section into view); only "open" goes to the top of a new entry.
        // The result is reported in that section, or at the top of the entry
        // that opened; a list action that returns to the list reports there.
        setFocus(target);
        setReport({
          origin: origin === "list" && !result.selection ? "list" : "view",
          focus: target,
        });
        onNavigate(
          { selection: result.selection },
          { preserveScroll: command !== "open" || Boolean(target) },
        );
      }
      // Report the result once the updated page is on screen.
      else {
        await onRefetch();
        setFocus(target);
        setReport({ origin, focus: target });
      }
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
  const run = (request: Request, submittingForm?: string) => {
    const forms = Object.keys(dirtyForms).filter((id) => dirtyForms[id] && id !== submittingForm);
    if (forms.length) {
      setPendingMutation({ ...request, forms });
      return;
    }
    mutation.mutate(request);
  };
  const reload = () => {
    setError(null);
    setDirtyForms({});
    setFormReset((current) => current + 1);
    void onRefetch();
  };
  const runAction = (origin: Origin) => (action: PluginPageV2Action) => {
    if (action.confirm) setConfirming({ ...action, origin });
    else run({ command: action.command, values: action.arguments, origin });
  };
  const runBulk = (key: string, origin: Origin) => (action: PluginPageV2Action, ids: string[]) => {
    const withRows = { ...action, arguments: { ...action.arguments, [key]: ids } };
    if (action.confirm)
      setConfirming({
        ...withRows,
        origin,
        confirm: `${action.confirm} (${ids.length} selected)`,
      });
    else run({ command: withRows.command, values: withRows.arguments, origin });
  };

  const view = data.view;
  const total = data.list.total;
  const offset = data.list.offset;
  // Report beside the task: the section a result brought into view, else the
  // section the action started in, else the entry's header (or the list).
  const sectionIds = new Set(view?.sections.map((section) => section.id));
  const place = !view
    ? "list"
    : report.focus && sectionIds.has(report.focus)
      ? report.focus
      : sectionIds.has(report.origin) || report.origin === "list"
        ? report.origin
        : "view";
  const pendingRequest = busy ? mutation.variables : undefined;
  const feedback = (where: string, { saving = true }: { saving?: boolean } = {}) => {
    if (where !== place) return null;
    if (error)
      return (
        <div className="settings-note settings-note--error plugin-admin__error" role="alert">
          <AlertCircle aria-hidden="true" />
          <span>{error.text}</span>
          {error.conflict ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => {
                if (dirty) setPendingReload(true);
                else reload();
              }}
            >
              Reload
            </button>
          ) : null}
        </div>
      );
    if (busy && !saving) return null;
    if (!busy && !message) return null;
    return (
      <div className="plugin-admin__status plugin-admin__feedback">
        {busy ? (
          <>
            <DotLoader size="xs" label={null} /> Saving…
          </>
        ) : (
          message
        )}
      </div>
    );
  };
  // A section's pages are selections; the new page opens at the section.
  const sectionPager = (section: Extract<Section, { type: "rows" }>) => {
    const pager = section.pager;
    if (!pager) return null;
    return (
      <Pager
        label={pager.label}
        previous={Boolean(pager.previous)}
        next={Boolean(pager.next)}
        onPrevious={() =>
          pager.previous && go({ selection: pager.previous }, { focus: section.id })
        }
        onNext={() => pager.next && go({ selection: pager.next }, { focus: section.id })}
      />
    );
  };
  const listPager =
    total > PAGE_SIZE ? (
      <Pager
        label={`${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total}`}
        previous={offset > 0}
        next={offset + PAGE_SIZE < total}
        onPrevious={() => go({ offset: String(Math.max(0, offset - PAGE_SIZE)) })}
        onNext={() => go({ offset: String(offset + PAGE_SIZE) })}
      />
    ) : null;

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
                aria-describedby={searchHelpId}
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
            <button type="submit" className="btn btn-secondary btn-sm" disabled={busy || fetching}>
              Search
            </button>
          </form>
          <p
            id={searchHelpId}
            role="status"
            aria-live="polite"
            className="plugin-admin__search-status"
          >
            {fetching
              ? "Loading results…"
              : search !== params.q
                ? "Press Enter or Search to apply your search."
                : params.q
                  ? `${data.list.total} result${data.list.total === 1 ? "" : "s"} for “${params.q}”.`
                  : "Press Enter or Search to search this list."}
          </p>
          {data.list.actions.length ? (
            <div className="plugin-admin__list-actions">
              <ActionButtons
                actions={data.list.actions}
                disabled={busy}
                onAction={runAction("list")}
              />
            </div>
          ) : null}
          {feedback("list")}
          {listPager}
          {data.list.select && data.list.items.length ? (
            <BulkBar
              select={data.list.select}
              rows={data.list.items}
              ticked={tickedIn("list", data.list.items)}
              disabled={busy}
              onTick={(ids) => tick("list", ids)}
              onAction={runBulk(data.list.select.key, "list")}
            />
          ) : null}
          {data.list.items.length ? (
            <div className="settings-card plugin-admin__list-card">
              {data.list.items.map((item) => (
                <RowItem
                  key={item.id}
                  row={item}
                  active={!!item.selection && item.selection === params.selection}
                  disabled={busy}
                  {...(data.list.select && {
                    ticked: tickedIn("list", data.list.items).includes(item.id),
                    onTick: (on: boolean) => toggle("list", item.id, on),
                  })}
                  onSelect={(selection) => go({ selection })}
                  onAction={runAction("list")}
                />
              ))}
            </div>
          ) : (
            <p className="settings-group__note plugin-admin__empty">
              {data.list.empty || "Nothing here yet."}
            </p>
          )}
          {listPager}
        </aside>
        <div className="plugin-admin__detail">
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
                    <ActionButtons
                      actions={view.actions}
                      disabled={busy}
                      onAction={runAction("view")}
                    />
                  </div>
                ) : null}
              </div>
              {feedback("view") ?? <div className="plugin-admin__status" />}
              <div className="plugin-admin__sections">
                {view.sections.map((section) => {
                  if (section.type === "form") {
                    const saving =
                      pendingRequest?.origin === section.id &&
                      pendingRequest.command === section.command;
                    return (
                      // Entries share section ids such as "details", so the key names
                      // what the form edits; otherwise one entry's edits carry into the next.
                      <Group
                        key={`${section.id}:${data.revision}:${formReset}:${section.command}:${JSON.stringify(section.arguments)}`}
                        id={section.id}
                        title={section.title}
                      >
                        <FormSection
                          section={section}
                          disabled={busy || fetching}
                          saving={saving}
                          feedback={feedback(section.id, { saving: !saving })}
                          pluginId={pluginId}
                          pageId={pageId}
                          onDirty={dirtyFor(section.id)}
                          onAction={runAction(section.id)}
                          onSubmit={(values) =>
                            run(
                              {
                                command: section.command,
                                values: { ...section.arguments, ...values },
                                origin: section.id,
                              },
                              section.id,
                            )
                          }
                        />
                      </Group>
                    );
                  }
                  if (section.type === "rows")
                    return (
                      <Group
                        key={section.id}
                        id={section.id}
                        title={section.title}
                        actions={
                          section.actions.length ? (
                            <ActionButtons
                              actions={section.actions}
                              disabled={busy}
                              onAction={runAction(section.id)}
                            />
                          ) : null
                        }
                      >
                        {feedback(section.id)}
                        {section.note ? (
                          <p className="settings-group__note">{section.note}</p>
                        ) : null}
                        {sectionPager(section)}
                        {section.select && section.rows.length ? (
                          <BulkBar
                            select={section.select}
                            rows={section.rows}
                            ticked={tickedIn(section.id, section.rows)}
                            disabled={busy}
                            onTick={(ids) => tick(section.id, ids)}
                            onAction={runBulk(section.select.key, section.id)}
                          />
                        ) : null}
                        {section.rows.length ? (
                          <div className="settings-card">
                            {section.rows.map((row) => (
                              <RowItem
                                key={row.id}
                                row={row}
                                disabled={busy}
                                {...(section.select && {
                                  ticked: tickedIn(section.id, section.rows).includes(row.id),
                                  onTick: (on: boolean) => toggle(section.id, row.id, on),
                                })}
                                onSelect={open}
                                onAction={runAction(section.id)}
                              />
                            ))}
                          </div>
                        ) : (
                          <p className="settings-group__note">{section.empty || "None yet."}</p>
                        )}
                        {sectionPager(section)}
                      </Group>
                    );
                  return (
                    <Group key={section.id} id={section.id} title={section.title}>
                      {feedback(section.id)}
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
        open={pending !== null || pendingReload || blocker.state === "blocked"}
        title="Discard unsaved changes?"
        body="You have edits that haven't been saved."
        confirmLabel="Discard"
        busyLabel="Discarding"
        onCancel={() => {
          setPending(null);
          setPendingReload(false);
          if (blocker.state === "blocked") blocker.reset();
        }}
        onConfirm={() => {
          const next = pending;
          setPending(null);
          if (pendingReload) {
            setPendingReload(false);
            reload();
          } else if (blocker.state === "blocked") {
            setDirtyForms({});
            blocker.proceed();
          } else if (next) go(next.next, { ...next.options, force: true });
        }}
      />
      {/* One announcement per result, wherever it is shown. */}
      <div className="sr-only" role="status" aria-live="polite">
        {busy ? "Saving…" : message}
      </div>
      <ConfirmModal
        open={pendingMutation !== null}
        title={
          pendingMutation?.forms.includes(pendingMutation.origin)
            ? "Discard unsaved changes?"
            : "Discard other unsaved changes?"
        }
        body={`Your changes in ${(pendingMutation?.forms ?? []).map((id) => data.view?.sections.find((section) => section.id === id)?.title || id).join(", ")} haven't been saved. Discard them and continue with this action, or keep editing to save them first.`}
        cancelLabel="Keep editing"
        confirmLabel="Discard and continue"
        busyLabel="Working"
        onCancel={() => setPendingMutation(null)}
        onConfirm={() => {
          const request = pendingMutation;
          setPendingMutation(null);
          if (request)
            mutation.mutate({
              command: request.command,
              values: request.values,
              origin: request.origin,
            });
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
          if (action)
            run({ command: action.command, values: action.arguments, origin: action.origin });
        }}
      />
    </div>
  );
}
