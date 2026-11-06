const IMAGE_TYPES: Partial<Record<string, string>> = {
  avif: "image/avif",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
};

export const MEDIA_SESSION_SEEK_SECONDS = 10;

export function mediaSessionArtwork(src: string | null | undefined, baseUrl: string) {
  if (!src) return [];
  let url;
  try {
    url = new URL(src, baseUrl);
  } catch {
    return [];
  }
  const path = url.pathname.toLowerCase();
  const extension = path.match(/\.([a-z0-9]+)$/)?.[1];
  const type = extension && Object.hasOwn(IMAGE_TYPES, extension) ? IMAGE_TYPES[extension] : null;
  const dimensions = path.match(/(\d{2,4})x(\d{2,4})/);
  const coverArtSize = path.match(/\/front-(\d{2,4})$/)?.[1];
  const sizes = dimensions
    ? `${dimensions[1]}x${dimensions[2]}`
    : coverArtSize
      ? `${coverArtSize}x${coverArtSize}`
      : null;
  return [{ src: url.href, ...(sizes ? { sizes } : {}), ...(type ? { type } : {}) }];
}

export function mediaSessionPosition(duration: number, position: number) {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const safePosition = Number.isFinite(position) ? position : 0;
  return {
    duration,
    position: Math.min(Math.max(safePosition, 0), duration),
    playbackRate: 1,
  };
}

// AirPlay receivers such as Apple TV show the Now Playing cover only as JPEG or PNG. Aurral serves
// most covers as WebP, so the system player gets a JPEG copy. Returns null to keep the original.
const AIRPLAY_IMAGE_TYPES = new Set(["image/jpeg", "image/png"]);
const AIRPLAY_ARTWORK_MAX_PX = 1024;

export function needsAirPlayArtwork(contentType: string | null | undefined) {
  const [type = ""] = String(contentType || "")
    .trim()
    .toLowerCase()
    .split(";");
  return type.startsWith("image/") && !AIRPLAY_IMAGE_TYPES.has(type.trim());
}

export async function airPlayArtwork(src: string | null | undefined, baseUrl: string) {
  if (!src || typeof document === "undefined" || typeof createImageBitmap !== "function") {
    return null;
  }
  try {
    const response = await fetch(new URL(src, baseUrl), { credentials: "same-origin" });
    if (!response.ok) return null;
    const image = await response.blob();
    if (!needsAirPlayArtwork(image.type)) return null;
    const bitmap = await createImageBitmap(image);
    const scale = Math.min(1, AIRPLAY_ARTWORK_MAX_PX / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return {
      src: canvas.toDataURL("image/jpeg", 0.9),
      sizes: `${canvas.width}x${canvas.height}`,
      type: "image/jpeg",
    };
  } catch {
    return null;
  }
}
