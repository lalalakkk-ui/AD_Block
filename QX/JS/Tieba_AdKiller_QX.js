/**
 * Tieba_AdKiller_QX.js
 * 目标：基于你抓包出现的接口，对 protobuf 返回做“通用剥离”，删除直播 / 游戏预约 / 年终游戏大赏 / 下载推广等卡片对应的 sub-message
 * 适配：Quantumult X script-response-body
 */

const url = $request.url || "";
const status = ($response.status ?? $response.statusCode) || 0;
const isQuanX = typeof $task !== "undefined";

if (status !== 200) $done({});

// -------------------------- 0) 工具函数 --------------------------

function log(s) {
  try { console.log(s); } catch (_) {}
}

function toU8FromQXResponse() {
  // QX 在 script-response-body 下：protobuf 通常用 bodyBytes；HTML 通常 body 就是 string
  if (isQuanX && $response.bodyBytes) return new Uint8Array($response.bodyBytes);
  if (typeof $response.body === "string") {
    // 兜底：把字符串编码成 u8（不一定用得上）
    try { return new TextEncoder().encode($response.body); } catch (_) {}
  }
  return new Uint8Array(0);
}

function u8ToStringLossy(u8) {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(u8);
  } catch (_) {
    try { return String.fromCharCode.apply(null, Array.from(u8)); } catch (e) {}
  }
  return "";
}

function writeBackBytes(u8) {
  if (!isQuanX) return $done({ body: u8 }); // 非 QX 环境兜底
  return $done({ bodyBytes: u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) });
}

// varint read/write
function readVarint(u8, pos) {
  let val = 0;
  let shift = 0;
  let start = pos;
  while (pos < u8.length) {
    const b = u8[pos++];
    val |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) break; // 防爆
  }
  return { val, pos, raw: u8.slice(start, pos) };
}
function writeVarint(num) {
  const out = [];
  let n = num >>> 0;
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return new Uint8Array(out);
}

// 判断 payload 里是否包含关键词（用 utf8 lossy 扫）
function payloadHitKeywords(payloadU8, keywords) {
  if (!keywords || !keywords.length) return false;
  const s = u8ToStringLossy(payloadU8);
  if (!s) return false;
  for (const k of keywords) {
    if (k && s.indexOf(k) >= 0) return true;
  }
  return false;
}

/**
 * 通用 protobuf message 剥离器：
 * - 不需要 schema
 * - 会递归处理 LengthDelimited 的 payload
 * - 如果某个 LengthDelimited payload 命中关键词，则“整段 field（tag+len+payload）删除”
 */
function stripProtobufByKeywords(u8, keywords, depth = 0) {
  if (!u8 || u8.length < 2) return u8;
  if (depth > 8) return u8; // 防止异常递归

  let pos = 0;
  const chunks = [];

  while (pos < u8.length) {
    const fieldStart = pos;
    const tagInfo = readVarint(u8, pos);
    const tag = tagInfo.val;
    pos = tagInfo.pos;

    const wire = tag & 0x07;

    // 非法 tag 兜底：直接原样返回，避免破包
    if (tag === 0) return u8;

    if (wire === 0) {
      // Varint
      const v = readVarint(u8, pos);
      pos = v.pos;
      chunks.push(u8.slice(fieldStart, pos));
      continue;
    }

    if (wire === 1) {
      // 64-bit
      pos += 8;
      if (pos > u8.length) return u8;
      chunks.push(u8.slice(fieldStart, pos));
      continue;
    }

    if (wire === 5) {
      // 32-bit
      pos += 4;
      if (pos > u8.length) return u8;
      chunks.push(u8.slice(fieldStart, pos));
      continue;
    }

    if (wire === 2) {
      // LengthDelimited: len + payload
      const lenInfo = readVarint(u8, pos);
      const len = lenInfo.val;
      pos = lenInfo.pos;

      const payloadStart = pos;
      const payloadEnd = pos + len;
      if (payloadEnd > u8.length) return u8;

      const payload = u8.slice(payloadStart, payloadEnd);

      // 命中关键词：直接删掉整个 field
      if (payloadHitKeywords(payload, keywords)) {
        pos = payloadEnd;
        continue;
      }

      // 递归剥离子 message（就算不是 message，递归也会尽量不破坏）
      const newPayload = stripProtobufByKeywords(payload, keywords, depth + 1);

      // payload 未变化：原样保留
      if (newPayload.length === payload.length) {
        chunks.push(u8.slice(fieldStart, payloadEnd));
      } else {
        // rebuild: tag + newLen + newPayload
        const newLenU8 = writeVarint(newPayload.length);
        const rebuilt = concatU8([tagInfo.raw, newLenU8, newPayload]);
        chunks.push(rebuilt);
      }

      pos = payloadEnd;
      continue;
    }

    // 其它 wire type（3/4 group）很少见：原样返回避免破坏
    return u8;
  }

  return concatU8(chunks);
}

function concatU8(arrs) {
  let total = 0;
  for (const a of arrs) total += (a ? a.length : 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    if (!a || !a.length) continue;
    out.set(a, off);
    off += a.length;
  }
  return out;
}

// HTML：直接字符串删（不靠注入脚本）
function stripHtmlPromos(html) {
  if (!html || typeof html !== "string") return html;

  // 1) 去“精选热推/立即下载”常见块（粗暴但稳定）
  //    由于贴吧 Hybrid 页结构经常变，这里用“包含关键词的整块”思路：先移除明显的文案片段周围的大容器。
  //    容器正则会比较激进，但只在 informativeTab / mainPage/hybrid 触发。
  const patterns = [
    /<[^>]+>[^<]*(精选热推|精选热推榜|立即下载|立刻下载|下载APP|打开APP)[^<]*<\/[^>]+>/g,
    /(精选热推|立即下载|下载APP|打开APP)/g,
  ];

  let out = html;

  // 先把包含关键字的行附近做删除（退化方案）
  for (const p of patterns) {
    out = out.replace(p, "");
  }

  // 2) 进一步：删掉常见 banner/推广词（年终游戏大赏/游戏大赏）
  out = out.replace(/(贴吧年终游戏大赏|年终游戏大赏|游戏大赏)/g, "");

  return out;
}

// -------------------------- 1) 关键词集合（针对你 3 张截图 + 下载推广） --------------------------

// 直播卡：你抓包 loop 响应里明确出现：com.baidu.tieba://unidispatch/BDPLiveChannel
const KW_LIVE = [
  "BDPLiveChannel",
  "LiveChannel",
  "AlaLive",
  "ala_live",
];

// 游戏推广卡：截图里“官方预约/终极测试招募/游戏”
const KW_GAME = [
  "官方预约",
  "预约",
  "终极测试",
  "测试招募",
  "招募",
  "RUST",
  "rust",
  "失控进化",
];

// 贴吧年终游戏大赏 banner：截图 3
const KW_AWARDS = [
  "贴吧年终游戏大赏",
  "年终游戏大赏",
  "游戏大赏",
  "年终游戏",
];

// 下载/拉新推广：你之前第一项需求
const KW_DOWNLOAD = [
  "立即下载",
  "立刻下载",
  "下载",
  "下载APP",
  "打开APP",
  "usergrow",
];

// 按接口选择关键词（避免误伤正常内容）
function keywordsForUrl(u) {
  if (u.includes("/c/s/loop?cmd=309732")) return [].concat(KW_LIVE, KW_GAME, KW_AWARDS);
  if (u.includes("/c/f/excellent/personalized")) return [].concat(KW_LIVE, KW_GAME, KW_AWARDS);
  if (u.includes("/c/f/ad/getFeedAd")) return [].concat(KW_LIVE, KW_GAME, KW_AWARDS);
  return [].concat(KW_DOWNLOAD, KW_AWARDS, KW_GAME, KW_LIVE);
}

// -------------------------- 2) 主逻辑 --------------------------

try {
  // A) H5 / Hybrid：用“直接字符串删”而不是注入
  if (
    url.includes("/mo/q/hybrid-usergrow-base/informativeTab") ||
    url.includes("/mo/q/hybrid-main-forumtab/mainPage/hybrid")
  ) {
    const html = (typeof $response.body === "string") ? $response.body : u8ToStringLossy(toU8FromQXResponse());
    const newHtml = stripHtmlPromos(html);
    return $done({ body: newHtml });
  }

  // B) protobuf：对指定接口做通用剥离（删除含关键词的子 message）
  if (
    url.includes("/c/s/loop?cmd=309732") ||
    url.includes("/c/f/excellent/personalized") ||
    url.includes("/c/f/ad/getFeedAd")
  ) {
    const bodyU8 = toU8FromQXResponse();
    if (!bodyU8 || bodyU8.length === 0) {
      log("Tieba_AdKiller_QX: bodyBytes empty, skip");
      return $done({});
    }

    const kws = keywordsForUrl(url);
    const newU8 = stripProtobufByKeywords(bodyU8, kws);

    // 有变化才回写，减少误伤风险
    if (newU8.length !== bodyU8.length) {
      log(`Tieba_AdKiller_QX: stripped protobuf (${bodyU8.length} -> ${newU8.length}) url=${url}`);
      return writeBackBytes(newU8);
    } else {
      // 没变化就不动
      return writeBackBytes(bodyU8);
    }
  }

  // 其它接口：不处理
  return $done({});
} catch (e) {
  log("Tieba_AdKiller_QX ERROR: " + e);
  return $done({});
}