const fs = require("fs");
const path = require("path");

const SECTIONS = [
  { name: "layout1", start: 0x4820, end: 0x52a0 },
  { name: "layout2", start: 0x5660, end: 0x62e0 },
  { name: "layout3", start: 0x64a0, end: 0x6fe0 },
  { name: "layout4", start: 0x72e0, end: 0x7d60 },
];

function parseArgs(argv) {
  const out = {
    baseDir: process.cwd(),
    input: null,
    width: 2560,
    height: 1080,
    layout: 2,
    format: "markdown",
    sort: "position",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];

    if (key === "--input") {
      out.input = value;
      i += 1;
    } else if (key === "--width") {
      out.width = Number(value);
      i += 1;
    } else if (key === "--height") {
      out.height = Number(value);
      i += 1;
    } else if (key === "--layout") {
      out.layout = Number(value);
      i += 1;
    } else if (key === "--format") {
      out.format = value;
      i += 1;
    } else if (key === "--sort") {
      out.sort = value;
      i += 1;
    } else if (key === "--base-dir") {
      out.baseDir = path.resolve(value);
      i += 1;
    }
  }

  return out;
}

function hex(value, width = 8) {
  return `0x${value.toString(16).toUpperCase().padStart(width, "0")}`;
}

function roundHalf(value) {
  return Math.round(value * 2) / 2;
}

function formatCoord(value) {
  const rounded = roundHalf(value);
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function formatFloat(value) {
  return Number(value.toFixed(6)).toString();
}

function deriveRows(buf, section, width, height) {
  const rows = [];

  for (let off = section.start; off < section.end; off += 0x20) {
    const id = buf.readUInt32LE(off);
    if (id === 0) continue;

    const storedX = buf.readFloatLE(off + 0x04);
    const storedY = buf.readFloatLE(off + 0x08);
    const scale = buf.readFloatLE(off + 0x0c);
    const zero = buf.readUInt32LE(off + 0x10);
    const packedBase = buf.readUInt32LE(off + 0x14);
    const flags = buf.readUInt32LE(off + 0x18);
    const tail = buf.readUInt32LE(off + 0x1c);

    const baseX = (packedBase & 0xffff) / 2;
    const baseY = ((packedBase >>> 16) & 0xffff) / 2;
    const x = baseX + storedX * (width / 100);
    const y = baseY + storedY * (height / 100);

    rows.push({
      offset: hex(off, 4),
      id: hex(id, 8),
      name: "",
      position: `<${formatCoord(x)}, ${formatCoord(y)}>`,
      x_display: formatCoord(x),
      y_display: formatCoord(y),
      x_raw: formatFloat(x),
      y_raw: formatFloat(y),
      stored_x: formatFloat(storedX),
      stored_y: formatFloat(storedY),
      base_x: formatFloat(baseX),
      base_y: formatFloat(baseY),
      scale: formatFloat(scale),
      zero: hex(zero, 8),
      packed_base: hex(packedBase, 8),
      flags: hex(flags, 8),
      tail: hex(tail, 8),
    });
  }

  return rows;
}

function sortRows(rows, sortMode) {
  const copy = rows.slice();

  if (sortMode === "offset") {
    copy.sort((a, b) => Number.parseInt(a.offset, 16) - Number.parseInt(b.offset, 16));
    return copy;
  }

  copy.sort((a, b) => {
    const ay = Number(a.y_raw);
    const by = Number(b.y_raw);
    if (ay !== by) return ay - by;

    const ax = Number(a.x_raw);
    const bx = Number(b.x_raw);
    if (ax !== bx) return ax - bx;

    return Number.parseInt(a.offset, 16) - Number.parseInt(b.offset, 16);
  });

  return copy;
}

function csvEscape(value) {
  const text = String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(rows) {
  const headers = [
    "offset",
    "id",
    "name",
    "position",
    "x_display",
    "y_display",
    "x_raw",
    "y_raw",
    "stored_x",
    "stored_y",
    "base_x",
    "base_y",
    "scale",
    "zero",
    "packed_base",
    "flags",
    "tail",
  ];

  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((key) => csvEscape(row[key])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function toMarkdown(rows, width, height, section) {
  const lines = [];
  lines.push(`# Active Layout Component Table (${width}x${height})`);
  lines.push("");
  lines.push("## Scope");
  lines.push("");
  lines.push(`- Source file: \`ADDON.DAT\``);
  lines.push(`- Section: \`${section.name}\` (\`${hex(section.start, 4)}..${hex(section.end - 1, 4)}\`)`);
  lines.push("- Sorted by derived Y, then derived X.");
  lines.push("- `name` is intentionally blank for manual labeling.");
  lines.push("- Position uses the current export model:");
  lines.push("  - `x = base_x + stored_x * (screen_width / 100)`");
  lines.push("  - `y = base_y + stored_y * (screen_height / 100)`");
  lines.push("- `base_x` and `base_y` are derived from packed field `+0x14` as `low16/2` and `high16/2`.");
  lines.push("- Confidence is high for component `0x21E53CCE` and medium for the rest of the table until more components are manually confirmed.");
  lines.push("");
  lines.push("## Columns");
  lines.push("");
  lines.push("- `position`: rounded to the nearest 0.5 for readability.");
  lines.push("- `x_raw` / `y_raw`: unrounded derived coordinates.");
  lines.push("- `stored_x` / `stored_y`: raw repeated-section floats.");
  lines.push("- `base_x` / `base_y`: decoded packed origin values.");
  lines.push("");
  lines.push("| offset | id | name | position | x_display | y_display | x_raw | y_raw | stored_x | stored_y | base_x | base_y | scale | flags |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");

  for (const row of rows) {
    lines.push(
      `| ${row.offset} | ${row.id} |  | ${row.position} | ${row.x_display} | ${row.y_display} | ${row.x_raw} | ${row.y_raw} | ${row.stored_x} | ${row.stored_y} | ${row.base_x} | ${row.base_y} | ${row.scale} | ${row.flags} |`
    );
  }

  lines.push("");
  return lines.join("\n");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = args.input
    ? path.resolve(args.input)
    : path.join(args.baseDir, "ADDON.DAT");
  const section = SECTIONS[args.layout - 1];

  if (!section) {
    throw new Error(`Unknown layout index: ${args.layout}`);
  }

  const buf = fs.readFileSync(inputPath);
  const rows = sortRows(deriveRows(buf, section, args.width, args.height), args.sort);

  if (args.format === "csv") {
    process.stdout.write(toCsv(rows));
    return;
  }

  if (args.format === "json") {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }

  process.stdout.write(toMarkdown(rows, args.width, args.height, section));
}

main();
