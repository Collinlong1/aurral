import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import type { PluginPageData } from "../../../backend/services/plugins/pluginPages.ts";
import PluginAdminPage from "./PluginAdminPage.tsx";
import { pluginsClient } from "../utils/api/clients/plugins.ts";
import { useAuth } from "../contexts/AuthContext.tsx";
import { readApiError } from "./Settings/utils/apiError.ts";
import "./PluginPage.css";

type PageForm = PluginPageData["forms"][number];
type Values = PageForm["arguments"];
function PageFormView({
  form,
  revision,
  disabled,
  onSubmit,
  onEdit,
  onCancel,
}: {
  form: PageForm;
  revision: string;
  disabled: boolean;
  onSubmit: (command: string, values: Values) => void;
  onEdit: () => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Values>(() => ({
    ...form.arguments,
    ...Object.fromEntries(form.fields.map((f) => [f.key, f.value])),
  }));
  const change = (key: string, value: Values[string]) => {
    onEdit();
    setValues((current) => ({ ...current, [key]: value }));
  };
  return (
    <form
      className="plugin-page__form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(form.command, values);
      }}
    >
      <h2>{form.title}</h2>
      {form.help && <p className="plugin-page__note">{form.help}</p>}
      <fieldset disabled={disabled}>
        {form.fields.map((field) => {
          const id = `${form.id}-${field.key}-${revision}`;
          const val = values[field.key];
          return (
            <div className="plugin-page__field" key={field.key}>
              <label htmlFor={field.type === "order" ? undefined : id}>{field.label}</label>
              {field.type === "checkbox" ? (
                <input
                  id={id}
                  type="checkbox"
                  checked={val === true}
                  onChange={(e) => change(field.key, e.target.checked)}
                />
              ) : field.type === "select" ? (
                <select
                  id={id}
                  className="input"
                  value={String(val)}
                  required={field.required}
                  onChange={(e) => change(field.key, e.target.value)}
                >
                  {field.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : field.type === "order" ? (
                <ol aria-label={field.label} className="plugin-page__order">
                  {(Array.isArray(val) ? val : []).map((item, index, all) => {
                    const label = field.options.find((o) => o.value === item)?.label || item;
                    const move = (delta: number) => {
                      const next = [...all];
                      [next[index], next[index + delta]] = [next[index + delta]!, next[index]!];
                      change(field.key, next);
                    };
                    return (
                      <li key={item}>
                        <span>{label}</span>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={!index}
                          aria-label={`Move ${label} up`}
                          onClick={() => move(-1)}
                        >
                          Up
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={index === all.length - 1}
                          aria-label={`Move ${label} down`}
                          onClick={() => move(1)}
                        >
                          Down
                        </button>
                      </li>
                    );
                  })}
                </ol>
              ) : field.type === "textarea" ? (
                <textarea
                  id={id}
                  className="input"
                  rows={4}
                  value={String(val)}
                  required={field.required}
                  maxLength={10000}
                  onChange={(e) => change(field.key, e.target.value)}
                />
              ) : (
                <input
                  id={id}
                  className="input"
                  value={String(val)}
                  required={field.required}
                  maxLength={10000}
                  onChange={(e) => change(field.key, e.target.value)}
                />
              )}
              {field.help && <p className="plugin-page__note">{field.help}</p>}
            </div>
          );
        })}
        <button className="btn btn-primary" type="submit">
          {form.submitLabel}
        </button>
        <button
          className="btn btn-ghost"
          type="button"
          onClick={() => {
            setValues({
              ...form.arguments,
              ...Object.fromEntries(form.fields.map((f) => [f.key, f.value])),
            });
            onCancel();
          }}
        >
          Cancel changes
        </button>
      </fieldset>
    </form>
  );
}

export default function PluginPage() {
  const { id = "", pageId = "" } = useParams();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get("q") || "");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [editingForm, setEditingForm] = useState<string | null>(null);
  const selection = params.get("selection") || "",
    q = params.get("q") || "",
    offset = params.get("offset") || "0",
    tab = params.get("tab") || "";
  const query = useQuery({
    queryKey: ["plugins", "page", id, pageId, selection, q, offset, tab, user?.id],
    enabled: user?.role === "admin" && !editingForm,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      const data = await parseResponse(
        pluginsClient[":id"].pages[":pageId"].$get(
          { param: { id, pageId }, query: { selection, q, offset, tab } },
          { init: { signal } },
        ),
      );
      if (!("version" in data) || "lookup" in data)
        throw new Error("The plugin returned an invalid page");
      return data;
    },
    retry: false,
  });
  const loaded = query.data;
  const data = loaded?.version === 1 ? loaded : undefined;
  const navigate = (next: { selection?: string; q?: string; offset?: string; tab?: string }) => {
    setMessage("");
    setError("");
    setParams({ ...{ selection, q, offset, tab }, ...next });
  };
  const mutation = useMutation({
    mutationFn: async ({ command, values }: { command: string; values: Values }) => {
      if (!data) throw new Error("Reload this page before saving");
      return parseResponse(
        pluginsClient[":id"].pages[":pageId"].$post({
          param: { id, pageId },
          json: { command, values, revision: data.revision },
        }),
      );
    },
    onSuccess: async (result) => {
      setBlocked(false);
      setEditingForm(null);
      setError("");
      setMessage("message" in result ? result.message : "Saved");
      if (
        "selection" in result &&
        typeof result.selection === "string" &&
        result.selection !== selection
      )
        setParams({ selection: result.selection, q: "", offset: "0" });
      else await query.refetch();
    },
    onError: (failure: unknown) => {
      setMessage("");
      const details = readApiError(failure);
      setBlocked(details.status !== 400);
      setError(
        details.error || details.message || details.text || "Couldn't save. Reload and try again.",
      );
    },
  });
  if (user?.role !== "admin")
    return (
      <div className="plugin-page">
        <h1>Admin access required</h1>
      </div>
    );
  if (loaded?.version === 2)
    return (
      <PluginAdminPage
        key={`${id}:${pageId}`}
        pluginId={id}
        pageId={pageId}
        data={loaded}
        params={{ selection, q, offset, tab }}
        fetching={query.isFetching}
        onNavigate={(next) => navigate(next)}
        onRefetch={() => query.refetch()}
      />
    );
  return (
    <div className="plugin-page">
      <Link to="/?settings=plugins">Plugins</Link>
      <h1>{data?.title || "Plugin page"}</h1>
      {data?.description && <p>{data.description}</p>}
      {query.isPending && <p role="status">Loading…</p>}
      {(query.isError || error) && (
        <div role="alert">
          <p>
            {error ||
              "This page is unavailable. Check that the plugin and its page capability are enabled."}
          </p>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setError("");
              setBlocked(false);
              setEditingForm(null);
              void query.refetch();
            }}
          >
            Reload page
          </button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
      {data && (
        <>
          <form
            role="search"
            className="plugin-page__search"
            onSubmit={(e) => {
              e.preventDefault();
              navigate({ q: search, offset: "0" });
            }}
          >
            <label htmlFor="plugin-page-search">Search items</label>
            <input
              className="input"
              id="plugin-page-search"
              value={search}
              disabled={mutation.isPending || !!editingForm}
              maxLength={200}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button
              className="btn btn-secondary"
              type="submit"
              disabled={mutation.isPending || !!editingForm}
            >
              Search
            </button>
          </form>
          <div className="plugin-page__layout">
            <nav aria-label="Items" className="plugin-page__nav">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={mutation.isPending || !!editingForm}
                onClick={() => navigate({ selection: "" })}
              >
                Create new
              </button>
              <ul>
                {data.navigation.items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={mutation.isPending || !!editingForm}
                      aria-current={selection === item.id ? "page" : undefined}
                      onClick={() => navigate({ selection: item.id })}
                    >
                      {item.label}
                    </button>
                  </li>
                ))}
              </ul>
              <p>{data.navigation.total} items</p>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={!data.navigation.offset || mutation.isPending || !!editingForm}
                onClick={() =>
                  navigate({ offset: String(Math.max(0, data.navigation.offset - 100)) })
                }
              >
                Previous
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={
                  data.navigation.offset + 100 >= data.navigation.total ||
                  mutation.isPending ||
                  !!editingForm
                }
                onClick={() => navigate({ offset: String(data.navigation.offset + 100) })}
              >
                Next
              </button>
            </nav>
            <div className="plugin-page__forms">
              {data.notes.map((note, index) => (
                <p className="plugin-page__note" key={index}>
                  {note}
                </p>
              ))}
              {data.forms.map((form) => (
                <PageFormView
                  key={`${form.id}:${data.revision}:${selection}`}
                  form={form}
                  revision={data.revision}
                  disabled={
                    mutation.isPending ||
                    query.isFetching ||
                    blocked ||
                    (!!editingForm && editingForm !== form.id)
                  }
                  onEdit={() => {
                    setEditingForm(form.id);
                    setError("");
                  }}
                  onCancel={() => setEditingForm(null)}
                  onSubmit={(command, values) => mutation.mutate({ command, values })}
                />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
