import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { parseResponse, type InferResponseType } from "hono/client";
import { Music2 } from "../../../components/icons";
import { DotLoader } from "../../../components/DotLoader";
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
  const [copyTracks, setCopyTracks] = useState(true);
  const [downloadMissing, setDownloadMissing] = useState(false);

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
          json: { folder: scan.data!.folder, files: [...selected], copyTracks, downloadMissing },
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

  return (
    <div className="playlist-import__share">
      <label className="playlist-import__field-label" htmlFor="m3u-import-folder">
        Playlists folder on the server
      </label>
      <form
        className="playlist-import__selected"
        onSubmit={(event) => {
          event.preventDefault();
          if (folder.trim()) scan.mutate(folder.trim());
        }}
      >
        <input
          id="m3u-import-folder"
          className="input"
          value={folder}
          spellCheck={false}
          autoComplete="off"
          placeholder="/data/media/playlists"
          onChange={(event) => setFolder(event.target.value)}
          disabled={busy}
        />
        <button
          type="submit"
          className="btn btn-secondary btn-sm"
          disabled={busy || !folder.trim()}
        >
          {scan.isPending ? <DotLoader size="xs" label={null} /> : null}
          Scan
        </button>
      </form>

      {scan.data ? (
        playlists.length === 0 ? (
          <p className="playlist-import__choice-hint">No .m3u or .m3u8 files in that folder.</p>
        ) : (
          <>
            <div className="playlist-import__list-panel">
              <div className="playlist-import__playlist-list">
                {playlists.map((playlist) => (
                  <label key={playlist.path} className="playlist-import__playlist-option">
                    <span className="playlist-import__selected-copy">
                      <span className="playlist-import__playlist-name">{playlist.name}</span>
                      <span className="playlist-import__playlist-meta">
                        {playlist.alreadyImported ? "Already imported" : playlistMeta(playlist)}
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      className="artist-checkbox"
                      aria-label={`Import ${playlist.name}`}
                      checked={selected.has(playlist.path)}
                      disabled={busy || playlist.alreadyImported}
                      onChange={() => toggle(playlist.path)}
                    />
                  </label>
                ))}
              </div>
            </div>

            <div className="playlist-import__choices">
              <label className="playlist-import__choice">
                <input
                  type="checkbox"
                  className="artist-checkbox"
                  checked={copyTracks}
                  onChange={(event) => setCopyTracks(event.target.checked)}
                  disabled={busy}
                />
                <span className="playlist-import__selected-copy">
                  <span>Copy tracks into the Library</span>
                  <span className="playlist-import__choice-hint">
                    Files next to each playlist are copied into the Library and tagged, then the
                    playlist uses those copies. The originals stay where they are.
                  </span>
                </span>
              </label>
              <label className="playlist-import__choice">
                <input
                  type="checkbox"
                  className="artist-checkbox"
                  checked={downloadMissing}
                  onChange={(event) => setDownloadMissing(event.target.checked)}
                  disabled={busy}
                />
                <span className="playlist-import__selected-copy">
                  <span>Download tracks that aren&apos;t in the Library</span>
                  <span className="playlist-import__choice-hint">
                    Otherwise those tracks are left out of the playlist.
                  </span>
                </span>
              </label>
            </div>

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
          </>
        )
      ) : null}
    </div>
  );
}
