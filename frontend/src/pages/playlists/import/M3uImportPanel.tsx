import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { parseResponse, type InferResponseType } from "hono/client";
import { Music2 } from "../../../components/icons";
import { DotLoader } from "../../../components/DotLoader";
import PillToggle from "../../../components/PillToggle";
import { SettingsGroup, SettingsNote, SettingsRow } from "../../Settings/SettingsLayout.tsx";
import { playlistImportsClient } from "../../../utils/api/clients/playlistImports.ts";
import { getApiErrorMessage } from "../../../utils/api/errors.ts";

// Imports .m3u/.m3u8 playlists from a folder on the server. Admin-only,
// since it reads server folders and can copy files into the Library.

const m3uApi = playlistImportsClient.import.m3u;
type ScanResult = InferResponseType<typeof m3uApi.scan.$post, 200>;

const FOLDER_KEY = "aurral:m3uImportFolder";
const readFolder = () => {
  try {
    return localStorage.getItem(FOLDER_KEY) || "/data/media/playlists";
  } catch {
    return "/data/media/playlists";
  }
};

const playlistMeta = (playlist: ScanResult["playlists"][number]) => {
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const parts = [plural(playlist.trackCount, "track")];
  if (playlist.filesFound < playlist.trackCount) {
    parts.push(`${plural(playlist.trackCount - playlist.filesFound, "file")} missing`);
  }
  if (playlist.inLibrary > 0) parts.push(`${playlist.inLibrary} already in the Library`);
  return parts.join(" · ");
};

const OPTIONS = [
  [
    "copyTracks",
    "Copy tracks into the Library",
    "Files next to each playlist are copied into the Library and tagged, then the playlist uses those copies. The originals stay where they are.",
  ],
  [
    "downloadMissing",
    "Download tracks that aren't in the Library",
    "Otherwise those tracks are left out of the playlist.",
  ],
] as const;

export function M3uImportPanel({
  onDone,
  showError,
  showSuccess,
}: {
  onDone: () => void;
  showError?: (message: string) => void;
  showSuccess?: (message: string) => void;
}) {
  const [folder, setFolder] = useState(readFolder);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [options, setOptions] = useState({ copyTracks: true, downloadMissing: false });

  const scan = useMutation({
    mutationFn: (path: string) => parseResponse(m3uApi.scan.$post({ json: { folder: path } })),
    onSuccess: (result) => {
      try {
        localStorage.setItem(FOLDER_KEY, result.folder);
      } catch {}
      setSelected(
        new Set(result.playlists.filter((entry) => !entry.alreadyImported).map((p) => p.path)),
      );
    },
    onError: (error) => showError?.(getApiErrorMessage(error, "Could not read that folder")),
  });

  const runImport = useMutation({
    mutationFn: () =>
      parseResponse(
        m3uApi.$post({
          json: { folder: scan.data!.folder, files: [...selected], ...options },
        }),
      ),
    onSuccess: (result) => {
      const built = result.imported.filter((entry) => "playlistId" in entry && entry.playlistId);
      const waiting = result.waitingForIngest.length;
      showSuccess?.(
        [
          built.length ? `Imported ${built.length} playlist${built.length === 1 ? "" : "s"}.` : "",
          waiting
            ? `${waiting} more will appear once their tracks are copied into the Library.`
            : "",
        ]
          .filter(Boolean)
          .join(" ") || "Nothing new to import.",
      );
      onDone();
    },
    onError: (error) => showError?.(getApiErrorMessage(error, "Failed to import playlists")),
  });

  const busy = scan.isPending || runImport.isPending;
  const playlists = scan.data?.playlists ?? [];
  const toggle = (path: string) => {
    const next = new Set(selected);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setSelected(next);
  };

  const selectable = playlists.filter((playlist) => !playlist.alreadyImported);
  const allSelected = selectable.length > 0 && selectable.every((p) => selected.has(p.path));

  return (
    <>
      <SettingsGroup>
        <SettingsRow
          label="Playlists folder"
          htmlFor="m3u-import-folder"
          help="A folder on the server. Aurral reads it and its subfolders for .m3u and .m3u8 files."
          stack
        >
          <form
            className="playlist-import__load"
            onSubmit={(event) => {
              event.preventDefault();
              if (folder.trim()) scan.mutate(folder.trim());
            }}
          >
            <input
              id="m3u-import-folder"
              type="text"
              className="input"
              value={folder}
              spellCheck={false}
              autoComplete="off"
              placeholder="/data/media/playlists"
              onChange={(event) => setFolder(event.target.value)}
              disabled={busy}
            />
            <button type="submit" className="btn btn-secondary" disabled={busy || !folder.trim()}>
              {scan.isPending ? <DotLoader size="sm" label={null} /> : null}
              Scan
            </button>
          </form>
        </SettingsRow>
      </SettingsGroup>

      {scan.data && playlists.length === 0 ? (
        <SettingsNote>No .m3u or .m3u8 files in that folder.</SettingsNote>
      ) : null}

      {playlists.length > 0 ? (
        <>
          <SettingsGroup
            title="Playlists"
            actions={
              selectable.length > 0 ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() =>
                    setSelected(allSelected ? new Set() : new Set(selectable.map((p) => p.path)))
                  }
                  disabled={busy}
                >
                  {allSelected ? "Select none" : "Select all"}
                </button>
              ) : null
            }
          >
            {playlists.map((playlist, index) => {
              const id = `m3u-import-playlist-${index}`;
              return (
                <SettingsRow
                  key={playlist.path}
                  label={playlist.name}
                  htmlFor={id}
                  help={playlist.alreadyImported ? "Already imported" : playlistMeta(playlist)}
                >
                  <input
                    id={id}
                    type="checkbox"
                    className="artist-checkbox"
                    checked={selected.has(playlist.path)}
                    disabled={busy || playlist.alreadyImported}
                    onChange={() => toggle(playlist.path)}
                  />
                </SettingsRow>
              );
            })}
          </SettingsGroup>

          <SettingsGroup title="Options">
            {OPTIONS.map(([key, label, hint]) => (
              <SettingsRow key={key} label={label} help={hint}>
                <PillToggle
                  checked={options[key]}
                  aria-label={label}
                  onChange={(event) => setOptions({ ...options, [key]: event.target.checked })}
                  disabled={busy}
                />
              </SettingsRow>
            ))}
          </SettingsGroup>

          <div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => runImport.mutate()}
              disabled={busy || selected.size === 0}
            >
              {runImport.isPending ? (
                <DotLoader size="sm" label={null} />
              ) : (
                <Music2 className="artist-icon-sm" />
              )}
              Import {selected.size} playlist{selected.size === 1 ? "" : "s"}
            </button>
          </div>
        </>
      ) : null}
    </>
  );
}
