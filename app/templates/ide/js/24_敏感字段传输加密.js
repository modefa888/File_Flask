/* ================================================================
   敏感字段传输加密（纯 JS，不依赖 WebCrypto）
   ----------------------------------------------------------------
   为什么不用 crypto.subtle：
     IDE 通常通过 http://<局域网IP>:端口 访问，属于「非安全上下文」，
     浏览器在这种页面下不暴露 crypto.subtle，只能用纯 JS 实现。
   怎么做：
     公钥由后端渲染页面时注入（window.__tpPub 的 n / e 两个十六进制大数，
     避免前端解析 PEM / DER），这里用 BigInt 做 RSA-OAEP(SHA-256) 加密，
     密文加 "tp1:" 前缀提交；后端 services/common/transport.py 用私钥解出明文，
     再按存储密钥加密落库（enc:v1:）。
   对外接口：
     window.TP.enabled      传输加密是否可用（后端未装 cryptography 时为 false）
     window.TP.encrypt(v)   同步返回密文；未启用 / 空值 / 超长时原样返回明文
   ================================================================ */
(function () {
  "use strict";

  var pub = (window.__tpPub && window.__tpPub.enabled) ? window.__tpPub : null;
  var PREFIX = "tp1:";
  var KLEN = 256;   // RSA-2048 模长（字节）
  var HLEN = 32;    // SHA-256 摘要长度

  var N = null, E = null;
  if (pub && pub.n && pub.e) {
    try { N = BigInt("0x" + pub.n); E = BigInt("0x" + pub.e); } catch (e) { N = null; }
  }

  /* ---------------- SHA-256 ---------------- */
  var K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);
  var H0 = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);

  function rotr(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }

  function sha256(bytes) {
    var len = bytes.length;
    var total = ((len + 9 + 63) >> 6) << 6;
    var buf = new Uint8Array(total);
    buf.set(bytes);
    buf[len] = 0x80;
    var bits = BigInt(len) * 8n;
    for (var i = 0; i < 8; i++) {
      buf[total - 1 - i] = Number((bits >> BigInt(8 * i)) & 0xffn);
    }
    var H = H0.slice();
    var w = new Uint32Array(64);
    for (var off = 0; off < total; off += 64) {
      for (var j = 0; j < 16; j++) {
        w[j] = ((buf[off + j * 4] << 24) | (buf[off + j * 4 + 1] << 16) |
                (buf[off + j * 4 + 2] << 8) | buf[off + j * 4 + 3]) >>> 0;
      }
      for (var k = 16; k < 64; k++) {
        var x = w[k - 15], y = w[k - 2];
        var s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
        var s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
        w[k] = (w[k - 16] + s0 + w[k - 7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (var m = 0; m < 64; m++) {
        var S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
        var ch = ((e & f) ^ (~e & g)) >>> 0;
        var t1 = (h + S1 + ch + K[m] + w[m]) >>> 0;
        var S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
        var maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        var t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
      H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
      H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    var out = new Uint8Array(32);
    for (var n = 0; n < 8; n++) {
      out[n * 4] = (H[n] >>> 24) & 0xff;
      out[n * 4 + 1] = (H[n] >>> 16) & 0xff;
      out[n * 4 + 2] = (H[n] >>> 8) & 0xff;
      out[n * 4 + 3] = H[n] & 0xff;
    }
    return out;
  }

  /* ---------------- MGF1（OAEP 用） ---------------- */
  function mgf1(seed, len) {
    var out = new Uint8Array(len);
    var buf = new Uint8Array(seed.length + 4);
    buf.set(seed);
    var pos = 0, counter = 0;
    while (pos < len) {
      buf[seed.length] = (counter >>> 24) & 0xff;
      buf[seed.length + 1] = (counter >>> 16) & 0xff;
      buf[seed.length + 2] = (counter >>> 8) & 0xff;
      buf[seed.length + 3] = counter & 0xff;
      var h = sha256(buf);
      var take = Math.min(h.length, len - pos);
      out.set(h.subarray(0, take), pos);
      pos += take;
      counter++;
    }
    return out;
  }

  /* ---------------- 大数工具 ---------------- */
  function bytesToBigInt(bytes) {
    var v = 0n;
    for (var i = 0; i < bytes.length; i++) v = (v << 8n) | BigInt(bytes[i]);
    return v;
  }

  function bigIntToBytes(v, len) {
    var out = new Uint8Array(len);
    for (var i = len - 1; i >= 0; i--) {
      out[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return out;
  }

  function modPow(base, exp, mod) {
    var result = 1n, b = base % mod, e = exp;
    while (e > 0n) {
      if (e & 1n) result = (result * b) % mod;
      b = (b * b) % mod;
      e >>= 1n;
    }
    return result;
  }

  function toB64(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  /* ---------------- RSA-OAEP(SHA-256) 加密 ---------------- */
  var L_HASH = sha256(new Uint8Array(0));

  function rsaOaepEncrypt(msg) {
    if (msg.length > KLEN - 2 * HLEN - 2) {
      throw new Error("明文过长（最多 " + (KLEN - 2 * HLEN - 2) + " 字节）");
    }
    // DB = lHash || PS(0x00...) || 0x01 || M（长度 = k - hLen - 1）
    var db = new Uint8Array(KLEN - HLEN - 1);
    db.set(L_HASH, 0);
    db[db.length - 1 - msg.length] = 0x01;
    db.set(msg, db.length - msg.length);

    var seed = new Uint8Array(HLEN);
    crypto.getRandomValues(seed);

    var dbMask = mgf1(seed, db.length);
    var maskedDB = new Uint8Array(db.length);
    for (var i = 0; i < db.length; i++) maskedDB[i] = db[i] ^ dbMask[i];

    var seedMask = mgf1(maskedDB, HLEN);
    var maskedSeed = new Uint8Array(HLEN);
    for (var j = 0; j < HLEN; j++) maskedSeed[j] = seed[j] ^ seedMask[j];

    // EM = 0x00 || maskedSeed || maskedDB
    var em = new Uint8Array(KLEN);
    em.set(maskedSeed, 1);
    em.set(maskedDB, 1 + HLEN);

    var c = modPow(bytesToBigInt(em), E, N);
    return bigIntToBytes(c, KLEN);
  }

  window.TP = {
    enabled: !!N,
    encrypt: function (value) {
      if (!value || !N) return value;            // 未启用 / 空值：原样提交
      try {
        return PREFIX + toB64(rsaOaepEncrypt(new TextEncoder().encode(String(value))));
      } catch (e) {
        console.warn("[TP] 敏感字段传输加密失败，按明文提交：", e && e.message);
        return value;
      }
    }
  };
})();
