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

// Apple TV's full screen Now Playing stays blank for small covers, while its corner banner shows
// them. Aurral stores covers at up to 512px, mostly as WebP, so the system player gets a JPEG copy
// whose longest side is 1024px, enlarging smaller covers. Returns null to keep the original.
const AIRPLAY_ARTWORK_PX = 1024;

export function airPlayArtworkSize(width: number, height: number) {
  if (!(width > 0) || !(height > 0)) return null;
  const scale = AIRPLAY_ARTWORK_PX / Math.max(width, height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export async function airPlayArtwork(src: string | null | undefined, baseUrl: string) {
  if (!src || typeof document === "undefined" || typeof createImageBitmap !== "function") {
    return null;
  }
  try {
    const response = await fetch(new URL(src, baseUrl), { credentials: "same-origin" });
    if (!response.ok) return null;
    const image = await response.blob();
    if (!image.type.toLowerCase().startsWith("image/")) return null;
    const bitmap = await createImageBitmap(image);
    const size = airPlayArtworkSize(bitmap.width, bitmap.height);
    const context = size && document.createElement("canvas").getContext("2d");
    if (!size || !context) {
      bitmap.close();
      return null;
    }
    context.canvas.width = size.width;
    context.canvas.height = size.height;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    bitmap.close();
    return {
      src: context.canvas.toDataURL("image/jpeg", 0.9),
      sizes: `${size.width}x${size.height}`,
      type: "image/jpeg",
    };
  } catch {
    return null;
  }
}
