/**
 * The fixtures, examined rather than trusted.
 *
 * These three files are the only bytes this repository will ever put on somebody's social account,
 * and a reviewer cannot read a PNG by eye. So the tests decode them: every chunk of each image is
 * parsed, its CRC checked, and every pixel inflated and compared against one flat colour, and the PDF
 * is asserted to be printable ASCII carrying exactly one line of text. A fixture that quietly grew a
 * payload, a second image, or a stray metadata chunk fails here.
 *
 * Decoding rather than re-encoding is deliberate: comparing against freshly deflated bytes would tie
 * the suite to one zlib version, and the question is what the file *is*, not which compressor wrote
 * it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  COMMITTED_FIXTURES,
  loadProbeFixtures,
  PROBE_COMMITTED_FIXTURE_MAX_BYTES,
  PROBE_VIDEO_MAX_BYTES,
  sha256Hex,
} from './fixtures.ts';

const DIRECTORY = join(import.meta.dirname, '..', 'fixtures');
const read = (name: string): Buffer => readFileSync(join(DIRECTORY, name));

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    let c = (crc ^ byte) & 0xff;
    for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface PngChunk {
  type: string;
  data: Buffer;
  crcOk: boolean;
}

function readPngChunks(file: Buffer): PngChunk[] {
  expect(file.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  const chunks: PngChunk[] = [];
  let at = 8;
  while (at < file.length) {
    const length = file.readUInt32BE(at);
    const type = file.subarray(at + 4, at + 8).toString('ascii');
    const data = file.subarray(at + 8, at + 8 + length);
    const declared = file.readUInt32BE(at + 8 + length);
    chunks.push({ type, data, crcOk: crc32(file.subarray(at + 4, at + 8 + length)) === declared });
    at += 12 + length;
  }
  return chunks;
}

describe.each([
  { file: 'probe-image.png', colour: [0x33, 0x66, 0x99] },
  { file: 'probe-cover.png', colour: [0x99, 0x66, 0x33] },
])('$file', ({ file, colour }) => {
  const bytes = read(file);
  const chunks = readPngChunks(bytes);

  it('is a truecolour 64×64 PNG and nothing else', () => {
    expect(chunks.map((chunk) => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(chunks.every((chunk) => chunk.crcOk)).toBe(true);
    const ihdr = chunks[0].data;
    expect(ihdr.readUInt32BE(0)).toBe(64);
    expect(ihdr.readUInt32BE(4)).toBe(64);
    expect(ihdr[8]).toBe(8);
    expect(ihdr[9]).toBe(2);
  });

  it('is one flat colour in every pixel, with no filtering to hide anything behind', () => {
    const raw = inflateSync(chunks[1].data);
    expect(raw).toHaveLength(64 * (1 + 64 * 3));
    for (let y = 0; y < 64; y += 1) {
      const row = raw.subarray(y * 193, (y + 1) * 193);
      expect(row[0]).toBe(0);
      for (let x = 0; x < 64; x += 1)
        expect([...row.subarray(1 + x * 3, 4 + x * 3)]).toEqual(colour);
    }
  });

  it('is well under the ceiling this probe will upload', () => {
    expect(bytes.byteLength).toBeLessThan(PROBE_COMMITTED_FIXTURE_MAX_BYTES);
  });
});

describe('probe-document.pdf', () => {
  const text = read('probe-document.pdf').toString('latin1');

  it('is printable ASCII, so it can be read in a diff', () => {
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    // eslint-disable-next-line no-control-regex
    expect(/[^\x0a\x20-\x7e]/.test(text)).toBe(false);
  });

  it('is one page carrying exactly one line of text, and says what it is', () => {
    expect(text).toContain('/Count 1');
    const shown = [...text.matchAll(/\((.*?)\) Tj/g)].map((match) => match[1]);
    expect(shown).toEqual(['Post Bridge probe fixture - no customer content']);
  });

  it('declares its content stream’s real length', () => {
    const declared = Number(/\/Length (\d+)/.exec(text)?.[1]);
    const stream = /stream\n([\s\S]*?)endstream/.exec(text)?.[1] ?? '';
    expect(stream).toHaveLength(declared);
  });
});

describe('loadProbeFixtures', () => {
  const bytesFor: Record<string, Uint8Array> = {
    'probe-image.png': read('probe-image.png'),
    'probe-cover.png': read('probe-cover.png'),
    'probe-document.pdf': read('probe-document.pdf'),
  };
  const reader = (path: string): Uint8Array => {
    const found = bytesFor[path];
    if (!found) throw new Error(`no such fixture: ${path}`);
    return found;
  };

  it('loads and hashes the three committed files', () => {
    const loaded = loadProbeFixtures({ readFile: reader });
    expect([...loaded.keys()]).toEqual(['image', 'cover', 'document']);
    expect(loaded.get('image')?.mimeType).toBe('image/png');
    expect(loaded.get('document')?.mimeType).toBe('application/pdf');
    expect(loaded.get('image')?.sha256).toBe(sha256Hex(bytesFor['probe-image.png']));
    expect(loaded.get('image')?.sizeBytes).toBe(bytesFor['probe-image.png'].byteLength);
  });

  it('gives the two images different hashes, so a role is provably a different asset', () => {
    const loaded = loadProbeFixtures({ readFile: reader });
    expect(loaded.get('image')?.sha256).not.toBe(loaded.get('cover')?.sha256);
  });

  it('names every committed fixture that the probe’s questions need', () => {
    expect(COMMITTED_FIXTURES.map((fixture) => fixture.key)).toEqual([
      'image',
      'cover',
      'document',
    ]);
  });

  it('refuses an empty or oversized committed fixture rather than uploading it', () => {
    expect(() => loadProbeFixtures({ readFile: () => new Uint8Array() })).toThrow(/is empty/);
    expect(() =>
      loadProbeFixtures({ readFile: () => new Uint8Array(PROBE_COMMITTED_FIXTURE_MAX_BYTES + 1) }),
    ).toThrow(/ceiling/);
  });

  it('propagates a missing fixture rather than continuing with two of three', () => {
    expect(() =>
      loadProbeFixtures({
        readFile: (path) => {
          if (path === 'probe-document.pdf') throw new Error('gone');
          return reader(path);
        },
      }),
    ).toThrow('gone');
  });

  describe('--video', () => {
    const withVideo = (videoPath: string, bytes = new Uint8Array(1024)) =>
      loadProbeFixtures({
        readFile: (path) => (path === videoPath ? bytes : reader(path)),
        videoPath,
      });

    it('takes its type from the extension and never the operator’s filename', () => {
      const loaded = withVideo('/home/owner/Client Launch Final v3.mp4');
      expect(loaded.get('video')?.mimeType).toBe('video/mp4');
      expect(loaded.get('video')?.name).toBe('probe-video.mp4');
      expect(loaded.get('video')?.name).not.toContain('Client');
    });

    it('accepts the two video types the provider documents', () => {
      expect(withVideo('/tmp/a.mov').get('video')?.mimeType).toBe('video/quicktime');
      expect(() => withVideo('/tmp/a.webm')).toThrow(/--video must be one of/);
    });

    it('refuses a video over the ceiling, so a real campaign asset cannot be passed by accident', () => {
      expect(() => withVideo('/tmp/a.mp4', new Uint8Array(PROBE_VIDEO_MAX_BYTES + 1))).toThrow(
        /ceiling/,
      );
    });

    it('is absent rather than substituted when no path was given', () => {
      expect(loadProbeFixtures({ readFile: reader }).has('video')).toBe(false);
    });
  });
});
