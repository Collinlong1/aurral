import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import * as v from "valibot";
import { requireAdmin, requireAuth } from "../../middleware/guards.ts";
import type { AppEnv } from "../../middleware/requestUser.ts";
import { validate } from "../../middleware/validate.ts";
import { asAppError } from "../../../lib/errors.ts";
import {
  ScriptPathError,
  getScriptsDir,
  listScriptFiles,
  scriptSucceeded,
} from "../../services/scriptHooks.ts";

// Without AURRAL_SCRIPTS_DIR these routes answer like any unknown API path.
const requireScriptsEnabled = createMiddleware<AppEnv>(async (c, next) => {
  if (!getScriptsDir()) return c.json({ error: "Not found" }, 404);
  await next();
});

const scriptTarget = v.object({
  name: v.optional(v.string()),
  file: v.string(),
  args: v.optional(v.array(v.string())),
  timeoutSec: v.optional(v.number()),
});

export default new Hono<AppEnv>()
  .basePath("/settings/scripts")
  .get("/files", requireScriptsEnabled, requireAuth, requireAdmin, async (c) => {
    try {
      return c.json({ files: await listScriptFiles() }, 200);
    } catch (error) {
      return c.json({ error: "Could not list scripts", message: asAppError(error)?.message }, 500);
    }
  })
  .post(
    "/test",
    requireScriptsEnabled,
    requireAuth,
    requireAdmin,
    validate("json", scriptTarget),
    async (c) => {
      try {
        const { sendScriptTest } = await import("../../services/notificationService.ts");
        const result = await sendScriptTest(c.req.valid("json"));
        return c.json({ success: scriptSucceeded(result), ...result }, 200);
      } catch (error) {
        if (error instanceof ScriptPathError) {
          return c.json({ error: "Invalid script", message: error.message }, 400);
        }
        return c.json({ error: "Script test failed", message: asAppError(error)?.message }, 500);
      }
    },
  );
