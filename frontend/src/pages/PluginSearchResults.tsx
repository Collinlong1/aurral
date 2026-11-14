// Results from plugin search providers (`"search": true`), shown on the search
// page. The plugin sends typed, bounded data; links are built by core.
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import RouteLink from "../components/RouteLink";
import { Select } from "../components/Select";
import { AlertCircle } from "../components/icons";
import { pluginsClient } from "../utils/api/clients/plugins.ts";
import type { pluginSearch } from "../../../backend/services/plugins/pluginSearch.ts";
import "./PluginSearchResults.css";

type Answer = Awaited<ReturnType<typeof pluginSearch>>;
type Provider = Answer["providers"][number];
type Item = Extract<Provider, { ok: true }>["sections"][number]["items"][number];
export type PluginSearchFilters = Record<string, string[]>;

// "composer=a,b;period=x", the form the search route reads.
export const writePluginFilters = (filters: PluginSearchFilters) =>
  Object.entries(filters)
    .filter(([, values]) => values.length)
    .map(([key, values]) => `${key}=${values.map(encodeURIComponent).join(",")}`)
    .join(";");
export const readPluginFilters = (raw: string): PluginSearchFilters =>
  Object.fromEntries(
    raw.split(";").flatMap((part) => {
      const at = part.indexOf("=");
      return at > 0 && at < part.length - 1
        ? [
            [
              part.slice(0, at),
              part
                .slice(at + 1)
                .split(",")
                .map(decodeURIComponent),
            ],
          ]
        : [];
    }),
  );

function ResultRow({
  item,
  onFilters,
}: {
  item: Item;
  onFilters: (filters: PluginSearchFilters) => void;
}) {
  const meta = [item.subtitle, item.detail].filter(Boolean).join(" · ");
  const title = item.href ? (
    <RouteLink to={item.href} className="plugin-search__title">
      {item.title}
    </RouteLink>
  ) : item.filters ? (
    <button
      type="button"
      className="plugin-search__title plugin-search__link"
      onClick={() => onFilters(item.filters ?? {})}
    >
      {item.title}
    </button>
  ) : (
    <span className="plugin-search__title">{item.title}</span>
  );
  return (
    <li className="plugin-search__row">
      {title}
      {meta ? <span className="plugin-search__meta">{meta}</span> : null}
    </li>
  );
}

export default function PluginSearchResults({
  query,
  focus,
  section,
  filters,
  onFocus,
  onFilters,
}: {
  query: string;
  // A provider the person opened ("Show all"), with more results and filters.
  focus: string;
  section: string;
  filters: PluginSearchFilters;
  onFocus: (pluginId: string, section: string) => void;
  onFilters: (filters: PluginSearchFilters) => void;
}) {
  const filterText = writePluginFilters(filters);
  const result = useQuery({
    queryKey: ["plugin-search", query, focus, section, filterText],
    queryFn: ({ signal }) =>
      parseResponse(
        pluginsClient.search.$get(
          { query: { q: query, plugin: focus, section, filters: filterText, offset: "0" } },
          { init: { signal } },
        ),
      ),
    enabled: Boolean(query.trim() || filterText),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
  });
  if (!result.data) return null;
  return (
    <>
      {result.data.providers.map((provider) =>
        provider.ok ? (
          provider.total > 0 || focus ? (
            <section
              key={provider.pluginId}
              className={`plugin-search${result.isPlaceholderData ? " query-pending" : ""}`}
              aria-labelledby={`plugin-search-${provider.pluginId}`}
            >
              <div className="artist-discover-rail__header">
                <h2
                  id={`plugin-search-${provider.pluginId}`}
                  className="artist-section-title--discover"
                >
                  {provider.pluginName}
                </h2>
                {!focus ? (
                  <button
                    type="button"
                    className="section-show-all plugin-search__link"
                    onClick={() => onFocus(provider.pluginId, "")}
                  >
                    Show all
                  </button>
                ) : null}
              </div>
              {focus && provider.facets.length ? (
                <div className="plugin-search__filters">
                  {provider.facets.map((facet) => (
                    <Select
                      key={facet.key}
                      aria-label={facet.label}
                      searchable={facet.options.length > 12}
                      value={facet.selected[0] ?? ""}
                      options={[
                        { value: "", label: `Any ${facet.label.toLowerCase()}` },
                        ...facet.options.map((option) => ({
                          value: option.value,
                          label: option.label,
                          detail: String(option.count),
                        })),
                      ]}
                      onChange={(value) =>
                        onFilters({ ...filters, [facet.key]: value ? [value] : [] })
                      }
                    />
                  ))}
                  {Object.values(filters).some((values) => values.length) ? (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => onFilters({})}
                    >
                      Clear filters
                    </button>
                  ) : null}
                </div>
              ) : null}
              {provider.total === 0 ? (
                <p className="plugin-search__meta">
                  No results. Try a different search or clear the filters.
                </p>
              ) : null}
              {provider.sections.map((part) => (
                <div key={part.id} className="plugin-search__section">
                  <div className="plugin-search__section-header">
                    <h3>{part.title}</h3>
                    {part.total > part.items.length && section !== part.id ? (
                      <button
                        type="button"
                        className="section-show-all plugin-search__link"
                        onClick={() => onFocus(provider.pluginId, part.id)}
                      >
                        Show all {part.total}
                      </button>
                    ) : null}
                  </div>
                  <ul className="plugin-search__list">
                    {part.items.map((item) => (
                      <ResultRow key={item.id} item={item} onFilters={onFilters} />
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ) : null
        ) : (
          <div key={provider.pluginId} className="search-page__notice" role="alert">
            <AlertCircle aria-hidden="true" />
            <span>Couldn’t load {provider.pluginName} results.</span>
            <button
              type="button"
              className="search-page__notice-action"
              onClick={() => void result.refetch()}
            >
              Try again
            </button>
          </div>
        ),
      )}
    </>
  );
}
