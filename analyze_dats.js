const fs = require("fs");
const path = require("path");

function hex(value, width = 0) {
  return "0x" + value.toString(16).toUpperCase().padStart(width, "0");
}

function readCString(buf, start, maxLength) {
  const end = Math.min(buf.length, start + maxLength);
  let i = start;
  while (i < end && buf[i] !== 0) i++;
  return buf.subarray(start, i).toString("ascii");
}

function lastNonZeroOffset(buf) {
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i] !== 0) return i;
  }
  return -1;
}

function findNonZeroRanges(buf, start, blockSize) {
  const ranges = [];
  let current = null;

  for (let off = start; off + blockSize <= buf.length; off += blockSize) {
    let nonZero = false;
    for (let i = off; i < off + blockSize; i++) {
      if (buf[i] !== 0) {
        nonZero = true;
        break;
      }
    }

    if (nonZero) {
      if (!current) current = { start: off, end: off + blockSize, blocks: 0 };
      current.end = off + blockSize;
      current.blocks += 1;
    } else if (current) {
      ranges.push(current);
      current = null;
    }
  }

  if (current) ranges.push(current);
  return ranges;
}

function printSection(title) {
  console.log(`\n${title}`);
}

function analyzeHotbar(filePath) {
  const buf = fs.readFileSync(filePath);
  const headerSize = 0x11;
  const footerSize = 0x0F;
  const fileType = buf.readUInt32LE(0);
  const maxSize = buf.readUInt32LE(4);
  const contentSize = buf.readUInt32LE(8);
  const headerEndByte = buf[0x10];
  const lastUsed = lastNonZeroOffset(buf);

  const content = Buffer.from(buf.subarray(headerSize, headerSize + contentSize));
  for (let i = 0; i < content.length - 1; i++) {
    content[i] ^= 0x31;
  }

  const records = [];
  for (let off = 0; off + 8 <= content.length; off += 8) {
    records.push({
      offset: off,
      value: content.readUInt32LE(off),
      a: content[off + 4],
      b: content[off + 5],
      c: content[off + 6],
      d: content[off + 7],
    });
  }

  const interesting = records
    .filter((r) => r.value !== 0 || r.c !== 0 || r.d !== 0)
    .slice(0, 16);

  printSection("HOTBAR.DAT");
  console.log(`path: ${filePath}`);
  console.log(`file type: ${hex(fileType, 8)} (matches FFXIV HOTBAR type id)`);
  console.log(`header: ${headerSize} bytes`);
  console.log(`footer padding: ${footerSize} bytes`);
  console.log(`max content size: ${maxSize} bytes`);
  console.log(`current content size: ${contentSize} bytes`);
  console.log(`header end byte: ${hex(headerEndByte, 2)} (standard HOTBAR value)`);
  console.log(`last non-zero file byte: ${hex(lastUsed, 0)}`);
  console.log(`content mask: 0x31 XOR`);
  console.log(`logical 8-byte units in content: ${records.length}`);
  console.log(
    `observed pattern: [u32 value] [u8 groupA] [u8 slot] [u8 type?] [u8 subtype?]`
  );
  console.log("first interesting units after unmasking:");
  for (const record of interesting) {
    console.log(
      `  ${hex(record.offset, 4)} value=${record.value} bytes=[${record.a}, ${record.b}, ${record.c}, ${record.d}]`
    );
  }
}

function inferStride(values) {
  if (values.length < 3) return null;
  const deltas = [];
  for (let i = 1; i < values.length; i++) {
    deltas.push(values[i] - values[i - 1]);
  }
  return deltas.every((delta) => delta === deltas[0]) ? deltas[0] : null;
}

function formatAddonBlock(buf, off) {
  const raw0 = buf.readUInt32LE(off);
  const packed = buf.readUInt32LE(off + 4);
  const meta = buf.readUInt32LE(off + 8);
  const idOrHash = buf.readUInt32LE(off + 16);
  const f1 = buf.readFloatLE(off + 20);
  const f2 = buf.readFloatLE(off + 24);
  const f3 = buf.readFloatLE(off + 28);

  const x = packed & 0xffff;
  const y = packed >>> 16;

  return `${hex(off, 4)} raw0=${hex(raw0, 8)} packedXY=(${x},${y}) meta=${hex(
    meta,
    8
  )} id/hash=${hex(idOrHash, 8)} floats=[${f1.toFixed(3)}, ${f2.toFixed(
    3
  )}, ${f3.toFixed(3)}]`;
}

function formatHexBlock(buf, off, length = 0x20) {
  return `${hex(off, 4)} ${buf
    .subarray(off, off + length)
    .toString("hex")
    .toUpperCase()}`;
}

function analyzeAddon(filePath) {
  const buf = fs.readFileSync(filePath);
  const signature = readCString(buf, 0x10, 4);
  const version = buf.readUInt32LE(0x14);
  const blockHint = buf.readUInt32LE(0x18);
  const profile = readCString(buf, 0x30, 16);
  const maxSizeA = buf.readUInt32LE(0x04);
  const maxSizeB = buf.readUInt32LE(0x08);
  const lastUsed = lastNonZeroOffset(buf);
  const ranges = findNonZeroRanges(buf, 0x20, 0x20);
  const tailStarts = ranges.slice(1).map((r) => r.start);
  const repeatedStride = inferStride(tailStarts);

  printSection("ADDON.DAT");
  console.log(`path: ${filePath}`);
  console.log(`signature: ${signature || "(none)"}`);
  console.log(`version: ${version}`);
  console.log(`record/header hint: ${blockHint} bytes`);
  console.log(`profile label: ${profile || "(none)"}`);
  console.log(`reserved payload sizes in header: ${maxSizeA} / ${maxSizeB} bytes`);
  console.log(`last non-zero file byte: ${hex(lastUsed, 0)}`);
  console.log("32-byte non-zero ranges:");
  for (const range of ranges) {
    console.log(
      `  ${hex(range.start, 4)}..${hex(range.end, 4)} blocks=${range.blocks}`
    );
  }
  if (repeatedStride) {
    console.log(
      `repeated section stride after the primary block: ${hex(repeatedStride, 0)}`
    );
    console.log("this strongly suggests four fixed-size HUD layout sections.");
  }
  console.log("sample primary-section blocks:");
  for (const off of [0x60, 0x80, 0xA0, 0xC0, 0xE0, 0x100]) {
    console.log(`  ${formatAddonBlock(buf, off)}`);
  }
  if (ranges.length > 1) {
    console.log("sample first layout-section raw blocks:");
    for (const off of [
      ranges[1].start,
      ranges[1].start + 0x20,
      ranges[1].start + 0x40,
      ranges[1].start + 0x60,
    ]) {
      console.log(`  ${formatHexBlock(buf, off)}`);
    }
  }
}

function main() {
  const baseDir = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
  analyzeAddon(path.join(baseDir, "ADDON.DAT"));
  analyzeHotbar(path.join(baseDir, "HOTBAR.DAT"));
}

main();
