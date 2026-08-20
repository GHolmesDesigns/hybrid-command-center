# Probe fixtures

Three files, committed so a live probe never touches a customer asset. Each is the smallest thing
that is still a valid file of its type, and none of them carries anything: a flat colour, a flat
colour in a different hue, and one line of text saying what it is.

| File | Type | Bytes | What it is |
| --- | --- | --- | --- |
| `probe-image.png` | `image/png` | 136 | 64×64 solid `#336699` |
| `probe-cover.png` | `image/png` | 136 | 64×64 solid `#996633` — a second image, so a cover or thumbnail role is provably a *different* asset from the post's own media |
| `probe-document.pdf` | `application/pdf` | 622 | one US Letter page reading `Post Bridge probe fixture - no customer content` |

`scripts/probe-post-bridge/fixtures.ts` hashes each file when the probe starts and the evidence
records the hash rather than the bytes, so the result matrix says which asset was uploaded without
the transcript carrying it.

**Nobody has to take the contents on trust.** `scripts/probe-post-bridge/fixtures.test.ts` rebuilds
all three from their recipe — a truecolour PNG of one solid RGB triple, and a five-object PDF 1.4
with one Helvetica text run — and asserts the committed bytes are equal to what that recipe
produces. A file carrying anything the table above does not describe fails `npm test`.

**There is no committed video.** A valid `video/mp4` cannot be written by hand, and a video is the
one fixture whose bytes a reviewer could not read to satisfy themselves it is harmless. The probe's
video-dependent questions — YouTube `thumbnail` and Instagram `cover_image`, which both need a video
as the post's own media — therefore take `--video <path>`: a disposable, non-customer file the owner
supplies for the session, hashed the same way. Without it those claims stay **still unverified**
rather than being answered from a substitute, which is the rule the provider-UI post fixture already
follows.
