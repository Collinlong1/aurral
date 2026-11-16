// A plugin's view 2 page: typed sections core renders with its own
// components. The plugin sends data; core builds links, plays rows through
// the queue and keeps the page's search, sort, filters, page and tab in the
// URL, so links, Back and reloads return to the same place.
import { Link } from "react-router";
import type { SetURLSearchParams } from "react-router";
import { useAudioQueue } from "../contexts/audioQueueContext.ts";
import { useToast } from "../contexts/ToastContext.tsx";
import { Select } from "../components/Select";
import TooltipButton from "../components/TooltipButton.tsx";
import { Inbox, ListEnd, ListStart } from "../components/icons";
import { pluginItemDurationMs, pluginQueueTrack } from "../utils/pluginQueue.ts";
import { formatDuration } from "./library/libraryShared.tsx";
import type { readPluginResource } from "../../../backend/services/plugins/pluginPresentation.ts";
import "./PluginResourceView.css";

export type ResourceView = Awaited<ReturnType<typeof readPluginResource>>;
export type PageView = Extract<ResourceView, { version: 2 }>;
type Section = PageView["sections"][number];
type Of<T extends Section["type"]> = Extract<Section, { type: T }>;
type ResolvedLink = { href: string | null; filters: Record<string, string[]> | null } | null;
type Mutation = NonNullable<Of<"header">["actions"][number]["mutation"]>;
type TrackItem = Of<"tracks">["items"][number];

// "composer=a,b;period=x", values encoded, as the backend reads them.
export const writeFilters = (filters: Record<string, string[]>) =>
  Object.entries(filters)
    .filter(([, values]) => values.length)
    .map(([key, values]) => `${key}=${values.map(encodeURIComponent).join(",")}`)
    .join(";");
export function readFilters(raw: string | null) {
  const filters: Record<string, string[]> = {};
  for (const part of (raw || "").split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    filters[part.slice(0, at)] = part
      .slice(at + 1)
      .split(",")
      .filter(Boolean)
      .map((value) => decodeURIComponent(value));
  }
  return filters;
}

type Props = {
  data: PageView;
  search: URLSearchParams;
  setSearch: SetURLSearchParams;
  onMutate: (mutation: Mutation) => void;
  mutating: boolean;
};

export default function PluginResourceView({ data, search, setSearch, onMutate, mutating }: Props) {
  const { playQueue, queueNext, addToQueue } = useAudioQueue();
  const { showSuccess } = useToast();
  // A change of view starts at its first page.
  const update = (changes: Record<string, string>, { keepPage = false } = {}) =>
    setSearch((current) => {
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(changes)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      if (!keepPage) next.delete("page");
      return next;
    });
  const filters = readFilters(search.get("filters"));
  const linkTo = (link: ResolvedLink, children: React.ReactNode, className?: string) => {
    if (link?.href)
      return (
        <Link to={link.href} className={className}>
          {children}
        </Link>
      );
    if (link?.filters) {
      const target = link.filters;
      return (
        <button
          type="button"
          className={`plugin-view__link ${className ?? ""}`}
          onClick={() => update({ filters: writeFilters(target) })}
        >
          {children}
        </button>
      );
    }
    return <span className={className}>{children}</span>;
  };
  const queueOf = (section: Of<"tracks">, items: TrackItem[]) =>
    items.map((item) => pluginQueueTrack(item, section.context));
  const source = (section: Of<"tracks">) => ({
    type: "plugin-page",
    id: `${data.title}:${section.id}`,
    label: data.title,
  });

  const header = data.sections.find(
    (section): section is Of<"header"> => section.type === "header",
  );
  return (
    <div className="plugin-page plugin-view">
      <h1 className="page-title plugin-view__title">{header?.title ?? data.title}</h1>
      {header?.subtitle ? <p className="plugin-view__subtitle">{header.subtitle}</p> : null}
      {header?.facts.length ? (
        <p className="plugin-view__facts">
          {header.facts.map((fact, index) => (
            <span key={`${fact.label}-${index}`}>
              {index ? " · " : ""}
              {linkTo(fact.link, `${fact.label}: ${fact.value}`)}
            </span>
          ))}
        </p>
      ) : null}
      {header?.badges.length ? (
        <p className="plugin-view__badges">
          {header.badges.map((badge) => (
            <span key={badge} className="plugin-view__badge">
              {badge}
            </span>
          ))}
        </p>
      ) : null}
      {header?.actions.length ? (
        <div className="plugin-view__actions">
          {header.actions.map((action) =>
            action.mutation ? (
              <button
                key={action.label}
                type="button"
                className="btn btn-secondary"
                aria-pressed={action.pressed}
                disabled={mutating}
                onClick={() => action.mutation && onMutate(action.mutation)}
              >
                {action.label}
              </button>
            ) : (
              <span key={action.label}>
                {linkTo(action.link, action.label, "btn btn-secondary")}
              </span>
            ),
          )}
        </div>
      ) : null}
      {data.sections.map((section, index) => {
        const key = `${section.type}-${index}`;
        switch (section.type) {
          case "header":
            return null;
          case "tabs":
            return (
              <nav key={key} className="plugin-view__tabs" aria-label="Views">
                {section.tabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    className="plugin-view__tab"
                    aria-current={tab.id === section.active ? "page" : undefined}
                    onClick={() => update({ tab: tab.id, filters: "" })}
                  >
                    {tab.label}
                    {tab.count != null ? (
                      <span className="plugin-view__count">{tab.count}</span>
                    ) : null}
                  </button>
                ))}
              </nav>
            );
          case "sort":
            return (
              <div key={key} className="plugin-view__controls">
                <Select
                  className="input plugin-view__select"
                  aria-label="Sort"
                  value={section.active || section.options[0]?.value || ""}
                  options={section.options.map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                  onChange={(value) => update({ sort: value })}
                />
              </div>
            );
          case "filters":
            return (
              <div key={key} className="plugin-view__controls">
                {section.filters.map((filter) => (
                  <Select
                    key={filter.key}
                    className="input plugin-view__select"
                    aria-label={filter.label}
                    searchable={filter.options.length > 12}
                    value={filters[filter.key]?.[0] ?? filter.selected[0] ?? ""}
                    options={[
                      { value: "", label: `Any ${filter.label.toLowerCase()}` },
                      ...filter.options.map((option) => ({
                        value: option.value,
                        label:
                          option.count != null ? `${option.label} (${option.count})` : option.label,
                      })),
                    ]}
                    onChange={(value) =>
                      update({
                        filters: writeFilters({ ...filters, [filter.key]: value ? [value] : [] }),
                      })
                    }
                  />
                ))}
              </div>
            );
          case "rows":
            return (
              <section
                key={key}
                className="plugin-view__section"
                aria-label={section.title || undefined}
              >
                {section.title ? <h2 className="plugin-view__heading">{section.title}</h2> : null}
                {section.rows.length ? (
                  <ul className="plugin-view__rows">
                    {section.rows.map((row) => (
                      <li key={row.id} className="plugin-view__row">
                        {linkTo(row.link, row.label, "plugin-view__row-title")}
                        {row.detail ? (
                          <span className="plugin-view__row-detail">{row.detail}</span>
                        ) : null}
                        {row.badge ? <span className="plugin-view__badge">{row.badge}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : section.empty ? (
                  <p className="plugin-view__subtitle">{section.empty}</p>
                ) : null}
              </section>
            );
          case "groups":
            return (
              <section
                key={key}
                className="plugin-view__section"
                aria-label={section.title || undefined}
              >
                {section.title ? <h2 className="plugin-view__heading">{section.title}</h2> : null}
                {section.groups.map((group, groupIndex) => (
                  <div key={`${group.heading}-${groupIndex}`} className="plugin-view__group">
                    <h3 className="plugin-view__group-heading">
                      {linkTo(group.link, group.heading)}
                    </h3>
                    {group.detail ? <p className="plugin-view__subtitle">{group.detail}</p> : null}
                    <ul className="plugin-view__rows">
                      {group.rows.map((row) => (
                        <li key={row.id} className="plugin-view__row">
                          {linkTo(row.link, row.label, "plugin-view__row-title")}
                          {row.detail ? (
                            <span className="plugin-view__row-detail">{row.detail}</span>
                          ) : null}
                          {row.badge ? (
                            <span className="plugin-view__badge">{row.badge}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </section>
            );
          case "tracks":
            return (
              <section
                key={key}
                className="plugin-view__section"
                aria-label={section.title || "Tracks"}
              >
                <div className="plugin-view__section-head">
                  {section.title ? <h2 className="plugin-view__heading">{section.title}</h2> : null}
                  {section.items.length ? (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() =>
                        playQueue(queueOf(section, section.items), { source: source(section) })
                      }
                    >
                      Play all
                    </button>
                  ) : null}
                </div>
                <ol className="plugin-view__tracks">
                  {section.items.map((item) => (
                    <li key={item.id} className="plugin-view__track">
                      <button
                        type="button"
                        className="plugin-view__track-play"
                        aria-label={`Play ${item.title}`}
                        onClick={() =>
                          playQueue(queueOf(section, section.items), {
                            startTrackId: item.id,
                            source: source(section),
                          })
                        }
                      >
                        <span className="plugin-view__row-title">{item.title}</span>
                        <span className="plugin-view__row-detail">
                          {[item.artist, item.album].filter(Boolean).join(" · ")}
                        </span>
                      </button>
                      <span className="plugin-view__time">
                        {formatDuration(pluginItemDurationMs(item))}
                      </span>
                      <TooltipButton
                        label="Play next"
                        className="btn btn-ghost btn-icon"
                        onClick={() =>
                          queueNext(queueOf(section, [item]), { source: source(section) }) &&
                          showSuccess(`“${item.title}” plays next`)
                        }
                      >
                        <ListStart aria-hidden="true" />
                      </TooltipButton>
                      <TooltipButton
                        label="Add to queue"
                        className="btn btn-ghost btn-icon"
                        onClick={() =>
                          addToQueue(queueOf(section, [item]), { source: source(section) }) &&
                          showSuccess(`Added “${item.title}” to the queue`)
                        }
                      >
                        <ListEnd aria-hidden="true" />
                      </TooltipButton>
                    </li>
                  ))}
                </ol>
              </section>
            );
          case "details":
            return (
              <section
                key={key}
                className="plugin-view__section"
                aria-label={section.title || undefined}
              >
                {section.title ? <h2 className="plugin-view__heading">{section.title}</h2> : null}
                <dl className="plugin-view__details">
                  {section.items.map((fact, factIndex) => (
                    <div key={`${fact.label}-${factIndex}`}>
                      <dt>{fact.label}</dt>
                      <dd>{linkTo(fact.link, fact.value)}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            );
          case "pager": {
            const page = Math.floor(section.offset / section.limit);
            const last = Math.max(0, Math.ceil(section.total / section.limit) - 1);
            if (last === 0) return null;
            return (
              <nav key={key} className="plugin-view__pager" aria-label="Pages">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={page <= 0}
                  onClick={() =>
                    update({ page: page > 1 ? String(page - 1) : "" }, { keepPage: true })
                  }
                >
                  Previous
                </button>
                <span className="plugin-view__subtitle">
                  {section.offset + 1}–{Math.min(section.offset + section.limit, section.total)} of{" "}
                  {section.total}
                </span>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={page >= last}
                  onClick={() => update({ page: String(page + 1) }, { keepPage: true })}
                >
                  Next
                </button>
              </nav>
            );
          }
          case "empty":
            return (
              <div key={key} className="search-empty-panel">
                <span className="search-empty-panel__icon">
                  <Inbox aria-hidden="true" />
                </span>
                <p>{section.message}</p>
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
