import { constants } from "fs";
import fs from "fs/promises";
import path from "path";
import { parseFile } from "music-metadata";
import { downloadTracker } from "./downloadTracker.ts";
import { restoreDownloadJobCancellations, withPipelineCommitLock } from "./downloadCancellation.ts";
import { canLinkLibraryFile } from "./linkLibraryFile.ts";
import { flowPlaylistConfig } from "../playlists/flowPlaylistConfig.ts";
import { buildTrackDestination, isPathInsideRoot, resolveDownloadRoot } from "../downloadPaths.ts";
import {
  buildTrackFileName,
  commitDownloadedFile,
  joinUnderRoot,
  sanitizePathPart,
  writeImportedFileMetadata,
} from "../downloadUtils.ts";
import { recordPipelineJobSuccess, refreshCompletedPipelinePlaylist } from "../pipelineHelpers.ts";
import { classifyQualityJob } from "../qualityProfileService.ts";
import { validateParsedQuality } from "../qualityProfile.ts";
import {
  formatBrowseDisplayPath,
  getFilesystemBrowseRoots,
  resolveExistingBrowsePath,
} from "../downloadFolderConfig.ts";
import { AUDIO_EXTENSIONS } from "../libraryFileScanner.ts";
import { ALBUM_IMAGE_EXTENSIONS } from "../libraryFiles/fileTransfer.ts";
import { resolveLocalPath } from "../pathMappings.ts";
import { logger, safeLogDiagnostic } from "../logger.ts";

// A missing track can be filled with an audio file from anywhere Aurral can
// read, such as a folder another app also uses. Aurral copies the file into the
// Library like a download, tags it, and leaves the original where it is. The
// album art beside it, such as cover.jpg, comes along the same way.

export type ImportDiskFileResult =
  | { ok: true; path: string }
  | { ok: false; status: 400 | 404 | 409; error: string };

const isAudioFile = (filePath: string) =>
  AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());

// The folders and audio files in one folder under the storage paths Aurral may
// browse, for picking a file to import.
export async function listDiskFiles(requestedPath: unknown) {
  const roots = getFilesystemBrowseRoots();
  if (!roots.length) {
    throw new Error("No browsable storage path is available. Mount a shared folder into Aurral.");
  }
  const current = resolveExistingBrowsePath(requestedPath, roots);
  if (!current) throw new Error("No browsable storage path is available.");
  const parent = roots.includes(current)
    ? null
    : resolveExistingBrowsePath(path.dirname(current), roots);
  const entries = (await fs.readdir(current, { withFileTypes: true }))
    .filter((entry) => !entry.name.startsWith("."))
    .filter((entry) => entry.isDirectory() || (entry.isFile() && isAudioFile(entry.name)))
    .map((entry) => ({
      name: entry.name,
      path: path.resolve(current, entry.name),
      kind: entry.isDirectory() ? ("folder" as const) : ("file" as const),
    }))
    .sort(
      (left, right) =>
        Number(left.kind === "file") - Number(right.kind === "file") ||
        left.name.localeCompare(right.name, undefined, { numeric: true }),
    );
  return { path: current, displayPath: formatBrowseDisplayPath(current), parent, roots, entries };
}

// More images than this in the source folder means it is not one album's
// folder, so none are copied.
const MAX_ALBUM_IMAGES = 10;

// Copies the album art in a track's source folder into its Library folder,
// like a Library ingest does. Images already in the Library folder are kept.
export async function copyAlbumImages(sourceDir: string, targetDir: string) {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true }).catch(() => []);
  const images = entries.filter(
    (entry) =>
      entry.isFile() &&
      !entry.name.startsWith(".") &&
      ALBUM_IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()),
  );
  if (images.length > MAX_ALBUM_IMAGES) return [];
  const copied: string[] = [];
  for (const image of images) {
    try {
      await fs.copyFile(
        path.join(sourceDir, image.name),
        path.join(targetDir, image.name),
        constants.COPYFILE_EXCL,
      );
      copied.push(image.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") continue;
      logger.warn("downloads", "Could not copy album art for an imported file", {
        file: path.join(sourceDir, image.name),
        reason: safeLogDiagnostic(error),
      });
    }
  }
  return copied;
}

export async function importDiskFileToJob(
  jobId: string,
  requestedPath: string,
): Promise<ImportDiskFileResult> {
  const job = downloadTracker.getJob(jobId);
  if (!job) return { ok: false, status: 404, error: "Track not found" };
  if (!canLinkLibraryFile(job)) {
    return { ok: false, status: 409, error: "Only a missing track can be imported from a file" };
  }
  const raw = String(requestedPath || "").trim();
  if (!raw || !path.isAbsolute(raw)) {
    return { ok: false, status: 400, error: "Enter the full path of the file." };
  }
  // A path as another app sees it is mapped to Aurral's through the path mappings.
  const sourcePath = path.resolve(resolveLocalPath(raw));
  const stat = await fs.stat(sourcePath).catch(() => null);
  if (!stat?.isFile()) {
    return {
      ok: false,
      status: 404,
      error: "Aurral cannot find that file. Check the path, or add a path mapping for it.",
    };
  }
  if (!isAudioFile(sourcePath)) {
    return { ok: false, status: 400, error: "Choose an audio file." };
  }
  const downloadRoot = path.resolve(resolveDownloadRoot());
  if (isPathInsideRoot(sourcePath, downloadRoot)) {
    return {
      ok: false,
      status: 409,
      error: "That file is already in the Library folder. Use Link a Library file instead.",
    };
  }

  let parsed;
  try {
    parsed = await parseFile(sourcePath, { duration: true });
  } catch {
    return { ok: false, status: 409, error: "That file is not readable audio." };
  }
  // A file you choose skips the title and artist checks, like a manual
  // download, but its quality must be known.
  const quality = validateParsedQuality(parsed, sourcePath, { manualSelection: true });
  if (!quality.valid) {
    return { ok: false, status: 409, error: "Aurral cannot tell the quality of that file." };
  }

  if (job.status === "cancelled") restoreDownloadJobCancellations([job.id]);
  const playlistId = job.playlistId || job.playlistType;
  const destination = buildTrackDestination(
    playlistId,
    sanitizePathPart(job.artistName, "Unknown Artist"),
    sanitizePathPart(job.albumName, "Unknown Album"),
    { ephemeral: Boolean(flowPlaylistConfig.getFlow(playlistId)) },
  );
  const finalPath = path.join(
    joinUnderRoot(downloadRoot, destination),
    buildTrackFileName(job, path.extname(sourcePath).toLowerCase()),
  );
  const committed = await withPipelineCommitLock(
    { jobId: job.id, playlistId, playlistGeneration: job.playlistGeneration },
    async () => {
      const current = downloadTracker.getJob(job.id);
      if (!canLinkLibraryFile(current)) return null;
      const committedPath = await commitDownloadedFile(sourcePath, finalPath, {
        preserveSource: true,
      });
      await copyAlbumImages(path.dirname(sourcePath), path.dirname(committedPath));
      await writeImportedFileMetadata(committedPath, current, {
        source: "manual-import",
        jobId: job.id,
      });
      await recordPipelineJobSuccess({
        downloadTracker,
        job: current,
        committedFinalPath: committedPath,
        quality: quality.quality,
      });
      return committedPath;
    },
  );
  if (committed.cancelled || !committed.result) {
    return { ok: false, status: 409, error: "The track changed. Reload and try again." };
  }
  try {
    await classifyQualityJob(downloadTracker.getJob(job.id));
    await refreshCompletedPipelinePlaylist(job);
  } catch (error) {
    logger.warn("downloads", "Imported a file for a track but its follow-up failed", {
      jobId: job.id,
      reason: safeLogDiagnostic(error),
    });
  }
  logger.info("downloads", "Imported a file from disk for a missing track", {
    jobId: job.id,
    source: sourcePath,
    path: committed.result,
  });
  return { ok: true, path: committed.result };
}
