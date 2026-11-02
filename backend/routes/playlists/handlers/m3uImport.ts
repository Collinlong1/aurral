import { Hono } from "hono";
import * as v from "valibot";
import { requireAdmin } from "../../../middleware/guards.ts";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import { validate } from "../../../middleware/validate.ts";
import {
  M3uImportError,
  completePendingM3uImports,
  importM3uPlaylists,
  scanM3uFolder,
} from "../../../services/importLists/m3uImport.ts";
import { logger, safeLogDiagnostic } from "../../../services/logger.ts";
import { asAppError } from "../../../../lib/errors.ts";
import { requireFlowAccess } from "./utils.ts";

const failure = (error: unknown) =>
  error instanceof M3uImportError
    ? ({ body: { error: error.message }, status: 400 } as const)
    : ({
        body: { error: "M3U import failed", message: asAppError(error)?.message },
        status: 500,
      } as const);

// Reading server folders and copying files into the Library is admin-only.
export default new Hono<AppEnv>()
  .post(
    "/import/m3u/scan",
    requireFlowAccess,
    requireAdmin,
    validate("json", v.object({ folder: v.string() })),
    async (c) => {
      try {
        await completePendingM3uImports();
        return c.json(await scanM3uFolder(c.req.valid("json").folder), 200);
      } catch (error) {
        const { body, status } = failure(error);
        return c.json(body, status);
      }
    },
  )
  .post(
    "/import/m3u",
    requireFlowAccess,
    requireAdmin,
    validate(
      "json",
      v.object({
        folder: v.string(),
        files: v.array(v.string()),
        copyTracks: v.optional(v.boolean()),
        downloadMissing: v.optional(v.boolean()),
      }),
    ),
    async (c) => {
      try {
        const body = c.req.valid("json");
        const result = await importM3uPlaylists({
          folder: body.folder,
          files: body.files,
          ownerUserId: c.var.user.id,
          copyTracks: body.copyTracks === true,
          downloadMissing: body.downloadMissing === true,
        });
        return c.json({ success: true, ...result }, 200);
      } catch (error) {
        logger.warn("playlist-import", "M3U import failed", { reason: safeLogDiagnostic(error) });
        const { body, status } = failure(error);
        return c.json(body, status);
      }
    },
  );
