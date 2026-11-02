import assert from "node:assert/strict";
import { afterAll, beforeEach, test } from "vite-plus/test";
import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [state, { db }, { userOps }, { default: users }] = await setupIsolatedBackend(
  "delete-admin-routes",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/routes/users.ts"),
);

beforeEach(() => {
  resetDatabase(db);
});

afterAll(async () => {
  await cleanupIsolatedState(state);
});

const create = (username: string, role = "admin") => {
  userOps.createUser(username, "hash", role);
  return userOps.getUserByUsername(username)!;
};

const deleteAs = (actorId: number, targetId: number) =>
  signedInAs(testUser(actorId, { role: "admin" }))
    .route("/", users)
    .request(`/users/${targetId}`, { method: "DELETE" });

test("an admin can delete another admin account", async () => {
  const me = create("collin");
  const duplicate = create("collin-2");

  const response = await deleteAs(me.id, duplicate.id);

  assert.equal(response.status, 200);
  assert.equal(userOps.getUserById(duplicate.id), null);
});

test("the protected recovery account and the last active admin cannot be deleted", async () => {
  const me = create("collin");
  const recovery = create("recovery");
  userOps.setProtected(recovery.id, true);
  const member = create("member", "user");

  const protectedResponse = await deleteAs(me.id, recovery.id);
  assert.equal(protectedResponse.status, 400);
  assert.ok(userOps.getUserById(recovery.id));

  // An admin acting through the API key is not a stored account, so the
  // target can be the only remaining active admin.
  userOps.setProtected(recovery.id, false);
  userOps.updateUser(recovery.id, { status: "disabled" });
  const lastAdmin = await deleteAs(-1, me.id);
  assert.equal(lastAdmin.status, 400);
  assert.ok(userOps.getUserById(me.id));

  assert.equal((await deleteAs(me.id, member.id)).status, 200);
});

test("an admin still cannot delete their own account", async () => {
  const me = create("collin");
  create("other");
  assert.equal((await deleteAs(me.id, me.id)).status, 400);
  assert.ok(userOps.getUserById(me.id));
});
