import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";
import { afterAll, afterEach, beforeEach, test, vi } from "vite-plus/test";
import type { RequestUser } from "../../backend/middleware/requestUser.ts";
import { signedInAs } from "../helpers/honoApp.ts";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";
import { testUser } from "../helpers/userFixtures.ts";
import { writeFlacFixture } from "../helpers/flacFixture.ts";

const [
  state,
  { db },
  { default: pluginRoutes },
  { pluginsDir, pluginDataFolder },
  { stopAllPlugins },
  { refreshInstalledPlugins, listPlugins },
  { flowPlaylistConfig },
  { websocketService },
  { deliverPluginEvent, emitPluginEvent, pluginEventDeliverySchema },
  { notificationQueue },
  { deliverQueuedNotification, queuedNotificationSchema },
  { scanMusicRoot },
  { getLibrary },
  { runDuePluginSchedules },
  { activePlugin, pluginInput, setSafeMode, whilePluginTests },
  { resolveRequestUser },
  { playlistOperationQueue },
  { logger },
] = await setupIsolatedBackend(
  "plugins",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/routes/plugins.ts"),
  () => import("../../backend/services/plugins/pluginManifest.ts"),
  () => import("../../backend/services/plugins/pluginHost.ts"),
  () => import("../../backend/services/plugins/pluginService.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/websocketService.ts"),
  () => import("../../backend/services/plugins/pluginEvents.ts"),
  () => import("../../backend/services/jobs/queues.ts"),
  () => import("../../backend/services/notificationService.ts"),
  () => import("../../backend/services/libraryFileScanner.ts"),
  () => import("../../backend/services/libraryQueryService.ts"),
  () => import("../../backend/services/plugins/pluginSchedule.ts"),
  () => import("../../backend/services/plugins/pluginStore.ts"),
  () => import("../../backend/services/auth.ts"),
  () => import("../../backend/services/playlists/playlistOperationQueue.ts"),
  () => import("../../backend/services/logger.ts"),
);

const admin = testUser(1, { username: "admin", role: "admin" });
const owner = testUser(2, { username: "owner", permissions: { accessPlaylists: true } });
const stranger = testUser(3, { username: "stranger", permissions: { accessPlaylists: true } });

const routes = (user: RequestUser) => signedInAs(user).route("/", pluginRoutes);
const json = (method: string, body: unknown) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function install(id: string, manifest: Record<string, unknown>, code: string) {
  const folder = path.join(pluginsDir(), id);
  await mkdir(folder, { recursive: true });
  await writeFile(
    path.join(folder, "manifest.json"),
    JSON.stringify({ id, name: `Plugin ${id}`, version: "1.0.0", api: 1, ...manifest }),
  );
  await writeFile(path.join(folder, "index.js"), code);
  await refreshInstalledPlugins();
}

const turnOn = (id: string, body: Record<string, unknown> = {}) =>
  routes(admin).request(`/plugins/${id}`, json("PUT", { enabled: true, ...body }));
const actionsFor = async (user: RequestUser) =>
  (await (await routes(user).request("/plugins/actions")).json()).actions;
const run = (user: RequestUser, id: string, action: string, playlistId: string) =>
  routes(user).request(`/plugins/${id}/actions/${action}`, json("POST", { playlistId }));

let playlists = 0;
function ownedPlaylist() {
  playlists += 1;
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: `Road trip ${playlists}`,
    ownerUserId: owner.id,
  });
  assert.ok(playlist);
  return playlist.id;
}

const sendAction = { actions: [{ id: "send", label: "Send to Box", target: "playlist" }] };
const pageListSchema = v.object({ pages: v.array(v.object({ id: v.string() })) });

test("admin form pages are opt-in, capability checked and deny regular or synthetic accounts", async () => {
  const code = `export default {pages:{read:async input=>({version:1,title:'Generic editor',revision:'1',navigation:{items:[],total:0,offset:0},forms:[],notes:[String(input.user.id)]}),mutate:async input=>({ok:true,message:'Saved by '+input.user.id})}}`;
  await install("forms", { pages: [{ id: "editor", label: "Example editor" }] }, code);
  await turnOn("forms");
  const list = v.parse(
    pageListSchema,
    await (await routes(admin).request("/plugins/pages")).json(),
  );
  assert.equal(list.pages[0]?.id, "editor");
  const route = "/plugins/forms/pages/editor";
  const read = await routes(admin).request(route);
  assert.equal(read.status, 200);
  assert.equal(v.parse(v.object({ title: v.string() }), await read.json()).title, "Generic editor");
  const body = { revision: "1", command: "save", values: {} };
  for (const user of [owner, stranger, { ...admin, id: -1 }]) {
    assert.equal((await routes(user).request(route)).status, 403);
    assert.equal((await routes(user).request(route, json("POST", body))).status, 403);
  }
  assert.equal((await routes(admin).request(route, json("POST", body))).status, 200);
  assert.equal((await routes(admin).request("/plugins/forms/pages/undeclared")).status, 404);
  await turnOn("forms", { capabilities: { "page:editor": false } });
  assert.equal((await routes(admin).request(route)).status, 404);
  assert.deepEqual(
    v.parse(pageListSchema, await (await routes(admin).request("/plugins/pages")).json()).pages,
    [],
  );
  await turnOn("forms", { capabilities: { "page:editor": true } });
  setSafeMode(true);
  assert.equal((await routes(admin).request(route)).status, 404);
});

test("page transport rejects cross-site/oversized/malformed requests and propagates conflict safely", async () => {
  await install(
    "forms",
    { pages: [{ id: "editor", label: "Editor" }] },
    `export default {pages:{mutate:()=>({ok:false,status:409,message:'Newer revision exists'}),read:()=>({version:1,title:'Read',revision:'1',navigation:{items:[],total:0,offset:0},forms:[]})}}`,
  );
  await turnOn("forms");
  const route = "/plugins/forms/pages/editor",
    body = { revision: "1", command: "save", values: {} };
  const csrf = {
    ...json("POST", body),
    headers: {
      "Content-Type": "application/json",
      Origin: "https://evil.example",
      "Sec-Fetch-Site": "cross-site",
    },
  };
  assert.equal((await routes(admin).request(route, csrf)).status, 403);
  assert.equal(
    (
      await routes(admin).request(
        route,
        json("POST", { ...body, values: { x: "a".repeat(65000) } }),
      )
    ).status,
    413,
  );
  assert.equal(
    (await routes(admin).request(route, json("POST", { ...body, command: "../actions.delete" })))
      .status,
    400,
  );
  const response = await routes(admin).request(route, json("POST", body));
  assert.equal(response.status, 409);
  assert.match(
    v.parse(v.object({ error: v.string() }), await response.json()).error,
    /Newer revision/,
  );
});

test("admin pages v2 and lookups pass validated data; plugins learn the host renders v2", async () => {
  const code = `export default {pages:{read:async input=>input.query.lookup
    ? ({version:2,lookup:input.query.lookup,options:[{value:'w1',label:'Symphony No. 5',detail:'Beethoven'}]})
    : input.query.tab==='bad'
      ? ({version:2,title:'Bad',revision:'1',tabs:[],list:{items:[],total:0,offset:0},view:{crumbs:[],title:'x',sections:[{type:'script',id:'x'}]}})
      : ({version:2,title:'Editor v'+input.capabilities.adminForms,revision:'1',tab:input.query.tab,
          tabs:[{id:'works',label:'Works',count:1}],
          list:{items:[{id:'w1',label:'Symphony No. 5',selection:'w1',badge:{label:'Complete',tone:'success'}}],total:1,offset:0},
          view:{crumbs:[{label:'Beethoven',selection:'p1'}],title:'Symphony No. 5',sections:[
            {type:'form',id:'details',command:'save-entity',arguments:{target:'w1'},submitLabel:'Save',fields:[
              {key:'title',label:'Title',type:'text',value:'Symphony No. 5',meta:{source:'MusicBrainz',pinned:false},actions:[{label:'Mark blank',command:'set-blank',arguments:{target:'w1',field:'title'}}]},
              {key:'composer',label:'Composer',type:'lookup',lookup:'composers',value:'',valueLabel:''},
              {key:'mapping',label:'Movement',type:'mapping',value:['m1'],rows:[{label:'1. Allegro'}],options:[{value:'',label:'Skip'},{value:'m1',label:'I. Allegro'}]}]},
            {type:'rows',id:'movements',rows:[{id:'m1',label:'I. Allegro',actions:[{label:'Delete',command:'delete-movement',arguments:{},tone:'danger',confirm:'Sure?'}]}]},
            {type:'details',id:'file',items:[{label:'File',value:'1.flac'}]}]}})}}`;
  await install("pages2", { pages: [{ id: "editor", label: "Editor" }] }, code);
  await turnOn("pages2");
  const route = "/plugins/pages2/pages/editor";
  const page = await routes(admin).request(`${route}?tab=works&selection=w1`);
  assert.equal(page.status, 200);
  const body: unknown = await page.json();
  const parsed = v.parse(
    v.object({ version: v.literal(2), title: v.string(), tab: v.string() }),
    body,
  );
  assert.deepEqual(parsed, { version: 2, title: "Editor v2", tab: "works" });
  const lookup = await routes(admin).request(`${route}?lookup=works&q=symphony`);
  assert.equal(lookup.status, 200);
  const options: unknown = await lookup.json();
  assert.equal(
    v.parse(v.object({ options: v.array(v.object({ value: v.string() })) }), options).options[0]
      ?.value,
    "w1",
  );
  // Unknown section types and malformed query keys are rejected.
  assert.equal((await routes(admin).request(`${route}?tab=bad`)).status, 502);
  assert.equal((await routes(admin).request(`${route}?lookup=../x`)).status, 400);
});

test("a slow call while another is still running fails alone and keeps the work alive", async () => {
  const { callPlugin } = await import("../../backend/services/plugins/pluginHost.ts");
  await install(
    "busy",
    { actions: [{ id: "long", label: "Long", target: "album", background: true }] },
    `const wait = (ms) => new Promise((r) => setTimeout(r, ms));
     export default { actions: { long: async () => { await wait(1500); return { message: "finished " + process.pid }; } },
       test: async () => { await wait(800); return { message: "late" }; } };`,
  );
  await turnOn("busy");
  const plugin = activePlugin("busy")!;
  const result = v.object({ message: v.string() });
  const long = callPlugin(plugin, { path: "actions.long", input: {} }, result, 10_000);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await assert.rejects(
    callPlugin(plugin, { path: "test", input: {} }, result, 200),
    /busy and didn't answer within 0 seconds/,
  );
  // The long call was not killed, and the plugin stays on.
  assert.match((await long).message, /^finished \d+$/);
  assert.equal(activePlugin("busy")?.enabled, true);
  // With nothing else running, a call that doesn't answer still restarts the process.
  await assert.rejects(
    callPlugin(plugin, { path: "test", input: {} }, result, 200),
    /didn't answer within 0 seconds/,
  );
});

test("a call that waited behind a long call is busy, not broken, even once that call has finished", async () => {
  const { callPlugin } = await import("../../backend/services/plugins/pluginHost.ts");
  // A scan's synchronous publish holds the plugin; the editor's page call
  // queued behind it times out just after the scan answered.
  await install(
    "behind",
    { actions: [{ id: "long", label: "Long", target: "album", background: true }] },
    `const block = (ms) => { const end = Date.now() + ms; while (Date.now() < end); };
     export default { actions: { long: () => { block(600); return { message: String(process.pid) }; } },
       // Like opening a database: await I/O first, so the long call's answer
       // reaches the host, then work synchronously.
       test: async () => { await new Promise((r) => setTimeout(r, 30)); block(500); return { message: String(process.pid) }; } };`,
  );
  await turnOn("behind");
  const plugin = activePlugin("behind")!;
  const result = v.object({ message: v.string() });
  const long = callPlugin(plugin, { path: "actions.long", input: {} }, result, 10_000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(
    callPlugin(plugin, { path: "test", input: {} }, result, 800),
    /busy and didn't answer within 1 seconds/,
  );
  const pid = (await long).message;
  // Same process: it was not restarted, and the plugin is still on.
  assert.equal((await callPlugin(plugin, { path: "test", input: {} }, result, 5_000)).message, pid);
  assert.equal(activePlugin("behind")?.enabled, true);
});

test("one crash with several calls waiting is one failure, not one per call", async () => {
  const { callPlugin } = await import("../../backend/services/plugins/pluginHost.ts");
  await install(
    "crashy",
    { actions: [{ id: "long", label: "Long", target: "album", background: true }] },
    `export default { actions: { long: () => new Promise(() => setTimeout(() => process.exit(3), 300)) },
       test: () => new Promise(() => {}) };`,
  );
  await turnOn("crashy");
  const plugin = activePlugin("crashy")!;
  const result = v.object({ message: v.string() });
  const calls = [
    callPlugin(plugin, { path: "actions.long", input: {} }, result, 10_000),
    callPlugin(plugin, { path: "test", input: {} }, result, 10_000),
    callPlugin(plugin, { path: "test", input: {} }, result, 10_000),
  ];
  for (const call of calls) await assert.rejects(call, /its process stopped with exit code 3/);
  // Three calls failed together; before, that alone turned the plugin off.
  assert.equal(activePlugin("crashy")?.enabled, true);
});

test("old plugins stay page-free and invalid page output fails with a bounded error", async () => {
  await install("legacy", {}, "export default {}");
  await turnOn("legacy");
  assert.deepEqual(
    v.parse(pageListSchema, await (await routes(admin).request("/plugins/pages")).json()).pages,
    [],
  );
  await install(
    "invalid",
    { pages: [{ id: "editor", label: "Editor" }] },
    `export default {pages:{read:()=>({version:1,title:'Unsafe',html:'<script>bad</script>'})}}`,
  );
  await turnOn("invalid");
  assert.equal((await routes(admin).request("/plugins/invalid/pages/editor")).status, 502);
});

beforeEach(() => resetDatabase(db));

afterEach(async () => {
  vi.restoreAllMocks();
  stopAllPlugins();
  await rm(pluginsDir(), { recursive: true, force: true });
  await rm(path.dirname(pluginDataFolder("any")), { recursive: true, force: true });
});

afterAll(async () => {
  await cleanupIsolatedState(state);
});

test("scoped local playlist grants isolate users, survive queueing and recheck revocation", async () => {
  const { userOps } = await import("../../backend/db/helpers/index.ts");
  const grants = await import("../../backend/services/plugins/pluginUserOperations.ts");
  const operations = await import("../../backend/services/playlists/playlistOperations.ts");
  const { playlistOperationQueue: queue } = await import("../../backend/services/jobs/queues.ts");
  const one = userOps.createUser("listener-one", "test-only", "user", {
    accessPlaylists: true,
    addAlbum: false,
  })!;
  const two = userOps.createUser("listener-two", "test-only", "user", {
    accessPlaylists: true,
    addAlbum: false,
  })!;
  await install(
    "scoped",
    { actions: [{ id: "compare", label: "Compare", target: "track", localPlaylists: true }] },
    "export default {};",
  );
  await turnOn("scoped");
  const token = grants.issueUserOperationGrant("scoped", "compare", one.id);
  const tokenTwo = grants.issueUserOperationGrant("scoped", "compare", two.id);
  assert.throws(() => grants.resolveUserOperationGrant(`${token}x`, "scoped"));
  assert.throws(() => grants.resolveUserOperationGrant(token, "other"));
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60_000);
  assert.throws(() => grants.resolveUserOperationGrant(token, "scoped"), /Expired/);
  clock.mockRestore();
  const first = await grants.enqueueUserPlaylist(token, "scoped", {
    key: "work:one",
    name: "One",
    tracks: [],
  });
  const second = await grants.enqueueUserPlaylist(tokenTwo, "scoped", {
    key: "work:one",
    name: "Two",
    tracks: [],
  });
  assert.notEqual(first.playlistId, second.playlistId);
  assert.throws(() => grants.userOperationStatus(tokenTwo, "scoped", first.operationId));
  const firstJob = queue.getJob(first.operationId)!;
  const firstPayload: unknown = JSON.parse(firstJob.payload);
  const secondPayload: unknown = JSON.parse(queue.getJob(second.operationId)!.payload);
  await operations.processPlaylistOperation(
    v.parse(operations.playlistOperationSchema, firstPayload),
  );
  assert.equal(flowPlaylistConfig.getStaticPlaylist(first.playlistId)?.ownerUserId, one.id);
  await operations.processPlaylistOperation(
    v.parse(operations.playlistOperationSchema, firstPayload),
  );
  assert.equal(flowPlaylistConfig.getStaticPlaylist(first.playlistId)?.ownerUserId, one.id);
  userOps.updateUser(two.id, { permissions: { accessPlaylists: false } });
  await assert.rejects(
    operations.processPlaylistOperation(v.parse(operations.playlistOperationSchema, secondPayload)),
    /revoked/,
  );
  assert.equal(flowPlaylistConfig.getStaticPlaylist(second.playlistId), null);
  userOps.updateUser(one.id, { status: "inactive" });
  assert.throws(() => grants.resolveUserOperationGrant(token, "scoped"), /revoked/);
});

test("native acquisition identity runs independently of source priority and preserves no-op requests", async () => {
  const { resolvePluginAcquisitionIdentity, matchesAcquisitionTerms } =
    await import("../../backend/services/plugins/pluginAcquisitionIdentity.ts");
  const { buildTrackSearchTiers } =
    await import("../../backend/services/downloadJobs/trackSearchQueries.ts");
  await install(
    "identity",
    { downloadSource: { tracks: true, acquisitionIdentity: true } },
    `export default { downloadSource: { acquisitionIdentity: ({track}) => track.trackMbid === "liszt" ? {artist:"Daniil Trifonov",aliases:[]} : null } };`,
  );
  await turnOn("identity", { priority: 99 });
  assert.equal(matchesAcquisitionTerms("Liszt/Horowitz/Etude.flac", ["Trifonov"]), false);
  assert.equal(matchesAcquisitionTerms("Liszt/Trifonov/Etude.flac", ["Trifonov"]), true);
  const display = {
    artistName: "Franz Liszt",
    trackName: "Etude",
    albumName: "Transcendental",
    trackMbid: "liszt",
  };
  const identity = await resolvePluginAcquisitionIdentity(display);
  assert.ok(identity && "artist" in identity);
  const queries = buildTrackSearchTiers({ ...display, artistName: identity.artist }).flatMap(
    (tier) => tier.queries,
  );
  assert.ok(queries[0]?.includes("Trifonov"));
  assert.equal(display.artistName, "Franz Liszt");
  assert.equal(
    await resolvePluginAcquisitionIdentity({ artistName: "Rock Band", trackMbid: "rock" }),
    null,
  );
  await turnOn("identity", { capabilities: { downloadSource: false } });
  assert.equal(await resolvePluginAcquisitionIdentity(display), null);
});

test("a playlist action shows once its plugin is on and set up, and gets the playlist", async () => {
  await install(
    "box",
    {
      ...sendAction,
      settings: [{ key: "token", label: "Token", type: "password", required: true }],
    },
    `export default { actions: { send: ({ settings, user, playlist }) => ({
      message: \`\${playlist.name} (\${playlist.kind}, \${playlist.tracks.length} tracks) for \${user.username} with \${settings.token}\`,
    }) } };`,
  );
  const playlistId = ownedPlaylist();

  assert.deepEqual(await actionsFor(owner), []);
  assert.equal((await turnOn("box")).status, 200);
  assert.deepEqual(await actionsFor(owner), []);
  assert.equal((await turnOn("box", { settings: { token: "secret" } })).status, 200);
  assert.deepEqual(await actionsFor(owner), [
    {
      pluginId: "box",
      pluginName: "Plugin box",
      id: "send",
      label: "Send to Box",
      target: "playlist",
    },
  ]);

  const response = await run(owner, "box", "send", playlistId);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    message: `Road trip ${playlists} (playlist, 0 tracks) for owner with secret`,
  });
  assert.equal((await run(stranger, "box", "send", playlistId)).status, 404);
  assert.notEqual(db.prepare("SELECT settings FROM plugins").pluck().get(), '{"token":"secret"}');
});

test("a plugin runs its new code once its file changes, even when no one restarted it", async () => {
  const code = (message: string) =>
    `export default { actions: { send: () => ({ message: "${message}" }) } };`;
  await install("box", sendAction, code("first"));
  await turnOn("box");
  const playlistId = ownedPlaylist();
  const answer = async () => (await (await run(owner, "box", "send", playlistId)).json()).message;

  assert.equal(await answer(), "first");
  await writeFile(path.join(pluginsDir(), "box", "index.js"), code("second version"));
  assert.equal(await answer(), "second version");
});

test("saving one setting keeps the others, and an empty value clears it", async () => {
  await install(
    "box",
    {
      settings: [
        { key: "url", label: "URL", type: "text" },
        { key: "token", label: "Token", type: "password" },
      ],
    },
    "export default {};",
  );
  const save = (settings: Record<string, unknown>) =>
    routes(admin).request("/plugins/box", json("PUT", { settings }));
  const stored = async () =>
    (await listPlugins()).plugins.find((plugin) => plugin.id === "box")?.settings;

  await save({ url: "https://box.test" });
  await save({ token: "secret" });
  assert.deepEqual(await stored(), { url: "https://box.test", token: "secret" });
  await save({ url: "" });
  assert.deepEqual(await stored(), { token: "secret" });
});

test("an admin-only action is hidden from other users and refused for them", async () => {
  await install(
    "retag",
    { actions: [{ id: "fix", label: "Fix tags", target: "playlist", admin: true }] },
    `export default { actions: { fix: () => ({ message: "Fixed" }) } };`,
  );
  await turnOn("retag");
  const playlistId = ownedPlaylist();

  assert.equal((await actionsFor(owner)).length, 0);
  assert.equal((await actionsFor(admin)).length, 1);
  assert.equal((await run(owner, "retag", "fix", playlistId)).status, 403);
  assert.equal((await run(admin, "retag", "fix", playlistId)).status, 200);
});

test("a plugin that answers wrongly or keeps crashing is blamed and turned off", async () => {
  await install(
    "flaky",
    sendAction,
    `let runs = 0;
    export default { actions: { send: () => {
      runs += 1;
      if (runs === 1) return { message: 5 };
      process.exit(3);
    } } };`,
  );
  await turnOn("flaky");
  const playlistId = ownedPlaylist();

  const invalid = await run(owner, "flaky", "send", playlistId);
  assert.equal(invalid.status, 502);
  assert.match(
    (await invalid.json()).error,
    /^Plugin flaky: returned something Aurral can't read at message/,
  );

  const crashed = await run(owner, "flaky", "send", playlistId);
  assert.match((await crashed.json()).error, /^Plugin flaky: its process stopped with exit code 3/);
  await run(owner, "flaky", "send", playlistId);

  const [flaky] = (await listPlugins()).plugins;
  assert.equal(flaky?.enabled, false);
  assert.match(String(flaky?.lastError), /Turned off after 3 failures in a row/);
  assert.equal((await run(owner, "flaky", "send", playlistId)).status, 404);
});

test("an error the plugin throws is reported without turning it off", async () => {
  await install(
    "down",
    sendAction,
    `export default { actions: { send: () => { throw new Error("Box is unreachable"); } } };`,
  );
  await turnOn("down");
  const playlistId = ownedPlaylist();
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await run(owner, "down", "send", playlistId);
      assert.equal((await response.json()).error, "Plugin down: Box is unreachable");
    }
    assert.deepEqual(
      warn.mock.calls.map(([category, message]) => [category, message]),
      Array.from({ length: 3 }, () => ["plugin:down", "Box is unreachable"]),
    );
  } finally {
    warn.mockRestore();
  }
  const [down] = (await listPlugins()).plugins;
  assert.equal(down?.enabled, true);
  assert.equal(down?.lastError, "Box is unreachable");
});

test("safe mode hides plugin actions and refuses to run them", async () => {
  await install(
    "box",
    { ...sendAction, test: true },
    `export default { test: () => null, actions: { send: () => null } };`,
  );
  await turnOn("box");
  const playlistId = ownedPlaylist();

  await routes(admin).request("/plugins/safe-mode", json("PUT", { enabled: true }));
  assert.deepEqual(await actionsFor(owner), []);
  assert.equal((await run(owner, "box", "send", playlistId)).status, 404);
  assert.equal((await routes(admin).request("/plugins/box/test", { method: "POST" })).status, 409);

  await routes(admin).request("/plugins/safe-mode", json("PUT", { enabled: false }));
  assert.deepEqual(await (await run(owner, "box", "send", playlistId)).json(), {
    message: "Send to Box finished",
  });
});

test("plugin folders that can't load are listed with the reason", async () => {
  await install("renamed", { id: "other" }, "");
  await install("future", { api: 2 }, "");
  await install("nothing", { downloadSource: { tracks: false } }, "");
  await install("fileless", { downloadSource: { files: true } }, "");
  await mkdir(path.join(pluginsDir(), "broken"), { recursive: true });
  await writeFile(path.join(pluginsDir(), "broken", "manifest.json"), "{");

  const listed = Object.fromEntries(
    (await listPlugins()).plugins.map((plugin) => [plugin.id, plugin.error]),
  );
  assert.deepEqual(listed, {
    broken: "manifest.json is not valid JSON",
    fileless: "manifest.json downloadSource: files needs albums",
    nothing: "manifest.json downloadSource: needs tracks or albums",
    future: "Needs plugin API 2. This Aurral runs plugin API 1.",
    renamed: "The folder has to be named other",
  });
  assert.equal(
    (await routes(admin).request("/plugins/renamed", json("PUT", { enabled: true }))).status,
    404,
  );
  assert.equal((await routes(admin).request("/plugins/broken", { method: "DELETE" })).status, 200);
  assert.deepEqual(
    (await listPlugins()).plugins.map((plugin) => plugin.id),
    ["fileless", "future", "nothing", "renamed"],
  );
});

test("only admins see and change plugins", async () => {
  await install("box", sendAction, `export default { actions: { send: () => null } };`);

  assert.equal((await routes(owner).request("/plugins")).status, 403);
  assert.equal(
    (await routes(owner).request("/plugins/box", json("PUT", { enabled: true }))).status,
    403,
  );
});

test("a turned-off capability is hidden and refused while the rest of the plugin works", async () => {
  await install(
    "box",
    {
      actions: [
        { id: "send", label: "Send to Box", target: "playlist" },
        { id: "share", label: "Share on Box", target: "playlist" },
      ],
    },
    `export default { actions: { send: () => null, share: () => null } };`,
  );
  await turnOn("box", { capabilities: { "action:send": false } });
  const playlistId = ownedPlaylist();

  assert.deepEqual(
    (await actionsFor(owner)).map((action: { id: string }) => action.id),
    ["share"],
  );
  assert.equal((await run(owner, "box", "send", playlistId)).status, 404);
  assert.equal((await run(owner, "box", "share", playlistId)).status, 200);
  assert.equal((await turnOn("box", { capabilities: { "action:nope": false } })).status, 400);

  await turnOn("box", { capabilities: { "action:send": true } });
  assert.equal((await actionsFor(owner)).length, 2);
});

test("album and track actions get the Library's album and tracks", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "aurral-plugin-library-"));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  for (const [index, title] of ["Night Drive", "Morning Run"].entries())
    await writeFlacFixture(path.join(root, `0${index + 1}.flac`), {
      title,
      artist: "Glass Coast",
      album_artist: "Glass Coast",
      album: "Lowlands",
      track: index + 1,
    });
  await scanMusicRoot({ rootPath: root, source: "aurral" });
  const library = getLibrary({ availableOnly: true });
  const album = library.albums.find((entry) => entry.title === "Lowlands");
  assert.ok(album);
  const trackIds = library.tracks.map((track) => track.id);

  await install(
    "tags",
    {
      actions: [
        { id: "album", label: "Album", target: "album" },
        { id: "tracks", label: "Tracks", target: "track" },
      ],
    },
    `export default { actions: {
      album: ({ album }) => ({ message: album.artist + " / " + album.title + ": " + album.tracks.map((track) => track.trackNumber + " " + track.title).join(", ") }),
      tracks: ({ tracks }) => ({ message: tracks.map((track) => track.title + " @ " + track.album + " " + (track.path !== null)).sort().join(", ") }),
    } };`,
  );
  await turnOn("tags");
  const runOn = (action: string, body: object) =>
    routes(owner).request(`/plugins/tags/actions/${action}`, json("POST", body));

  assert.deepEqual(await (await runOn("album", { albumId: album.id })).json(), {
    message: "Glass Coast / Lowlands: 1 Night Drive, 2 Morning Run",
  });
  assert.deepEqual(await (await runOn("tracks", { trackIds })).json(), {
    message: "Morning Run @ Lowlands true, Night Drive @ Lowlands true",
  });
  assert.equal((await runOn("album", { albumId: "missing" })).status, 404);

  const albumId = String(album.id);
  const trackAt = (number: number) =>
    String(library.tracks.find((track) => track.albums[0]?.trackNumber === number)?.id);
  const firstTrack = trackAt(1);
  const item = `{id:'item-1',trackId:${JSON.stringify(firstTrack)},fileId:'file-1',albumId:${JSON.stringify(albumId)},title:'I. First',artist:'Glass Coast',album:'Lowlands',durationMs:1000,startMs:100,endMs:900}`;
  const itemOn = (id: string, trackNumber: number) =>
    `{id:'${id}',trackId:${JSON.stringify(trackAt(trackNumber))},fileId:'${id}-file',albumId:${JSON.stringify(albumId)},title:'${id}',artist:'Glass Coast',album:'Lowlands',durationMs:1000,startMs:0,endMs:null}`;
  const movement = `{id:'movement-1',title:'I. First',position:1}`;
  const work = `{version:1,work:{id:'work-1',title:'Fixture Work',nickname:'user-'+input.user.id,description:'',credits:[],movements:[${movement}],collections:[]},favourite:false,pickedRealizationId:null,pickScope:null,recordings:[{id:'realization-1',label:'Owned recording',recordingIds:['recording-1'],credits:[],items:[${item}],missing:[],complete:true}]}`;
  await install(
    "views",
    {
      pages: [{ id: "work", label: "Work", admin: false }],
      albumPresentation: true,
    },
    `export default {
      albumPresentation:()=>({version:1,albumId:${JSON.stringify(albumId)},supportsToggle:true,groups:[{id:'piece-2',workId:null,title:'Single Piece',composer:'Composer',detail:'Not matched to a work',items:[${itemOn("later", 2)}],missing:[],movementCount:1},{id:'realization-1',workId:'work-1',title:'Fixture Work',composer:'Composer',items:[${item}],missing:[],movementCount:2},...Array.from({length:300},(_,i)=>({id:'box-'+i,workId:null,title:'Box piece '+i,composer:'Composer',items:[${itemOn("box", 2)}],missing:[],movementCount:1}))]}),
      pages:{read:(input)=>(${work}),mutate:()=>({ok:true})}
    }`,
  );
  await turnOn("views");
  const presentation = await routes(owner).request(`/plugins/album-presentation/${album.id}`);
  assert.equal(presentation.status, 200);
  const presentationBody = v.parse(
    v.object({
      groups: v.array(
        v.object({
          id: v.string(),
          href: v.nullable(v.string()),
          detail: v.optional(v.string()),
          items: v.array(v.object({ streamPath: v.string() })),
        }),
      ),
    }),
    await presentation.json(),
  );
  // A box set has far more pieces than a work has movements.
  assert.equal(presentationBody.groups.length, 302);
  assert.deepEqual(
    presentationBody.groups.slice(0, 2).map((group) => group.id),
    ["realization-1", "piece-2"],
  );
  // A single piece has no work page to open.
  assert.equal(presentationBody.groups[1]?.href, null);
  assert.equal(presentationBody.groups[1]?.detail, "Not matched to a work");
  const presentedGroup = presentationBody.groups.find((group) => group.id === "realization-1");
  assert.ok(presentedGroup);
  const [presentedItem] = presentedGroup.items;
  assert.ok(presentedItem);
  assert.equal(presentedGroup.href, "/plugins/views/work/work-1");
  assert.match(presentedItem.streamPath, /\/library\/stream\//);
  const ownerWork = await routes(owner).request("/plugins/views/resources/work/work-1");
  assert.equal(ownerWork.status, 200);
  const workResponse = v.object({ work: v.object({ nickname: v.string() }) });
  assert.equal(v.parse(workResponse, await ownerWork.json()).work.nickname, `user-${owner.id}`);
  const strangerWork = await routes(stranger).request("/plugins/views/resources/work/work-1");
  assert.equal(
    v.parse(workResponse, await strangerWork.json()).work.nickname,
    `user-${stranger.id}`,
  );
  assert.equal(
    (
      await routes(owner).request(
        "/plugins/views/resources/work/work-1",
        json("POST", { command: "pick", realizationId: "realization-1" }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await routes(owner).request(
        "/plugins/views/resources/work/work-1",
        json("POST", { command: "admin-pick", realizationId: "realization-1" }),
      )
    ).status,
    403,
  );
  await turnOn("views", { capabilities: { albumPresentation: false, "page:work": false } });
  assert.equal(
    await (await routes(owner).request(`/plugins/album-presentation/${album.id}`)).json(),
    null,
  );
  // A contribution that fails is reported, not shown as a plain album.
  await install(
    "stray",
    { albumPresentation: true },
    `export default { albumPresentation: () => ({version:1,albumId:${JSON.stringify(albumId)},supportsToggle:true,groups:[{id:'g',workId:null,title:'Stray',composer:'',items:[${itemOn("stray", 2).replace(`albumId:${JSON.stringify(albumId)}`, "albumId:'other'")}],missing:[],movementCount:1}]}) }`,
  );
  await turnOn("stray");
  assert.equal(
    (await routes(owner).request(`/plugins/album-presentation/${album.id}`)).status,
    502,
  );
  assert.equal((await routes(owner).request("/plugins/views/resources/work/work-1")).status, 404);
});

test("a background action answers right away and reports its result to the user who ran it", async () => {
  await install(
    "slow",
    { actions: [{ id: "sync", label: "Sync", target: "playlist", background: true }] },
    `export default { actions: { sync: async () => ({ message: "Synced 12 tracks" }) } };`,
  );
  await turnOn("slow");
  const playlistId = ownedPlaylist();
  const finished = new Promise<unknown[]>((resolve) => {
    vi.spyOn(websocketService, "broadcast").mockImplementation((...args) => {
      resolve(args);
      return 1;
    });
  });

  assert.deepEqual(await (await run(owner, "slow", "sync", playlistId)).json(), {
    message: "Sync started",
  });
  assert.deepEqual(await finished, [
    "plugins",
    { type: "plugin_action_finished", ok: true, message: "Synced 12 tracks" },
    { userId: owner.id },
  ]);
});

test("an event is queued for each subscribed plugin and delivered with its data", async (t) => {
  const folder = await mkdtemp(path.join(tmpdir(), "aurral-plugin-event-"));
  t.onTestFinished(() => rm(folder, { recursive: true, force: true }));
  const out = path.join(folder, "played.json");
  await install(
    "scrobble",
    { events: ["track.played"], settings: [{ key: "out", label: "Out", type: "text" }] },
    `export default { events: { "track.played": async (input) => {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(input.settings.out, JSON.stringify(input));
    } } };`,
  );
  const queued = () =>
    notificationQueue
      .list()
      .filter((job) => v.parse(queuedNotificationSchema, job.payload).kind === "plugin");
  const played = { track: { title: "Night Drive" }, playedAt: 5 };

  emitPluginEvent("track.played", played);
  assert.equal(queued().length, 0);

  await turnOn("scrobble", { settings: { out }, capabilities: { "event:track.played": false } });
  emitPluginEvent("track.played", played);
  assert.equal(queued().length, 0);

  await turnOn("scrobble", { capabilities: { "event:track.played": true } });
  emitPluginEvent("track.played", played);
  const [job] = queued();
  assert.ok(job);
  await deliverPluginEvent(v.parse(pluginEventDeliverySchema, job.payload));
  const input = JSON.parse(await readFile(out, "utf8"));
  assert.equal(input.event, "track.played");
  assert.deepEqual(input.track, { title: "Night Drive" });
  assert.equal(input.playedAt, 5);
  assert.equal(typeof input.libraryFolder, "string");

  emitPluginEvent("track.played", played);
  const [stale] = queued();
  assert.ok(stale);
  await install(
    "scrobble",
    { settings: [{ key: "out", label: "Out", type: "text" }] },
    "export default {};",
  );
  for (let attempt = 0; attempt < 3; attempt += 1)
    await deliverPluginEvent(v.parse(pluginEventDeliverySchema, stale.payload));
  assert.equal((await listPlugins()).plugins[0]?.enabled, true);
});

test("a plugin that never answers an event doesn't hold up Aurral's notifications", async () => {
  await install(
    "stuck",
    { events: ["track.played"] },
    `export default { events: { "track.played": () => new Promise(() => {}) } };`,
  );
  await turnOn("stuck");
  emitPluginEvent("track.played", { playedAt: 1 });
  const [job] = notificationQueue.list();
  assert.ok(job);

  await deliverQueuedNotification(v.parse(queuedNotificationSchema, job.payload));
});

test("an import list previews links on its hosts and refuses others", async () => {
  await install(
    "camp",
    { importList: { label: "Bandcamp", hosts: ["bandcamp.com"] } },
    `export default { importList: { fetch: ({ url }) => ({
      name: "Picks from " + new URL(url).hostname,
      tracks: [{ artist: "Glass Coast", title: "Night Drive" }, { artist: "", title: "" }],
    }) } };`,
  );
  await turnOn("camp");
  const preview = (url: string) =>
    routes(owner).request("/plugins/camp/import/preview", json("POST", { url }));

  const response = await preview("https://glasscoast.bandcamp.com/album/lowlands");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.playlist.name, "Picks from glasscoast.bandcamp.com");
  assert.equal(body.trackCount, 1);
  assert.equal(body.skipped, 1);
  assert.equal((await preview("https://example.com/list")).status, 400);
});

test("an import list that never changes imports once, whatever sync the request asks for", async () => {
  await install(
    "trip",
    { importList: { label: "Road Trip", hosts: ["maps.example.com"], sync: false } },
    `export default { importList: { fetch: () => ({
      name: "Portland to Boise",
      tracks: [{ artist: "Laura Gibson", title: "La Grande" }],
    }) } };`,
  );
  await turnOn("trip");
  const enqueue = vi
    .spyOn(playlistOperationQueue, "enqueuePayload")
    .mockImplementation(async () => ({ queued: true, operationId: 1 }));

  const lists = await (await routes(owner).request("/plugins/import-lists")).json();
  assert.equal(lists.importLists[0].sync, false);
  const response = await routes(owner).request(
    "/plugins/trip/import",
    json("POST", {
      url: "https://maps.example.com/dir/portland/boise",
      name: "Portland to Boise",
      syncEnabled: true,
      syncIntervalHours: 24,
    }),
  );

  assert.equal(response.status, 200);
  assert.partialDeepStrictEqual(enqueue.mock.calls[0]?.[0], {
    importSource: { provider: "plugin:trip", syncEnabled: false, syncIntervalHours: 0 },
  });
});

test("a scheduled plugin runs once its interval passes and keeps files in its data folder", async () => {
  await install(
    "ticker",
    { schedule: "1h" },
    `import { readFile, writeFile } from "node:fs/promises";
    export default { async scheduled({ dataFolder }) {
      const file = dataFolder + "/runs";
      await writeFile(file, String(Number(await readFile(file, "utf8").catch(() => "0")) + 1));
    } };`,
  );
  const start = Date.now();
  const hours = (count: number) => start + count * 60 * 60_000;

  assert.deepEqual(await runDuePluginSchedules(start), []);
  await turnOn("ticker");
  assert.deepEqual(await runDuePluginSchedules(start), ["ticker"]);
  assert.deepEqual(await runDuePluginSchedules(hours(0.5)), []);
  assert.deepEqual(await runDuePluginSchedules(hours(1)), ["ticker"]);
  assert.equal(await readFile(path.join(pluginDataFolder("ticker"), "runs"), "utf8"), "2");

  await turnOn("ticker", { capabilities: { schedule: false } });
  assert.deepEqual(await runDuePluginSchedules(hours(3)), []);
  await routes(admin).request("/plugins/ticker", { method: "DELETE" });
  await assert.rejects(access(pluginDataFolder("ticker")));
});

test("a plugin's own API key reads its library snapshot for scheduled syncs", async () => {
  setSafeMode(false);
  await install("reader", { apiAccess: true }, "export default {};");
  await install("other", { apiAccess: true }, "export default {};");
  await turnOn("reader");
  await turnOn("other");
  const keyFor = (id: string) => pluginInput(activePlugin(id)!).api?.key ?? "";
  const snapshot = (apiKey: string) =>
    routes(stranger).request("/plugins/reader/user-operations/library", {
      headers: { "X-Api-Key": apiKey },
    });
  const readerKey = keyFor("reader");
  const allowed = await snapshot(readerKey);
  assert.equal(allowed.status, 200);
  const body: unknown = await allowed.json();
  assert.equal(
    v.parse(v.object({ version: v.number(), complete: v.boolean() }), body).complete,
    true,
  );
  assert.equal((await snapshot(keyFor("other"))).status, 403);
  assert.equal((await snapshot(`${keyFor("reader")}x`)).status, 403);
  await turnOn("reader", { capabilities: { api: false } });
  assert.equal((await snapshot(readerKey)).status, 403);
});

test("a plugin's API key acts as an admin only while the plugin can run", async () => {
  await install("helper", { apiAccess: true }, "export default {};");
  await turnOn("helper");
  const plugin = activePlugin("helper");
  assert.ok(plugin);
  const key = pluginInput(plugin).api?.key ?? "";
  const userFor = (apiKey: string) => resolveRequestUser({ headers: { "x-api-key": apiKey } });

  assert.deepEqual(
    { username: userFor(key)?.username, role: userFor(key)?.role },
    { username: "plugin:helper", role: "admin" },
  );
  assert.equal(userFor(`${key}x`), null);

  await routes(admin).request("/plugins/helper", json("PUT", { enabled: false }));
  assert.equal(userFor(key), null);
  assert.equal((await whilePluginTests("helper", async () => userFor(key)))?.role, "admin");

  await turnOn("helper", { capabilities: { api: false } });
  assert.equal(userFor(key), null);
  await turnOn("helper", { capabilities: { api: true } });
  setSafeMode(true);
  assert.equal(userFor(key), null);
});
