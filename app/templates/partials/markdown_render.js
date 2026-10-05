  // ===== 轻量 Markdown 渲染器（与 IDE 内置渲染/旧版分享页同款，抽出来共用）=====
  function mdEsc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // 先整体转义，代码块/行内代码/图片/链接用占位符保护，最后还原
  function renderMarkdown(src) {
    const stash = [];
    const keep = (h) => { stash.push(h); return "\u0000" + (stash.length - 1) + "\u0000"; };
    let text = String(src == null ? "" : src).replace(/\r\n?/g, "\n");
    text = text.replace(/```(\w*)[ \t]*\n([\s\S]*?)(?:\n[ \t]*```|$)/g,
      (m, lang, code) => "\n" + keep('<pre><code' + (lang ? ' class="lang-' + mdEsc(lang) + '"' : "") + ">" + mdEsc(code) + "</code></pre>") + "\n");
    text = mdEsc(text);
    text = text.replace(/`([^`\n]+)`/g, (m, c) => keep("<code>" + c + "</code>"));
    text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => keep('<img src="' + url.replace(/"/g, "") + '" alt="' + alt + '">'));
    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, url) => keep('<a href="' + url.replace(/"/g, "") + '">' + t + "</a>"));
    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    const lines = text.split("\n");
    const out = [];
    let i = 0;
    const isBlank = (l) => /^\s*$/.test(l);
    const isFence = (l) => /^\u0000\d+\u0000$/.test(l.trim());
    const taskMark = (h) => h.replace(/^\[( |x|X)\]\s+/, (m, c) => '<input type="checkbox" disabled' + (c.toLowerCase() === "x" ? " checked" : "") + "> ");
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) { i++; continue; }
      if (isFence(line)) { out.push(line.trim()); i++; continue; }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
        const heads = cells(line);
        const aligns = cells(lines[i + 1]).map(c => {
          const l = c.startsWith(":"), r = c.endsWith(":");
          return l && r ? "center" : r ? "right" : l ? "left" : "";
        });
        const al = (k) => aligns[k] ? ' style="text-align:' + aligns[k] + '"' : "";
        let html = "<table><thead><tr>" + heads.map((h, k) => "<th" + al(k) + ">" + h + "</th>").join("") + "</tr></thead><tbody>";
        i += 2;
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          const row = cells(lines[i]);
          html += "<tr>" + heads.map((_, k) => "<td" + al(k) + ">" + (row[k] || "") + "</td>").join("") + "</tr>";
          i++;
        }
        out.push(html + "</tbody></table>"); continue;
      }
      let m = line.match(/^(#{1,6})\s+(.*)$/);
      if (m) { const n = m[1].length; out.push("<h" + n + ">" + m[2] + "</h" + n + ">"); i++; continue; }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
      if (/^\s*&gt;\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*&gt;\s?/, "")); i++; }
        out.push("<blockquote>" + buf.join("<br>") + "</blockquote>"); continue;
      }
      if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
        const ordered = /^\s*\d+\.\s+/.test(line);
        const re = ordered ? /^\s*\d+\.\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
        let html = ordered ? "<ol>" : "<ul>";
        while (i < lines.length && re.test(lines[i])) { html += "<li>" + taskMark(lines[i].replace(re, "$1")) + "</li>"; i++; }
        out.push(html + (ordered ? "</ol>" : "</ul>")); continue;
      }
      const buf = [line]; i++;
      while (i < lines.length && !isBlank(lines[i]) && !isFence(lines[i]) &&
             !/^(#{1,6})\s+/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) &&
             !/^\s*\d+\.\s+/.test(lines[i]) && !/^\s*&gt;/.test(lines[i]) &&
             !/^\s*\|.*\|\s*$/.test(lines[i]) && !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) {
        buf.push(lines[i]); i++;
      }
      out.push("<p>" + buf.join("<br>") + "</p>");
    }
    return out.join("\n").replace(/\u0000(\d+)\u0000/g, (m, k) => stash[+k]);
  }
