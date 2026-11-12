import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import * as v from "valibot";
import { userOps } from "../../db/helpers/index.ts";
import { getSettingsEncryptionKey } from "../../db/helpers/settings.ts";
import { buildPermissions } from "../auth.ts";
import { activePlugin, isCapabilityOn, pluginForApiKey } from "./pluginStore.ts";
import { flowPlaylistConfig } from "../playlists/flowPlaylistConfig.ts";
import { playlistOperationQueue } from "../playlists/playlistOperationQueue.ts";
import { playlistOperationQueue as queue } from "../jobs/queues.ts";
import { getLibrary } from "../libraryQueryService.ts";
import { getPathMappings, resolveLocalPath } from "../pathMappings.ts";

const grantSchema = v.object({
  pluginId: v.string(),
  actionId: v.string(),
  userId: v.number(),
  expires: v.number(),
});
const sign = (body: string) =>
  createHmac("sha256", getSettingsEncryptionKey())
    .update(`plugin-user-v1:${body}`)
    .digest("base64url");

export function issueUserOperationGrant(pluginId: string, actionId: string, userId: number) {
  const body = Buffer.from(
    JSON.stringify({ pluginId, actionId, userId, expires: Date.now() + 30 * 60_000 }),
  ).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function resolveUserOperationGrant(token: string, pluginId: string) {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra) throw new Error("Invalid action grant");
  const expected = Buffer.from(sign(body));
  const supplied = Buffer.from(signature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied))
    throw new Error("Invalid action grant");
  const grant = v.parse(grantSchema, JSON.parse(Buffer.from(body, "base64url").toString()));
  if (grant.pluginId !== pluginId || grant.expires < Date.now())
    throw new Error("Expired or mismatched action grant");
  assertUserOperationAccess(grant);
  return grant;
}

export function assertUserOperationAccess(grant: v.InferOutput<typeof grantSchema>) {
  if (grant.expires < Date.now())
    throw Object.assign(new Error("Action grant expired"), { code: "PLUGIN_PERMISSION_REVOKED" });
  const plugin = activePlugin(grant.pluginId);
  const action = plugin?.manifest.actions.find((entry) => entry.id === grant.actionId);
  const user = userOps.getUserById(grant.userId);
  if (
    !plugin ||
    !action?.localPlaylists ||
    !isCapabilityOn(plugin, `action:${grant.actionId}`) ||
    !user ||
    user.status !== "active" ||
    (action.admin && user.role !== "admin") ||
    !buildPermissions(user.role, user.permissions).accessPlaylists
  )
    throw Object.assign(new Error("Action permission revoked"), {
      code: "PLUGIN_PERMISSION_REVOKED",
    });
  return user;
}

const track = v.object({
  path: v.pipe(v.string(), v.minLength(1)),
  artistName: v.optional(v.string(), "Local"),
  trackName: v.optional(v.string(), "Local track"),
});
export const userPlaylistInput = v.object({
  key: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  tracks: v.array(track),
});

export async function enqueueUserPlaylist(
  token: string,
  pluginId: string,
  input: v.InferOutput<typeof userPlaylistInput>,
) {
  const grant = resolveUserOperationGrant(token, pluginId);
  // Stable UUID derived from the scoped key: retries/restarts cannot create a second playlist.
  const hex = createHmac("sha256", getSettingsEncryptionKey())
    .update(JSON.stringify([pluginId, grant.userId, input.key]))
    .digest("hex");
  const playlistId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const queued = await playlistOperationQueue.enqueuePayload({
    kind: "plugin-local-playlist",
    playlistId,
    name: input.name,
    tracks: input.tracks,
    ownerUserId: grant.userId,
    pluginGrant: grant,
    label: `plugin:${pluginId}:local-playlist`,
    requestId: randomUUID(),
  });
  return { ...queued, playlistId };
}

export function userOperationStatus(token: string, pluginId: string, id: number) {
  const grant = resolveUserOperationGrant(token, pluginId);
  const job = queue.getJob(id);
  const payload: unknown = job ? JSON.parse(job.payload) : null;
  const schema = v.object({ pluginGrant: grantSchema });
  const parsed = v.safeParse(schema, payload);
  if (
    !job ||
    !parsed.success ||
    parsed.output.pluginGrant.userId !== grant.userId ||
    parsed.output.pluginGrant.pluginId !== pluginId
  )
    throw new Error("Operation not found");
  return { state: job.state, error: job.last_error };
}

export function ownedLibrarySnapshot(token: string, pluginId: string) {
  resolveUserOperationGrant(token, pluginId);
  return librarySnapshot();
}

// A plugin with API access already acts as an admin; let its own key read the
// same snapshot so scheduled runs can reconcile without a user action grant.
export function pluginLibrarySnapshot(apiKey: string, pluginId: string) {
  if (!apiKey || pluginForApiKey(apiKey) !== pluginId) throw new Error("Plugin key denied");
  return librarySnapshot();
}

function librarySnapshot() {
  const library = getLibrary({ availableOnly: true });
  return {
    version: 1,
    complete: true,
    library: {
      ...library,
      tracks: library.tracks.map((track) => ({
        ...track,
        files: track.files.map((file) => ({
          ...file,
          readPath:
            file.source === "lidarr"
              ? resolveLocalPath(file.path, getPathMappings("lidarr"))
              : file.path,
        })),
      })),
    },
  };
}

export async function executeUserPlaylist(payload: Record<string, unknown>) {
  const grant = v.parse(grantSchema, payload.pluginGrant);
  assertUserOperationAccess(grant);
  const id = String(payload.playlistId);
  const existing = flowPlaylistConfig.getStaticPlaylist(id);
  if (existing && existing.ownerUserId !== grant.userId) throw new Error("Playlist owner changed");
  return { grant, existing };
}
