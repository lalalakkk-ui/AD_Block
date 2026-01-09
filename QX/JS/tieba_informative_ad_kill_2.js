/**
 * Tieba informativeTab 去“精选热推/下载类广告”卡片
 * 思路：在 H5 页面里注入一个 MutationObserver，持续扫描并移除带“广告/立即下载/下载”特征的卡片容器
 */
const body = $response.body;
if (!body) $done({});

const INJECT_MARK = "/*__QX_TIEBA_AD_KILL__*/";

if (body.includes(INJECT_MARK)) {
  $done({ body });
}

const injected = `
<script>${INJECT_MARK}
(function () {
  function textOf(el) {
    try { return (el && (el.innerText || el.textContent) || "").trim(); } catch (e) { return ""; }
  }

  function closestContainer(el) {
    if (!el) return null;
    // 优先找更像“卡片”的容器
    const sel = [
      "li", "article", "section",
      "div[class*='card']", "div[class*='item']", "div[class*='feed']"
    ];
    for (const s of sel) {
      const c = el.closest && el.closest(s);
      if (c) return c;
    }
    // 兜底：向上爬 8 层
    let p = el;
    for (let i = 0; i < 8 && p && p.parentElement; i++) p = p.parentElement;
    return p;
  }

  function isDownloadAdContainer(container) {
    const t = textOf(container);
    // 关键特征：出现“广告”且同时出现“下载/立即下载”
    if (!t) return false;
    const hasAd = t.includes("广告");
    const hasDl = t.includes("立即下载") || t.includes("下载");
    // “下载”可能误伤，因此要求同时含“广告”
    return hasAd && hasDl;
  }

  function killOnce(root) {
    root = root || document;
    // 1) 先按“立即下载”按钮定位（命中率高）
    const btns = Array.from(root.querySelectorAll("a,button,div,span"))
      .filter(el => {
        const t = textOf(el);
        return t === "立即下载" || t === "下载";
      });

    for (const b of btns) {
      const c = closestContainer(b);
      if (c && isDownloadAdContainer(c)) {
        c.remove();
      }
    }

    // 2) 再按“广告”标签兜底（有些样式没有明确按钮节点）
    const adTags = Array.from(root.querySelectorAll("div,span,i,em"))
      .filter(el => textOf(el) === "广告");

    for (const tag of adTags) {
      const c = closestContainer(tag);
      if (c && isDownloadAdContainer(c)) {
        c.remove();
      }
    }
  }

  function start() {
    killOnce(document);

    const mo = new MutationObserver(() => {
      // 降频：用 requestAnimationFrame 合并多次变更
      if (start._raf) return;
      start._raf = requestAnimationFrame(() => {
        start._raf = 0;
        killOnce(document);
      });
    });

    mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
</script>
`;

const out = body.replace(/<\/head>/i, injected + "\n</head>");
$done({ body: out });
