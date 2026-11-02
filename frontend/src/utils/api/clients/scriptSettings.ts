import { hc } from "hono/client";
import type scriptSettings from "../../../../../backend/routes/settings/scripts.ts";
import { API_BASE_URL, apiFetch } from "../core.ts";

export const scriptSettingsClient = hc<typeof scriptSettings>(API_BASE_URL, {
  fetch: apiFetch,
}).settings.scripts;
