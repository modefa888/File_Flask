"""新建项目时的初始框架：内置模板 + AI 按一句话描述生成骨架。

本模块只产出「相对路径 → 文本内容」的文件清单，落盘统一走 write_manifest()，
在那里做路径与体量校验，避免模板或模型给出的路径逃出项目目录。
"""
import json
import os
import re

# ---- 体量上限（防止模型给出超多 / 超大文件把磁盘写满）----
MAX_FILES = 40                       # 单次最多写入的文件数
MAX_FILE_BYTES = 200 * 1024          # 单文件最大 200 KB
MAX_TOTAL_BYTES = 1024 * 1024        # 合计最大 1 MB
MAX_PATH_LEN = 160                   # 相对路径最大长度

# 绝对路径 / 家目录 / 上跳 一律拒绝
_BAD_PATH = re.compile(r"(^/)|(^[A-Za-z]:)|(^~)|(?:^|/)\.\.(?:/|$)")


def _f(path, content):
    return {"path": path, "content": content}


_FLASK_APP = '''"""Flask 应用入口。

本地运行：
    pip install -r requirements.txt
    python app.py
"""
from flask import Flask, render_template

app = Flask(__name__)


@app.route("/")
def index():
    return render_template("index.html", title="{name}")


@app.route("/api/health")
def health():
    return {"ok": True}


if __name__ == "__main__":
    app.run(debug=True, port=5000)
'''

_FLASK_INDEX = '''<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{{ title }}</title>
  <link rel="stylesheet" href="{{ url_for('static', filename='style.css') }}">
</head>
<body>
  <main class="card">
    <h1>{{ title }}</h1>
    <p>Flask 项目已就绪，开始改 <code>app.py</code> 吧。</p>
    <button id="btn">点我</button>
    <p id="out"></p>
  </main>
  <script>
    document.getElementById("btn").onclick = () =>
      document.getElementById("out").textContent = "前端脚本也正常工作了";
  </script>
</body>
</html>
'''

_STYLE = '''* { box-sizing: border-box; }
body {
  margin: 0; min-height: 100vh; display: grid; place-items: center;
  background: #0f172a; color: #e2e8f0;
  font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", sans-serif;
}
.card {
  padding: 32px 36px; border-radius: 14px; text-align: center;
  background: #1e293b; box-shadow: 0 16px 40px rgba(0, 0, 0, .4);
}
.card h1 { margin: 0 0 8px; font-size: 22px; }
code { background: #0f172a; padding: 2px 6px; border-radius: 4px; }
button {
  margin-top: 12px; padding: 8px 18px; border: 0; border-radius: 8px;
  background: #2563eb; color: #fff; font-size: 14px; cursor: pointer;
}
button:hover { background: #1d4ed8; }
'''

_FASTAPI_MAIN = '''"""FastAPI 服务入口。

本地运行：
    pip install -r requirements.txt
    uvicorn main:app --reload
"""
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="{name}")


class Item(BaseModel):
    name: str


@app.get("/")
def index():
    return {"ok": True, "app": "{name}"}


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/items")
def create_item(item: Item):
    return {"received": item.name}
'''

_PY_MAIN = '''"""程序入口。

运行：
    python main.py
"""


def main():
    print("Hello, {name}!")


if __name__ == "__main__":
    main()
'''

_NODE_PKG = '''{
  "name": "{slug}",
  "version": "1.0.0",
  "private": true,
  "description": "{name}",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.19.2"
  }
}
'''

_NODE_SERVER = '''// 启动：npm install && npm start
const express = require("express");

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

app.get("/api/health", (req, res) => res.json({ ok: true }));

app.listen(port, () => {
  console.log(`{name} 已启动： http://localhost:${port}`);
});
'''

_WEB_INDEX = '''<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{name}</title>
  <link rel="stylesheet" href="css/style.css">
</head>
<body>
  <main class="wrap">
    <h1>{name}</h1>
    <p>静态站点已就绪。</p>
    <button id="btn">点我</button>
    <p id="out"></p>
  </main>
  <script src="js/main.js"></script>
</body>
</html>
'''

_WEB_JS = '''document.getElementById("btn").addEventListener("click", () => {
  document.getElementById("out").textContent = "脚本已加载 ✓";
});
'''

_REQ_FLASK = "flask>=3.0\n"
_REQ_FASTAPI = "fastapi>=0.110\nuvicorn[standard]>=0.29\n"
_REQ_EMPTY = "# 依赖写在这里，例如：requests>=2.31\n"

_GITIGNORE_PY = '''__pycache__/
*.py[cod]
.venv/
venv/
.env
*.sqlite3
.DS_Store
'''

_GITIGNORE_NODE = '''node_modules/
npm-debug.log*
.env
.DS_Store
'''

_README = '''# {name}

{desc}

## 运行

{run}

## 目录结构

```
{tree}
```
'''


def _readme(name, desc, run, tree):
    return _README.replace("{name}", name).replace("{desc}", desc) \
                  .replace("{run}", run).replace("{tree}", tree)


# ---- 内置模板：key → {label, icon, hint, files} ----
TEMPLATES = {
    "blank": {
        "label": "空项目", "icon": "bi-folder2", "hint": "只建目录，不放任何文件",
        "files": [],
    },
    "flask": {
        "label": "Flask", "icon": "bi-globe2", "hint": "Web 应用：app.py + 模板 + 静态资源",
        "files": [
            _f("app.py", _FLASK_APP),
            _f("requirements.txt", _REQ_FLASK),
            _f("templates/index.html", _FLASK_INDEX),
            _f("static/style.css", _STYLE),
            _f(".gitignore", _GITIGNORE_PY),
            _f("README.md", _readme("{name}", "基于 Flask 的 Web 应用。",
                                    "```bash\npip install -r requirements.txt\npython app.py\n```",
                                    "app.py            应用入口\n"
                                    "templates/        HTML 模板\n"
                                    "static/           静态资源\n"
                                    "requirements.txt  依赖")),
        ],
    },
    "fastapi": {
        "label": "FastAPI", "icon": "bi-lightning-charge", "hint": "API 服务：main.py + uvicorn",
        "files": [
            _f("main.py", _FASTAPI_MAIN),
            _f("requirements.txt", _REQ_FASTAPI),
            _f(".gitignore", _GITIGNORE_PY),
            _f("README.md", _readme("{name}", "基于 FastAPI 的接口服务。",
                                    "```bash\npip install -r requirements.txt\nuvicorn main:app --reload\n```",
                                    "main.py           应用入口\n"
                                    "requirements.txt  依赖")),
        ],
    },
    "python": {
        "label": "Python", "icon": "bi-filetype-py", "hint": "脚本 / 包：main.py + 依赖清单",
        "files": [
            _f("main.py", _PY_MAIN),
            _f("requirements.txt", _REQ_EMPTY),
            _f(".gitignore", _GITIGNORE_PY),
            _f("README.md", _readme("{name}", "Python 项目模板。",
                                    "```bash\npip install -r requirements.txt\npython main.py\n```",
                                    "main.py           程序入口\n"
                                    "requirements.txt  依赖")),
        ],
    },
    "node": {
        "label": "Node", "icon": "bi-filetype-js", "hint": "Express 服务：server.js + package.json",
        "files": [
            _f("package.json", _NODE_PKG),
            _f("server.js", _NODE_SERVER),
            _f("public/.gitkeep", ""),
            _f(".gitignore", _GITIGNORE_NODE),
            _f("README.md", _readme("{name}", "基于 Express 的 Node 服务。",
                                    "```bash\nnpm install\nnpm start\n```",
                                    "server.js     服务入口\n"
                                    "public/       静态资源\n"
                                    "package.json  依赖与脚本")),
        ],
    },
    "web": {
        "label": "静态站点", "icon": "bi-window", "hint": "纯前端：HTML + CSS + JS，双击即看",
        "files": [
            _f("index.html", _WEB_INDEX),
            _f("css/style.css", _STYLE),
            _f("js/main.js", _WEB_JS),
            _f("README.md", _readme("{name}", "纯静态网站，直接用浏览器打开 index.html 即可。",
                                    "双击 `index.html`，或\n```bash\npython -m http.server 8000\n```",
                                    "index.html  页面\n"
                                    "css/        样式\n"
                                    "js/         脚本")),
        ],
    },
}

AI_KEY = "ai"                        # 「AI 生成」在前端是独立选项，不属于内置模板

AI_SYS = (
    "你是项目脚手架生成器。根据用户的一句话描述，产出一个「最小可运行」的项目初始文件清单。\n"
    "只输出一个 JSON 对象，不要解释、不要 Markdown 代码块、不要在 JSON 前后加任何文字：\n"
    '{"files":[{"path":"app.py","content":"文件内容"}, ...]}\n'
    "硬性要求：\n"
    "1. path 只能是相对路径（用 / 分隔）：禁止绝对路径、禁止 ..、禁止以 / 或 ~ 开头；\n"
    "2. 少而精：只产出真正必要的文件，通常 2~6 个；单个文件不超过 60 行；\n"
    "3. 顺序上把最重要的入口文件放在最前面，README.md 放在最后（便于输出被截断时保住主体）；\n"
    "4. content 是完整文件内容，不要用省略号、TODO 或「此处省略」占位；\n"
    "5. 必须包含 README.md，安装与运行命令各一行即可，不要长篇说明；依赖写进依赖清单"
    "（Python 用 requirements.txt，Node 用 package.json）；\n"
    "6. 技术栈以用户描述为准，未说明时选简洁通用的方案；代码要能直接跑起来，不要附加多余功能。"
)


def render(template, name, desc=""):
    """内置模板 → 文件清单（把 {name} 占位换成项目名）"""
    tpl = TEMPLATES.get(template)
    if not tpl:
        return []
    files = []
    for it in tpl["files"]:
        files.append({"path": it["path"],
                      "content": str(it["content"]).replace("{name}", name)
                                               .replace("{slug}", _slug(name))})
    return files


def _slug(name):
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", str(name or "")).strip("-").lower()
    return s or "app"


def _iter_raw_files(s):
    """逐条扫描 {"path": "...", "content": "..."}，容忍 JSON 整体被截断。

    上游对输出长度有限制时，模型常在 content 字符串中间被切断，整体 json.loads 必然失败；
    这里按「从头往后再扫下一条」的方式把已完整的对象捞出来，最后一条即使没写完也保留其已有内容。
    """
    out = []
    for m in re.finditer(r'\{\s*"path"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"content"\s*:\s*"', s):
        i, buf = m.end(), []
        closed = False
        while i < len(s):
            ch = s[i]
            if ch == "\\":
                buf.append(s[i:i + 2])
                i += 2
                continue
            if ch == '"':
                closed = True
                break
            buf.append(ch)
            i += 1
        raw = "".join(buf)
        try:
            content = json.loads('"' + raw + '"')
        except Exception:
            content = raw
        if not content:
            continue
        try:
            path = json.loads('"' + m.group(1) + '"')
        except Exception:
            path = m.group(1)
        out.append({"path": str(path).strip(), "content": content, "_truncated": not closed})
    return out


def parse_manifest(text):
    """从模型输出里抠出文件清单（容忍 ``` 围栏、前后说明，以及被截断的输出）；失败返回 []"""
    s = (text or "").strip()
    m = re.search(r"```(?:json)?\s*(.+?)(?:```|\Z)", s, re.S | re.I)
    if m:
        s = m.group(1).strip()
    i, j = s.find("{"), s.rfind("}")
    if i >= 0 and j > i:
        try:
            obj = json.loads(s[i:j + 1])
            files = obj.get("files") if isinstance(obj, dict) else obj
            if isinstance(files, list):
                out = []
                for it in files:
                    if not isinstance(it, dict):
                        continue
                    path = str(it.get("path") or "").strip()
                    content = it.get("content")
                    if not path or content is None:
                        continue
                    if not isinstance(content, str):
                        content = json.dumps(content, ensure_ascii=False, indent=2)
                    out.append({"path": path, "content": content})
                if out:
                    return out
        except Exception:
            pass
    # 整体解析不出来（多半是被截断）：逐条捞，能救几个是几个
    return [f for f in _iter_raw_files(s) if f["path"]]


def write_manifest(target, files):
    """把清单落到 target 下，返回 (写入的相对路径列表, 被跳过的路径列表)。

    只接受相对路径，且规范化后必须仍在 target 内 —— 这是防「路径穿越」的关键一环。
    """
    written, skipped = [], []
    target_abs = os.path.abspath(target)
    prefix = target_abs + os.sep
    total = 0
    for it in files or []:
        rel = str(it.get("path") or "").strip().replace("\\", "/")
        content = it.get("content")
        if not rel or content is None or len(written) >= MAX_FILES:
            if rel:
                skipped.append(rel)
            continue
        if len(rel) > MAX_PATH_LEN or "\x00" in rel or _BAD_PATH.search(rel):
            skipped.append(rel)
            continue
        full = os.path.abspath(os.path.normpath(os.path.join(target_abs, rel)))
        if not full.startswith(prefix):
            skipped.append(rel)
            continue
        data = str(content).encode("utf-8")
        if len(data) > MAX_FILE_BYTES or total + len(data) > MAX_TOTAL_BYTES:
            skipped.append(rel)
            continue
        try:
            parent = os.path.dirname(full)
            if parent:
                os.makedirs(parent, exist_ok=True)
            with open(full, "w", encoding="utf-8") as fh:
                fh.write(str(content))
        except Exception:
            skipped.append(rel)
            continue
        total += len(data)
        written.append(rel)
    return written, skipped
