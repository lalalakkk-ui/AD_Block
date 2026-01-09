// tieba_rm_hotpush.js
// Remove "精选热推" block from Tieba excellent feed protobuf.
// Verified from your capture: keyword appears inside main payload field=9 (len-delimited).
// We remove ONLY those field=9 blocks whose bytes contain the UTF-8 keyword, keeping other fields intact.

const KW = new TextEncoder().encode("精选热推"); // Uint8Array

function bytesIndexOf(hay, needle) {
  if (!hay || !needle || needle.length === 0) return -1;
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

function writeVarint(v) {
  const out = [];
  let val = v >>> 0; // protobuf 里大多用不到 >2^32 的长度/字段号
  while (val >= 0x80) {
    out.push((val & 0x7f) | 0x80);
    val >>>= 7;
  }
  out.push(val);
  return out;
}

function parseMessage(buf) {
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
      if (i + 8 > buf.length) throw new Error("EOF 64bit");
      fields.push({ field, wt, value: buf.slice(i, i + 8) });
      i += 8;
    } else if (wt === 2) {
      const [len, ni2] = readVarint(buf, i);
      i = ni2;
      const end = i + len;
      if (end > buf.length) throw new Error("EOF len");
      fields.push({ field, wt, value: buf.slice(i, end) });
      i = end;
    } else if (wt === 5) {
      if (i + 4 > buf.length) throw new Error("EOF 32bit");
      fields.push({ field, wt, value: buf.slice(i, i + 4) });
      i += 4;
    } else {
      // group types (3/4) not expected
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
  } else if (f.wt === 1 || f.wt === 5) {
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

try {
  if (!$response.bodyBytes) {
    $done({});
    return;
  }

  const body = new Uint8Array($response.bodyBytes);

  // top-level protobuf: usually field1(status) + field2(payload)
  const top = parseMessage(body);

  // find main payload field=2 (len-delimited)
  const pIdx = top.findIndex(x => x.field === 2 && x.wt === 2);
  if (pIdx === -1) {
    $done({});
    return;
  }

  const payload = top[pIdx].value;
  const pf = parseMessage(payload);

  // remove ONLY field=9 blocks that contain the keyword bytes
  const filtered = pf.filter(x => {
    if (x.field === 9 && x.wt === 2) {
      return bytesIndexOf(x.value, KW) === -1;
    }
    return true;
  });

  if (filtered.length === pf.length) {
    // nothing to remove
    $done({});
    return;
  }

  const newPayload = encodeMessage(filtered);
  top[pIdx].value = newPayload;

  const newBody = encodeMessage(top);
  $done({ bodyBytes: newBody });
} catch (e) {
  // fail-safe: do not break feed
  $done({});
}
