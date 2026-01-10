// bili_view_req_identity.js
let h = $request.headers || {};

// 统一大小写处理（QX 有时保留原始大小写）
function delHeader(key) {
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === key) delete h[k];
  }
}

// gRPC 压缩协商
delHeader("grpc-encoding");
delHeader("grpc-accept-encoding");
h["grpc-accept-encoding"] = "identity";

// HTTP 层压缩（可选）
delHeader("accept-encoding");
h["Accept-Encoding"] = "identity";

$done({ headers: h });
