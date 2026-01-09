/**
 * Tieba: remove "精选热推" card from protobuf feed response.
 * Strategy:
 * - Parse top-level protobuf message (wire types 0/1/2/5)
 * - Take field #2 (len-delimited) as inner message
 * - Remove any inner field #9 (len-delimited) that contains UTF-8 "精选热推"
 * - Re-encode protobuf messages and return bodyBytes
 *
 * Fail-safe: if parse fails, return original response untouched.
 */

const KW = utf8Bytes("精选热推");

function utf8Bytes(s) {
  // QX has TextEncoder in most builds; fallback if absent
  if (typeof TextEncoder !== "undefined") return Array.from(new TextEncoder().encode(s));
  // minimal utf8 encode for BMP
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return out;
}

function indexOfBytes(hay, needle) {
  // hay: Uint8Array, needle: Array<number>
  if (!needle || needle.length === 0) return -1;
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function readVarint(buf, i) {
  let shift = 0;
  let val = 0;
  while (i < buf.length) {
    const b = buf[i++];
    val |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [val, i];
    shift += 7;
    if (shift > 70) throw new Error("varint too long");
  }
  throw new Error("EOF varint");
}

function writeVarint(val) {
  const out = [];
  let v = val >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

function parseMessage(buf) {
  // returns [{field, wt, value(Uint8Array|number)}]
  let i = 0;
  const fields = [];
  while (i < buf.length) {
    const [key, ni] = readVarint(buf, i);
    i = ni;
    const field = key >>> 3;
    const wt = key & 0x07;

    if (wt === 0) {
      const [v, ni2] = readVarint(buf, i);
      i = ni2;
      fields.push({ field, wt, value: v });
    } else if (wt === 1) {
      if (i + 8 > buf.length) throw new Error("EOF 64-bit");
      fields.push({ field, wt, value: buf.slice(i, i + 8) });
      i += 8;
    } else if (wt === 2) {
      const [len, ni2] = readVarint(buf, i);
      i = ni2;
      const end = i + len;
      if (end > buf.length) throw new Error("EOF len-delim");
      fields.push({ field, wt, value: buf.slice(i, end) });
      i = end;
    } else if (wt === 5) {
      if (i + 4 > buf.length) throw new Error("EOF 32-bit");
      fields.push({ field, wt, value: buf.slice(i, i + 4) });
      i += 4;
    } else {
      // unsupported wiretype
      break;
    }
  }
  return fields;
}

function encodeField(f) {
  const key = (f.field << 3) | f.wt;
  const out = [];
  out.push(...writeVarint(key));
  if (f.wt === 0) {
    out.push(...writeVarint(f.value));
  } else if (f.wt === === 1 || f.wt === 5) {
    out.push(...Array.from(f.value));
  } else if (f.wt === 2) {
    out.push(...writeVarint(f.value.length));
    out.push(...Array.from(f.value));
  }
  return out;
}

function encodeMessage(fields) {
  const out = [];
  for (const f of fields) out.push(...encodeField(f));
  return new Uint8Array(out);
}

function dechunkIfNeeded(bodyBytes) {
  // If response_body includes chunked framing like "e5e\r\n<gzip...>\r\n0\r\n\r\n"
  // This is common in exported files; in live QX script usually already dechunked.
  // We'll detect by checking if it starts with hex digits and \r\n.
  const b = bodyBytes;
  if (b.length < 5) return b;

  // quick heuristic: first line is hex + \r\n
  let p = 0;
  while (p < b.length && b[p] !== 0x0d) p++;
  if (p === 0 || p + 1 >= b.length || b[p] !== 0x0d || b[p + 1] !== 0x0a) return b;

  // check line chars are hex
  for (let i = 0; i < p; i++) {
    const c = b[i];
    const isHex = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
    if (!isHex) return b;
  }

  // parse chunks
  let i = 0;
  const out = [];
  while (i < b.length) {
    let j = i;
    while (j < b.length && !(b[j] === 0x0d && b[j + 1] === 0x0a)) j++;
    if (j + 1 >= b.length) break;
    const line = bytesToAscii(b.slice(i, j));
    const size = parseInt(line.split(";")[0], 16);
    i = j + 2;
    if (!size) break;
    if (i + size > b.length) break;
    out.push(...Array.from(b.slice(i, i + size)));
    i += size + 2; // skip \r\n
  }
  return new Uint8Array(out);
}

function bytesToAscii(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return s;
}

try {
  let body = $response.bodyBytes;
  if (!body) {
    // fallback if only string provided
    const str = $response.body || "";
    body = new Uint8Array(utf8Bytes(str));
  } else {
    body = new Uint8Array(body);
  }

  body = dechunkIfNeeded(body);

  // top-level protobuf
  const top = parseMessage(body);

  // locate field #2 (len-delimited)
  const idx2 = top.findIndex(x => x.field === 2 && x.wt === 2);
  if (idx2 === -1) throw new Error("no top field2");

  const innerBuf = top[idx2].value;
  const inner = parseMessage(innerBuf);

  // remove hot-push blocks: inner field #9 that contains "精选热推"
  const filtered = inner.filter(f => {
    if (f.field === 9 && f.wt === 2) {
      return indexOfBytes(f.value, KW) === -1;
    }
    return true;
  });

  // if nothing changed, pass through
  if (filtered.length === inner.length) {
    $done({});
  } else {
    const newInner = encodeMessage(filtered);
    top[idx2].value = newInner;
    const newBody = encodeMessage(top);
    $done({ bodyBytes: newBody });
  }
} catch (e) {
  // fail-safe: do not break feed
  $done({});
}