import { Hono } from "hono";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import lastfmImport from "./lastfmImport.ts";
import listenbrainzImport from "./listenbrainzImport.ts";
import m3uImport from "./m3uImport.ts";
import spotifyImport from "./spotifyImport.ts";
import youtubeMusicImport from "./youtubeMusicImport.ts";

export default new Hono<AppEnv>()
  .basePath("/playlists")
  .route("/", spotifyImport)
  .route("/", listenbrainzImport)
  .route("/", lastfmImport)
  .route("/", youtubeMusicImport)
  .route("/", m3uImport);
