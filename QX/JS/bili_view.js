// 文件名: bili_view.js
// 功能: Bilibili 视频详情页去广告 (去除相关推荐广告、UP主推荐广告/笔记/活动横幅)

const url = $request.url;
let body = $response.body;

if (body) {
    try {
        let obj = JSON.parse(body);
        if (obj.data) {
            // 1. 清洗【相关推荐】列表 (relates)
            // 去除混入的广告卡片 ("1块钱抢这么多" 等)
            if (obj.data.relates && obj.data.relates.length > 0) {
                obj.data.relates = obj.data.relates.filter(item => {
                    // 过滤逻辑：只要包含广告特征字段就移除
                    if (item.is_ad) return false;           // 明确标记为广告
                    if (item.ad_info) return false;         // 含有广告信息
                    if (item.card_type && item.card_type.indexOf("ad") !== -1) return false; // 卡片类型含ad
                    if (item.cmd) return false;             // cmd通常是跳转第三方链接
                    return true;
                });
            }

            // 2. 去除【视频下方横幅】(cms)
            // 去除 "9块9抢"、"UP主推荐" 等横幅
            if (obj.data.cms) {
                delete obj.data.cms;
            }

            // 3. 去除【顶部/中部活动挂件】(activity_season)
            // 某些大型活动（如跨年季）的横幅
            if (obj.data.activity_season) {
                delete obj.data.activity_season;
            }
            
            // 4. 强力清理其他广告字段
            delete obj.data.ad_info;
            delete obj.data.banner; 
            
            body = JSON.stringify(obj);
        }
    } catch (e) {
        console.log("Bili View Rewrite Error: " + e);
    }
}
$done({ body });
