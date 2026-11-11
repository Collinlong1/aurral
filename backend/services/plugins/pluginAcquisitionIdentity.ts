import * as v from "valibot";
import { activePlugins, isCapabilityOn, pluginInput } from "./pluginStore.ts";
import { callPlugin } from "./pluginHost.ts";

const result = v.nullable(
  v.union([
    v.object({ blocked: v.literal(true) }),
    v.object({
      artist: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
      aliases: v.pipe(v.array(v.string()), v.maxLength(20)),
      requiredTerms: v.optional(
        v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(100))), v.maxLength(20)),
        [],
      ),
    }),
  ]),
);

export type AcquisitionIdentity = v.InferOutput<typeof result>;
export function matchesAcquisitionTerms(file: string, terms: string[] = []) {
  const normalize = (text: string) =>
    text
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const words = ` ${normalize(file)} `;
  return terms.every((term) =>
    normalize(term)
      .split(" ")
      .every((word) => words.includes(` ${word} `)),
  );
}

// Run before native Soulseek query construction, independently of source priority.
// Failed identity providers hold this acquisition attempt instead of reverting to an unsafe identity.
export async function resolvePluginAcquisitionIdentity(track: {
  artistName?: string | null;
  trackMbid?: string | null;
  releaseMbid?: string | null;
}) {
  for (const plugin of activePlugins().filter(
    (p) =>
      p.manifest.downloadSource?.acquisitionIdentity &&
      isCapabilityOn(p, "downloadSource") &&
      isCapabilityOn(p, "acquisitionIdentity"),
  )) {
    const answer = await callPlugin(
      plugin,
      {
        path: "downloadSource.acquisitionIdentity",
        input: {
          ...pluginInput(plugin),
          track: {
            ...track,
            artist: track.artistName,
            trackMbid: track.trackMbid,
            releaseMbid: track.releaseMbid,
          },
        },
      },
      result,
      30_000,
    );
    if (answer) return answer;
  }
  return null;
}
