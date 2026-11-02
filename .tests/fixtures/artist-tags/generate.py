"""Builds the artist-tag fixture library used by .tests/subsonic/subsonic-artist-tags.test.ts.

The files are committed, so the tests need neither ffmpeg nor mutagen. Re-run this
(`python3 .tests/fixtures/artist-tags/generate.py`, needs ffmpeg and mutagen) only to
change the fixtures. Mutagen is the tag writer beets uses, so these are the shapes beets
and the classical-artists plugin leave on disk.
"""

import pathlib
import subprocess

from mutagen.flac import FLAC
from mutagen.id3 import ID3, TALB, TIT2, TPE1, TPE2, TRCK, TCMP, TXXX
from mutagen.mp4 import MP4, MP4FreeForm

ROOT = pathlib.Path(__file__).resolve().parent / "library"
CODECS = {
    ".flac": ["-c:a", "flac"],
    ".mp3": ["-c:a", "libmp3lame", "-b:a", "8k"],
    ".m4a": ["-c:a", "aac", "-b:a", "8k"],
}

CLASSICAL = "Gustav Mahler — Jessye Norman — London Symphony Orchestra — Colin Davis"
CLASSICAL_ARTISTS = ["Gustav Mahler", "Jessye Norman", "London Symphony Orchestra", "Colin Davis"]
GOULD = "Johann Sebastian Bach — Glenn Gould"


def silence(relative):
    target = ROOT / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono",
         "-t", "0.5", "-map_metadata", "-1", *CODECS[target.suffix], str(target)],
        check=True,
    )
    return target


def flac(relative, **tags):
    audio = FLAC(silence(relative))
    for key, value in tags.items():
        audio[key.upper()] = value if isinstance(value, list) else [value]
    audio.save()


def mp3(relative, version, frames):
    target = silence(relative)
    tag = ID3()
    for frame in frames:
        tag.add(frame)
    tag.save(target, v2_version=version, v23_sep="/")


def m4a(relative, freeform=None, **atoms):
    audio = MP4(silence(relative))
    for key, value in atoms.items():
        audio[key] = value
    for key, values in (freeform or {}).items():
        audio[f"----:com.apple.iTunes:{key}"] = [MP4FreeForm(v.encode()) for v in values]
    audio.save()


# 1. The classical-artists plugin: em-dash credits, plus the multi-valued ARTISTS beets writes.
flac(
    "Gustav Mahler/Symphony No. 4/01 Das himmlische Leben.flac",
    title="Das himmlische Leben", album="Symphony No. 4", tracknumber="1",
    artist=CLASSICAL, artists=CLASSICAL_ARTISTS,
    albumartist=CLASSICAL, albumartists=CLASSICAL_ARTISTS,
)
# 2. Two ARTIST Vorbis comments and no ARTISTS.
flac(
    "Duo/Split Single/01 Together.flac",
    title="Together", album="Split Single", tracknumber="1",
    artist=["Artist A", "Artist B"], albumartist="Duo",
)
# 3. ID3v2.4: a featured credit, and ARTISTS as a null-separated TXXX.
mp3(
    "Main Artist/Guest Spots/01 Feature.mp3", 4,
    [TIT2(encoding=3, text="Feature"), TALB(encoding=3, text="Guest Spots"),
     TRCK(encoding=3, text="1"), TPE1(encoding=3, text="Main Artist feat. Guest"),
     TPE2(encoding=3, text="Main Artist"),
     TXXX(encoding=3, desc="ARTISTS", text=["Main Artist", "Guest"])],
)
# 4. ID3v2.3: a slash inside a name, and an em-dash credit in the album artist.
mp3(
    "AC-DC/Bach Covers/01 Thunder.mp3", 3,
    [TIT2(encoding=1, text="Thunder"), TALB(encoding=1, text="Bach Covers"),
     TRCK(encoding=1, text="1"), TPE1(encoding=1, text="AC/DC"),
     TPE2(encoding=1, text=GOULD)],
)
# 5. M4A: em-dash credits and ARTISTS as several iTunes freeform values.
m4a(
    "Johann Sebastian Bach/Goldberg Variations/01 Aria.m4a",
    freeform={"ARTISTS": ["Johann Sebastian Bach", "Glenn Gould"]},
    **{"\xa9nam": ["Aria"], "\xa9alb": ["Goldberg Variations"], "trkn": [(1, 0)],
       "\xa9ART": [GOULD], "aART": [GOULD]},
)
# 6. A compilation credited to Various Artists.
for number, artist in ((1, "Band One"), (2, "Band Two")):
    flac(
        f"Various Artists/Hits/0{number} Hit {number}.flac",
        title=f"Hit {number}", album="Hits", tracknumber=str(number),
        artist=artist, albumartist="Various Artists", compilation="1",
    )
# 7. No ARTIST tag at all, only an album artist.
flac(
    "Fallback Band/Untagged/01 Nameless.flac",
    title="Nameless", album="Untagged", tracknumber="1", albumartist="Fallback Band",
)
