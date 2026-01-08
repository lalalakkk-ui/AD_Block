/**********************
 * Tieba H5 Ad Killer (QX)
 **********************/

let html = $response.body || "";
const url = $request.url || "";

console.log("H5 inject hit: " + url);

// 1) 移除 HTML 内的 CSP meta（如果 CSP 是 header 下发，这一步无效，但很多 H5 是 meta）
html = stripCSPMeta(html);

// 2) 注入：可视化验证 + 运行时持续清理（应对动态插入）
html = injectRuntimeCleaner(html);

// 3) 返回
$done({ body: html });

/* ---------- helpers ---------- */

function stripCSPMeta(s) {
  if (!s) return s;

  const before = s.length;

  // 常见 CSP meta 形式：http-equiv / name
  s = s.replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>\s*/ig, "");
  s = s.replace(/<meta[^>]+name=["']Content-Security-Policy["'][^>]*>\s*/ig, "");
  // 有些写成 content-security-policy（小写/变体）
  s = s.replace(/<meta[^>]+http-equiv=["']content-security-policy["'][^>]*>\s*/ig, "");
  s = s.replace(/<meta[^>]+name=["']content-security-policy["'][^>]*>\s*/ig, "");

  if (s.length !== before) console.log("CSP meta removed: " + (before - s.length) + " chars");
  return s;
}

function injectRuntimeCleaner(s) {
  if (!s) return s;

  const MARK = "<!--QX_TIEBA_ADKILLER_MARK-->";
  if (s.includes(MARK)) return s;

  // A) 强验证：如果注入生效，页面会出现红色外框（先用它确认“效果链路”）
  // 确认没问题后你可以把 outline 这行删掉
  const css = `
    html{outline:8px solid red !important;} /* 验证用：能看到说明 style 注入生效 */
    /* 下面是兜底选择器，后续你按实际 DOM 再精确补充 */
    [class*="ad"], [id*="ad"], [data-ad], [data-adid],
    .commercial, .sponsor, .promotion, .banner, .vip_banner, .vip-banner,
    [class*="banner"], [class*="vip"]{display:none !important;}
  `;

  // B) 运行时清理：应对“后插入”的广告/卡片
  // 注意：如果脚本仍不执行，基本就是 CSP header 限制了 inline script（见文末“如果仍无效怎么判定”）
  const js = `
    (function(){
      try{ console.log("[ADKILL] runtime cleaner active"); }catch(e){}

      const sels = [
        '[class*="ad"]','[id*="ad"]','[data-ad]','[data-adid]',
        '.commercial','.sponsor','.promotion','.banner','.vip_banner','.vip-banner',
        '[class*="banner"]','[class*="vip"]'
      ];

      function rm(){
        try{
          for(const sel of sels){
            document.querySelectorAll(sel).forEach(n=>n.remove());
          }
        }catch(e){}
      }

      rm();
      const mo = new MutationObserver(()=>rm());
      mo.observe(document.documentElement, {subtree:true, childList:true});

    })();
  `;

  const inject = `${MARK}<style>${css}</style><script>${js}<\/script>`;

  // 尽量插在 <head> 最前，保证先于页面脚本执行
  if (/<head[^>]*>/i.test(s)) {
    return s.replace(/<head[^>]*>/i, m => m + inject);
  }
  if (/<body[^>]*>/i.test(s)) {
    return s.replace(/<body[^>]*>/i, m => m + inject);
  }
  return inject + s;
}
