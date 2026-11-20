// The Library snapshot from the aurral-classical branch's plugin user
// operations (pluginUserOperations.ts there), unchanged: a plugin reads the
// whole Library with its own key, as the classical catalogue's scan does. The
// user action grants and playlist operations stay on that branch.
import { pluginForApiKey } from "./pluginStore.ts";
import { getLibrary } from "../libraryQueryService.ts";
import { getPathMappings, resolveLocalPath } from "../pathMappings.ts";

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
