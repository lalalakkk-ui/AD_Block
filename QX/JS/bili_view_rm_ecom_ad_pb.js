// bili_view_rm_ecom_ad_pb.js
// 仅处理 gRPC 未压缩消息（comp flag=0）。如果仍 gzip（comp flag=1），直接放行。

const blacklistStr = [
  // PDD
  "pinduoduo", "yangkeduo", "pddopen", "去拼多多",
  // TB/TM
  "taobao", "taobaolite", "uland.taobao", "tmall",
  // JD
  "jd.com", "openapp.jdmobile", "img-x.jd.com", "ccc-x.jd.com", "im-x.jd.com",
  // Dewu (粗略)
  "dew", "dewu"
];

function toBytes(str) {
  return new TextEncoder().encode(str);
}
const blacklist = blacklistStr.map(toBytes);

function indexOfSub(u8, sub) {
  // naive search, sufficient for this payload size
  outer: for (let i = 0; i + sub.length <= u8.length; i++) {
    for (let j = 0; j < sub.length; j++) {
      if (u8[i + j] !== sub[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function containsAny(u8) {
  for (const b of blacklist) {
    if (indexOfSub(u8, b) !== -1) return true;
  }
  return false;
}

function readVarint(u8, pos) {
  let val = 0;
  let shift = 0;
  while (pos < u8.length) {
    const b = u8[pos++];
    val |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [val, pos];
    shift += 7;
    if (shift > 63) break;
  }
  return [null, pos];
}

function writeVarint(val) {
  const out = [];
  while (true) {
    const b = val & 0x7f;
    val >>>= 7;
    if (val) out.push(b | 0x80);
    else { out.push(b); break; }
  }
  return new Uint8Array(out);
}

function parseMessage(u8) {
  // 返回 fields: [{tagStart,lenStart,wireType,valueStart,valueEnd,parseablePayload?}]
  let pos = 0;
  const fields = [];
  while (pos < u8.length) {
    const tagStart = pos;
    const [tag, p1] = readVarint(u8, pos);
    if (tag === null) return null;
    pos = p1;
    const wireType = tag & 0x07;

    if (wireType === 0) { // varint
      const [_, p2] = readVarint(u8, pos);
      if (_ === null) return null;
      fields.push({ tagStart, lenStart: pos, wireType, valueStart: pos, valueEnd: p2 });
      pos = p2;
    } else if (wireType === 1) { // 64-bit
      const end = pos + 8;
      if (end > u8.length) return null;
      fields.push({ tagStart, lenStart: pos, wireType, valueStart: pos, valueEnd: end });
      pos = end;
    } else if (wireType === 2) { // length-delimited
      const lenStart = pos;
      const [len, p2] = readVarint(u8, pos);
      if (len === null) return null;
      pos = p2;
      const valueStart = pos;
      const valueEnd = pos + len;
      if (valueEnd > u8.length) return null;
      fields.push({ tagStart, lenStart, wireType, valueStart, valueEnd });
      pos = valueEnd;
    } else if (wireType === 5) { // 32-bit
      const end = pos + 4;
      if (end > u8.length) return null;
      fields.push({ tagStart, lenStart: pos, wireType, valueStart: pos, valueEnd: end });
      pos = end;
    } else {
      return null;
    }
  }
  return fields;
}

function isParseableMessage(u8) {
  const f = parseMessage(u8);
  return !!(f && f.length > 0);
}

function filterMessage(u8, depth = 0, maxDepth = 10) {
  const fields = parseMessage(u8);
  if (!fields) return { bytes: u8, changed: false, parseable: false };

  let changed = false;
  const out = [];

  for (const it of fields) {
    const seg = u8.slice(it.tagStart, it.valueEnd);

    if (it.wireType !== 2) {
      out.push(seg);
      continue;
    }

    const tagBytes = u8.slice(it.tagStart, it.lenStart);
    const payload = u8.slice(it.valueStart, it.valueEnd);

    if (depth < maxDepth && isParseableMessage(payload)) {
      const child = filterMessage(payload, depth + 1, maxDepth);
      if (child.changed) {
        changed = true;
        out.push(tagBytes);
        out.push(writeVarint(child.bytes.length));
        out.push(child.bytes);
      } else {
        out.push(seg);
      }
    } else {
      // 叶子：命中电商关键字则删掉该字段（不改其它结构）
      if (containsAny(payload)) {
        changed = true;
        continue;
      }
      out.push(seg);
    }
  }

  // concat
  let total = 0;
  for (const b of out) total += b.length;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const b of out) { merged.set(b, offset); offset += b.length; }

  return { bytes: merged, changed, parseable: true };
}

function u32be(b0, b1, b2, b3) {
  return ((b0 << 24) >>> 0) + (b1 << 16) + (b2 << 8) + b3;
}

function writeU32be(n) {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

let body = $response.bodyBytes;
if (!body) $done({});

let u8 = new Uint8Array(body);
let pos = 0;
const outFrames = [];
let changedAny = false;

while (pos + 5 <= u8.length) {
  const comp = u8[pos];
  const len = u32be(u8[pos + 1], u8[pos + 2], u8[pos + 3], u8[pos + 4]);
  pos += 5;
  if (pos + len > u8.length) break;

  const msg = u8.slice(pos, pos + len);
  pos += len;

  // comp=1 说明还是 gzip：本脚本不处理，直接透传
  if (comp !== 0) {
    outFrames.push(new Uint8Array([comp]));
    outFrames.push(writeU32be(len));
    outFrames.push(msg);
    continue;
  }

  const filtered = filterMessage(msg);
  if (filtered.changed) {
    changedAny = true;
    outFrames.push(new Uint8Array([0]));
    outFrames.push(writeU32be(filtered.bytes.length));
    outFrames.push(filtered.bytes);
  } else {
    outFrames.push(new Uint8Array([0]));
    outFrames.push(writeU32be(len));
    outFrames.push(msg);
  }
}

// concat frames
let total = 0;
for (const b of outFrames) total += b.length;
const merged = new Uint8Array(total);
let off = 0;
for (const b of outFrames) { merged.set(b, off); off += b.length; }

$done({ bodyBytes: merged.buffer });
