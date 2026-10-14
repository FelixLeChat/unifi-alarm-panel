/**
 * Dev-only fake UniFi Protect API. Implements the two endpoints
 * lib/services/protect-client.ts actually calls (camera list + camera
 * snapshot), so you can point PROTECT_API_BASE_URL at this instead of a
 * real UDM Pro while developing. Snapshots are a generated placeholder PNG,
 * colored per camera id, so different cameras are visibly distinguishable.
 *
 * To use a real photo as the placeholder instead (e.g. an actual camera
 * snapshot you have lying around), set MOCK_PROTECT_SNAPSHOT_PATH to a local
 * file — deliberately not something this script ships or reads from the
 * repo by default, since a real snapshot is often a real, identifiable
 * person, and that's not something to bake into shared source history.
 * Keep it outside the repo, or gitignored if you drop it in-tree.
 *
 * Usage: pnpm protect:mock [port]
 * Then in .env: PROTECT_API_BASE_URL=http://localhost:8089
 *               PROTECT_API_KEY=anything   (only checked if MOCK_PROTECT_API_KEY is also set)
 *               MOCK_PROTECT_SNAPSHOT_PATH=/absolute/path/to/your/photo.jpg   (optional)
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { deflateSync } from "node:zlib";

const PORT = Number(process.argv[2] ?? process.env.MOCK_PROTECT_PORT ?? 8089);
const EXPECTED_KEY = process.env.MOCK_PROTECT_API_KEY;
const SNAPSHOT_PATH = process.env.MOCK_PROTECT_SNAPSHOT_PATH;

const CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

let customSnapshot: { buffer: Buffer; contentType: string } | null = null;
if (SNAPSHOT_PATH) {
  const contentType = CONTENT_TYPES[extname(SNAPSHOT_PATH).toLowerCase()];
  if (!contentType) {
    console.error(`MOCK_PROTECT_SNAPSHOT_PATH: unrecognized extension for ${SNAPSHOT_PATH} (expected .jpg/.png/.webp)`);
    process.exit(1);
  }
  customSnapshot = { buffer: readFileSync(SNAPSHOT_PATH), contentType };
}

function crc32(buf: Buffer): number {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([length, typeBuf, data, crc]);
}

function placeholderSnapshot(label: string): Buffer {
  const width = 320;
  const height = 180;

  let hash = 0;
  for (const ch of label) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const color: [number, number, number] = [hash & 0xff, (hash >> 8) & 0xff, (hash >> 16) & 0xff];

  const rowLength = 1 + width * 3;
  const raw = Buffer.alloc(rowLength * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowLength;
    raw[rowStart] = 0; // PNG filter type: none
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 3;
      raw[px] = color[0];
      raw[px + 1] = color[1];
      raw[px + 2] = color[2];
    }
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: truecolor (RGB)
  const ihdr = pngChunk("IHDR", ihdrData);
  const idat = pngChunk("IDAT", deflateSync(raw));
  const iend = pngChunk("IEND", Buffer.alloc(0));
  return Buffer.concat([signature, ihdr, idat, iend]);
}

const MOCK_CAMERAS = [
  { id: "mock-cam-entryway", name: "Entryway" },
  { id: "mock-cam-lobby", name: "Lobby" },
];

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (EXPECTED_KEY && req.headers["x-api-key"] !== EXPECTED_KEY) {
    console.log(`401 ${req.method} ${url.pathname}`);
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "bad X-API-KEY" }));
    return;
  }

  if (url.pathname === "/proxy/protect/integration/v1/cameras") {
    console.log(`200 ${req.method} ${url.pathname} (${MOCK_CAMERAS.length} cameras)`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(MOCK_CAMERAS));
    return;
  }

  const match = url.pathname.match(/^\/proxy\/protect\/integration\/v1\/cameras\/([^/]+)\/snapshot$/);
  if (!match) {
    console.log(`404 ${req.method} ${url.pathname}`);
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "mock only implements the camera list + snapshot endpoints" }));
    return;
  }

  const cameraId = decodeURIComponent(match[1]);
  const { buffer, contentType } = customSnapshot ?? {
    buffer: placeholderSnapshot(cameraId),
    contentType: "image/png",
  };
  console.log(`200 ${req.method} ${url.pathname} (camera "${cameraId}")${customSnapshot ? " [custom photo]" : ""}`);
  res.writeHead(200, { "content-type": contentType, "content-length": buffer.length });
  res.end(buffer);
});

server.listen(PORT, () => {
  console.log(`Fake UniFi Protect API listening on http://localhost:${PORT}`);
  console.log(`Set PROTECT_API_BASE_URL=http://localhost:${PORT} in .env to use it.`);
});
