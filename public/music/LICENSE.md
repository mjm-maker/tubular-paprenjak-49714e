# GLASKO built-in music library

Every audio file in this folder was generated from scratch by
`scripts/generate-music.js` (`npm run music:build`). Each track is synthesised
from oscillators, envelopes and filters written in that script — there are no
samples, no loops, no recordings and no third-party material of any kind in the
signal chain, so no other party holds a claim on them.

## License

The eight MP3 files in this folder are released under
[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/) — the
rights holder has waived copyright and placed them in the public domain
worldwide. You may use, modify and redistribute them, commercially or not, with
no attribution required. They are safe to use in videos posted to TikTok,
Instagram, YouTube, Facebook and anywhere else.

## Provenance

| File | Title | Category |
| --- | --- | --- |
| `northern-light.mp3` | Northern Light | Cinematic |
| `long-shadow.mp3` | Long Shadow | Cinematic |
| `quiet-rooms.mp3` | Quiet Rooms | Calm |
| `small-victories.mp3` | Small Victories | Inspirational |
| `slow-tide.mp3` | Slow Tide | Cinematic |
| `steady-hand.mp3` | Steady Hand | Business |
| `clear-signal.mp3` | Clear Signal | Business |
| `warm-static.mp3` | Warm Static | Ambient |

All are 32 kHz mono MP3, encoded at 80 kbps, level-matched to a common RMS so
switching tracks in the picker does not jump in loudness, and written so the end
joins the beginning without a click — the app loops them whenever the voice
recording is longer than the track.

Every track except `steady-hand.mp3` is also run through `duckMids()` in the
generator, a broad, shallow dip between roughly 380 Hz and 3.4 kHz. That is the
band a speaking voice occupies, so the dip is what lets the bed keep its weight
and its air while staying out of the way of the words.

`library.json` is the catalogue the app reads. It is rewritten by the generator
script; edit the script rather than the JSON.

## Adding a third-party track

Only add music you can point to a license for. Drop the file in this folder, add
an entry to `library.json` with an accurate `artist` and `license` string (that
string is shown to the user in the app), and record where it came from here.
Do not add commercial or copyrighted songs — platforms mute or block videos over
them, which would break the one thing this app is for.

## Uploaded music

Tracks a user uploads through the panel never reach this folder or any server.
They are decoded in the browser, mixed into the export locally, and discarded
when the tab closes. Responsibility for the rights to an uploaded track rests
with the person uploading it, and the panel says so.
