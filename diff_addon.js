const fs = require("fs");
const path = require("path");

function hex(value, width = 0) {
  return "0x" + value.toString(16).toUpperCase().padStart(width, "0");
}

function diffRanges(a, b) {
  const ranges = [];
  let start = -1;

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const same = a[i] === b[i];
    if (!same && start === -1) start = i;
    if (same && start !== -1) {
      ranges.push([start, i]);
      start = -1;
    }
  }

  if (start !== -1) ranges.push([start, Math.max(a.length, b.length)]);
  return ranges;
}

function diffPositions(a, b) {
  const out = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) out.push(i);
  }
  return out;
}

function diffByteCount(a, b) {
  let count = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) count += 1;
  }
  return count;
}

function getSections() {
  return [
    ["primary", 0x20, 0x4800],
    ["layout1?", 0x4820, 0x52a0],
    ["layout2?", 0x5660, 0x62e0],
    ["layout3?", 0x64a0, 0x6fe0],
    ["layout4?", 0x72e0, 0x7d60],
  ];
}

function getSectionName(offset) {
  for (const [name, start, end] of getSections()) {
    if (offset >= start && offset < end) return name;
  }
  return "outside";
}

function blockSummary(buf, offset) {
  const u32 = [];
  for (let i = 0; i < 0x20; i += 4) {
    u32.push(hex(buf.readUInt32LE(offset + i), 8));
  }
  return u32.join(" ");
}

function collectChangedBlocks(current, previous, blockSize = 0x20) {
  const blocks = [];
  for (let off = 0; off + blockSize <= current.length; off += blockSize) {
    let same = true;
    for (let i = 0; i < blockSize; i++) {
      if (current[off + i] !== previous[off + i]) {
        same = false;
        break;
      }
    }
    if (!same) blocks.push(off);
  }
  return blocks;
}

function groupContiguousBlocks(blockOffsets, blockSize = 0x20) {
  const ranges = [];
  let start = null;
  let prev = null;

  for (const off of blockOffsets) {
    if (start === null) {
      start = off;
      prev = off;
      continue;
    }
    if (off === prev + blockSize) {
      prev = off;
      continue;
    }
    ranges.push([start, prev + blockSize]);
    start = off;
    prev = off;
  }

  if (start !== null) ranges.push([start, prev + blockSize]);
  return ranges;
}

function pairModifiedBlocks(current, previous, start, end, blockSize = 0x20) {
  const previousBlocks = [];
  const currentBlocks = [];

  for (let off = start; off < end; off += blockSize) {
    previousBlocks.push(previous.subarray(off, off + blockSize));
    currentBlocks.push(current.subarray(off, off + blockSize));
  }

  const toHex = (buf) => buf.toString("hex");
  const prevSet = new Set(previousBlocks.map(toHex));
  const curSet = new Set(currentBlocks.map(toHex));

  const removed = previousBlocks
    .map((buf, index) => ({ buf, index }))
    .filter((entry) => !curSet.has(toHex(entry.buf)));
  const added = currentBlocks
    .map((buf, index) => ({ buf, index }))
    .filter((entry) => !prevSet.has(toHex(entry.buf)));

  const usedCurrent = new Set();
  const pairs = [];

  for (const oldEntry of removed) {
    let best = null;
    for (const newEntry of added) {
      if (usedCurrent.has(newEntry.index)) continue;
      const diff = diffByteCount(oldEntry.buf, newEntry.buf);
      if (!best || diff < best.diff) {
        best = { diff, newEntry };
      }
    }
    if (!best) continue;
    usedCurrent.add(best.newEntry.index);
    pairs.push({
      oldIndex: oldEntry.index,
      newIndex: best.newEntry.index,
      diff: best.diff,
      positions: diffPositions(oldEntry.buf, best.newEntry.buf),
      oldBuf: oldEntry.buf,
      newBuf: best.newEntry.buf,
    });
  }

  return pairs.sort((a, b) => a.diff - b.diff);
}

function main() {
  const baseDir = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
  const currentPath = process.argv[3]
    ? path.resolve(process.argv[3])
    : path.join(baseDir, "ADDON.DAT");
  const previousPath = process.argv[4]
    ? path.resolve(process.argv[4])
    : path.join(baseDir, "ADDON.DAT.old");

  const current = fs.readFileSync(currentPath);
  const previous = fs.readFileSync(previousPath);

  const ranges = diffRanges(current, previous);
  const changedBlocks = collectChangedBlocks(current, previous);
  const blockRanges = groupContiguousBlocks(changedBlocks);
  const changedBytes = ranges.reduce((sum, [start, end]) => sum + (end - start), 0);

  console.log("ADDON.DAT diff summary");
  console.log(`current:  ${currentPath}`);
  console.log(`previous: ${previousPath}`);
  console.log(`same length: ${current.length === previous.length}`);
  console.log(`changed bytes: ${changedBytes}`);
  console.log(`changed byte ranges: ${ranges.length}`);
  console.log(`changed 32-byte blocks: ${changedBlocks.length}`);
  console.log("");

  console.log("Contiguous changed block ranges");
  for (const [start, end] of blockRanges) {
    console.log(
      `  ${hex(start, 4)}..${hex(end - 1, 4)} blocks=${(end - start) / 0x20} section=${getSectionName(start)}`
    );
  }
  console.log("");

  const perSection = new Map();
  for (const off of changedBlocks) {
    const name = getSectionName(off);
    perSection.set(name, (perSection.get(name) || 0) + 1);
  }
  console.log("Changed blocks by section");
  for (const [name, count] of perSection.entries()) {
    console.log(`  ${name}: ${count}`);
  }
  console.log("");

  if (blockRanges.length === 1) {
    const [start, end] = blockRanges[0];
    const pairs = pairModifiedBlocks(current, previous, start, end);
    const sameTail16 = pairs.filter((pair) => {
      for (let i = 16; i < 32; i++) {
        if (pair.oldBuf[i] !== pair.newBuf[i]) return false;
      }
      return true;
    }).length;

    console.log("Similarity pairing inside the changed range");
    console.log(`  inferred modified pairs: ${pairs.length}`);
    console.log(`  pairs with identical trailing 16 bytes: ${sameTail16}`);
    console.log("");

    console.log("Closest modified record pairs");
    for (const pair of pairs.slice(0, 20)) {
      const oldOffset = start + pair.oldIndex * 0x20;
      const newOffset = start + pair.newIndex * 0x20;
      console.log(
        `  old ${hex(oldOffset, 4)} -> new ${hex(newOffset, 4)} diff=${pair.diff} positions=[${pair.positions.join(", ")}]`
      );
      console.log(`    old ${blockSummary(previous, oldOffset)}`);
      console.log(`    new ${blockSummary(current, newOffset)}`);
    }
  }
}

main();
