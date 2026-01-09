// tieba_ae_identity.js
// Force Accept-Encoding to identity so server returns plain protobuf.

let h = $request.headers || {};
// 兼容大小写
h["Accept-Encoding"] = "identity";
h["accept-encoding"] = "identity";

$done({ headers: h });
