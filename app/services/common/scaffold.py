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


# 构建前的「快速规划」：只要文件清单，不要文件内容 —— 请求小、返回快，
# 前端拿到就能立刻画目录树并建目录，不用等正文那条流慢慢思考。
AI_PLAN_SYS = (
    "你是项目结构规划助手。根据用户的一句话项目描述，列出这个项目需要的最小文件清单。\n"
    "只输出一个 JSON 对象，不要解释、不要 Markdown 代码块、不要在 JSON 前后加任何文字：\n"
    '{"files":[{"path":"app.py","role":"Flask 入口"},'
    '{"path":"templates/index.html","role":"首页"},{"path":"README.md","role":"说明"}]}\n'
    "硬性要求：\n"
    "1. 只列路径，绝对不要输出任何文件内容或代码；role 不超过 12 个字；\n"
    "2. path 只能是相对路径（用 / 分隔）：禁止绝对路径、禁止 ..、禁止以 / 或 ~ 开头；\n"
    "3. 3~10 个文件，只列真正需要的；必须包含 README.md，依赖写进依赖清单"
    "（Python 用 requirements.txt，Node 用 package.json）；\n"
    "4. 按重要性排序（入口文件在前）；思考要极简，想好目录结构就直接输出 JSON。"
)


AI_AGENT_SYS = (
    "你是项目构建智能体。根据用户的一句话描述，你要把整个项目真实地建出来："
    "先规划要哪些文件，再逐个把文件内容写出来。\n"
    "输出必须严格按下面的格式，不要任何解释、不要用 Markdown 代码块包裹整体：\n"
    "<plan>\n"
    "app.py | Flask 入口\n"
    "templates/index.html | 首页\n"
    "</plan>\n"
    '<write path="app.py">\n'
    "（app.py 的完整内容）\n"
    "</write>\n"
    '<write path="templates/index.html">\n'
    "（该文件的完整内容）\n"
    "</write>\n"
    "<done/>\n"
    "硬性要求：\n"
    "1. <plan> 里一行一个文件，格式「相对路径 | 一句话说明」，按重要性排序；\n"
    "2. 之后每个文件用一对 <write path=\"...\"></write> 包裹，内容必须完整、能直接运行，"
    "禁止省略号、TODO、「此处省略」；\n"
    "3. path 只能是相对路径（用 / 分隔）：禁止绝对路径、禁止 ..、禁止以 / 或 ~ 开头；\n"
    "4. 文件少而精，通常 3~8 个，单个文件不超过 120 行；\n"
    "5. 必须包含 README.md（安装与运行命令各一行）；依赖写进依赖清单"
    "（Python 用 requirements.txt，Node 用 package.json）；\n"
    "6. 全部写完后输出 <done/>；<write> 之外不要写任何代码或说明文字；\n"
    "7. 思考要简短：不要在思考里推演或试写文件内容（容易把输出预算耗光），"
    "想清楚目录结构就直接开始输出 <plan> 与 <write>。"
)

AI_NAME_SYS = (
    "你是项目规划助手。用户会给一句话描述，你要先把整个项目想清楚"
    "（技术栈、功能模块、目录结构），最后再据此给项目起名 —— 名字必须建立在这份规划之上。\n"
    "只输出一个 JSON 对象，不要解释、不要 Markdown 代码块、不要在 JSON 前后加任何文字：\n"
    '{"summary":"一句话概括这个项目（不超过 20 字）",'
    '"stack":["Flask","SQLite"],'
    '"modules":["用户登录","文章管理"],'
    '"tree":["app.py","templates/index.html","static/style.css","README.md"],'
    '"names":[{"name":"flask-blog","why":"Flask + SQLite 的博客"}]}\n'
    "硬性要求：\n"
    "1. 顺序必须是「先规划、后命名」：summary → stack → modules → tree → names；\n"
    "2. stack 2~4 项（语言 / 框架 / 数据库）；modules 2~5 项（真正要做的功能）；\n"
    "   tree 3~8 条（计划生成的入口文件与主要目录，相对路径，目录以 / 结尾）；\n"
    "3. names 恰好 4 个，都要和上面的 stack / modules 相称，风格各不相同"
    "（简洁型、完整型、业务型、技术型各一个）；\n"
    "4. name 只允许小写字母、数字、连字符，1~32 个字符，不能以连字符开头或结尾；"
    "禁止 my-project / demo / test 这类泛泛的名字；\n"
    "5. why 不超过 16 个汉字，说清这个名字对应的定位。"
)


def _norm_names(items):
    """把模型给的名字规范化成合法目录名（小写 + 连字符），去重、限量。"""
    out, seen = [], set()
    for it in items or []:
        raw = str(it.get("name") or "").strip().lower()
        slug = re.sub(r"[^a-z0-9-]+", "-", raw)
        slug = re.sub(r"-{2,}", "-", slug).strip("-")[:32].strip("-")
        if not slug or slug in seen:
            continue
        seen.add(slug)
        why = re.sub(r"\s+", " ", str(it.get("why") or "")).strip()[:40]
        out.append({"name": slug, "why": why})
        if len(out) >= 6:
            break
    return out


def _one_line(v, limit=120):
    return re.sub(r"\s+", " ", str(v or "")).strip()[:limit]


def _str_list(v, maxn, maxlen):
    """把模型给的字符串数组（或逗号/顿号分隔的字符串）收拾成干净的列表。"""
    out = []
    if isinstance(v, str):
        v = re.split(r"[,，、;；\n]+", v)
    if isinstance(v, (list, tuple)):
        for it in v:
            if isinstance(it, dict):
                it = it.get("name") or it.get("path") or it.get("title") or ""
            s = _one_line(it, maxlen)
            if s and s not in out:
                out.append(s)
            if len(out) >= maxn:
                break
    return out


def _name_items(v):
    items = []
    if isinstance(v, dict):
        v = list(v.values())
    if isinstance(v, (list, tuple)):
        for it in v:
            if isinstance(it, str):
                items.append({"name": it, "why": ""})
            elif isinstance(it, dict):
                items.append({"name": it.get("name") or it.get("id") or "",
                              "why": it.get("why") or it.get("desc") or it.get("description") or ""})
    return items


def parse_plan(text):
    """从模型输出里抠出「项目规划 + 候选名」，返回 dict：

    {"summary", "stack", "modules", "tree", "names": [{"name","why"}]}

    整体解析失败时逐级兜底（扫 "name": "..." 片段 → 扫文本里的 kebab-case），
    保证「模型没严格按 JSON 输出」时也还有名字可用。
    """
    plan = {"summary": "", "stack": [], "modules": [], "tree": [], "names": []}
    s = (text or "").strip()
    m = re.search(r"```(?:json)?\s*(.+?)(?:```|\Z)", s, re.S | re.I)
    if m:
        s = m.group(1).strip()
    i, j = s.find("{"), s.rfind("}")
    obj = None
    if i >= 0 and j > i:
        try:
            obj = json.loads(s[i:j + 1])
        except Exception:
            obj = None
    if isinstance(obj, dict):
        plan["summary"] = _one_line(obj.get("summary") or obj.get("desc"), 120)
        plan["stack"] = _str_list(obj.get("stack") or obj.get("tech") or obj.get("technology"), 6, 20)
        plan["modules"] = _str_list(obj.get("modules") or obj.get("features"), 8, 20)
        plan["tree"] = _str_list(obj.get("tree") or obj.get("files") or obj.get("structure"), 12, 48)
        plan["names"] = _norm_names(_name_items(obj.get("names")))
    if not plan["names"]:                    # 整体不是合法 JSON：扫 "name": "..." 片段
        raw = re.findall(r'"name"\s*:\s*"((?:[^"\\]|\\.)*)"', s)
        plan["names"] = _norm_names([{"name": x} for x in raw])
    if not plan["names"]:                    # 还不是：从文本里捞 kebab-case 片段兜底
        cand = re.findall(r"(?<![A-Za-z0-9-])[a-z][a-z0-9]*(?:-[a-z0-9]+){1,3}(?![A-Za-z0-9-])", s)
        plan["names"] = _norm_names([{"name": c} for c in cand])
    return plan


def parse_names(text):
    """兼容旧调用：只取 (summary, names)。"""
    plan = parse_plan(text)
    return plan["summary"], plan["names"]


AI_FINAL_NAME_SYS = (
    "你会看到一个刚刚生成完的项目（技术栈、目录结构、主要文件的开头片段）。"
    "请根据它实际做的东西，给这个项目起一个可以直接当目录名用的英文名字（kebab-case）。\n"
    "只输出一个 JSON 对象，不要解释、不要 Markdown 代码块、不要在 JSON 前后加任何文字：\n"
    '{"name":"flask-blog","why":"Flask + SQLite 的博客","alts":["blog-app","flask-sqlite-blog"]}\n'
    "硬性要求：\n"
    "1. name 只允许小写字母、数字、连字符，2~32 个字符，不能以连字符开头或结尾；\n"
    "2. 名字要能概括项目实际做了什么，不要 my-project / demo / test 这类泛泛的名字；\n"
    "3. why 不超过 16 个汉字；alts 给 2 个备选（主名被占用时用）。"
)


def parse_final_name(text):
    """从模型输出里取最终项目名：返回 [主名, 备选...]（已规范化），失败返回 []。"""
    s = (text or "").strip()
    m = re.search(r"```(?:json)?\s*(.+?)(?:```|\Z)", s, re.S | re.I)
    if m:
        s = m.group(1).strip()
    i, j = s.find("{"), s.rfind("}")
    obj = None
    if i >= 0 and j > i:
        try:
            obj = json.loads(s[i:j + 1])
        except Exception:
            obj = None
    items = []
    if isinstance(obj, dict):
        items.append({"name": obj.get("name") or obj.get("slug") or "",
                      "why": obj.get("why") or obj.get("desc") or ""})
        alts = obj.get("alts") or obj.get("alternatives") or obj.get("names") or []
        if isinstance(alts, str):
            alts = re.split(r"[,，、;；\s]+", alts)
        if isinstance(alts, (list, tuple)):
            for a in alts:
                if isinstance(a, str):
                    items.append({"name": a, "why": ""})
                elif isinstance(a, dict):
                    items.append({"name": a.get("name") or "", "why": ""})
    if not items:                            # 不是合法 JSON：扫 "name": "..."
        items = [{"name": x} for x in re.findall(r'"name"\s*:\s*"((?:[^"\\]|\\.)*)"', s)]
    if not items:                            # 再兜底：文本里的 kebab-case 片段
        items = [{"name": x} for x in
                 re.findall(r"(?<![A-Za-z0-9-])[a-z][a-z0-9]*(?:-[a-z0-9]+){1,3}(?![A-Za-z0-9-])", s)]
    return _norm_names(items)


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


AI_FILE_SYS = (
    "你是代码生成器。用户会给你项目背景、完整文件清单，以及「本次要写哪一个文件」。\n"
    "你只输出这**一个文件**的完整内容：不要解释、不要寒暄、不要用 ``` 代码块包裹、"
    "不要重复文件名、不要在内容前后加任何说明文字。\n"
    "硬性要求：\n"
    "1. 内容必须完整、可直接运行，禁止省略号、TODO、「此处省略」「同上」；\n"
    "2. 严格贴合给定的技术栈与文件清单，接口 / 变量名要与清单里其它文件呼应；\n"
    "3. 代码质量优先：能用标准库就别引第三方，配置从环境变量读，别写死密钥；\n"
    "4. 思考要极简，想清楚这个文件的职责就开始写。"
)


def strip_fences(text):
    """去掉模型给整段内容套的 ``` 围栏（含被截断时只有开头的情况）。"""
    s = (text or "").strip()
    m = re.match(r"^```[A-Za-z0-9_+.\-]*[ \t]*\n(.*?)\n?```[ \t]*$", s, re.S)
    if m:
        return m.group(1)
    s = re.sub(r"^```[A-Za-z0-9_+.\-]*[ \t]*\n", "", s)
    s = re.sub(r"\n?\s*```[ \t]*$", "", s)
    return s.strip("\n")


def parse_plan(text):
    """从规划输出里抠出 [{"path","role"}]（比 parse_paths 多保留一句用途说明）。"""
    paths = parse_paths(text)
    roles = {}
    s = text or ""
    for m in re.finditer(r'"path"\s*:\s*"([^"]+)"[^}]*?"role"\s*:\s*"([^"]*)"', s, re.S):
        roles[m.group(1).strip()] = m.group(2).strip()[:24]
    if not roles:                      # 兼容一行一条「路径 | 说明」的写法
        for line in s.splitlines():
            if "|" in line:
                a, _, b = line.partition("|")
                a = a.strip().strip("`*_\"'-\u2022 \t")
                if a:
                    roles[a] = b.strip()[:24]
    return [{"path": p, "role": roles.get(p, "")} for p in paths]


def parse_paths(text):
    """从模型输出里抠出「文件路径清单」，返回 ["app.py", "templates/index.html"]。

    容忍 ``` 围栏、前后说明、输出被截断；既认 {"files":[{"path":...}]}，也认纯文本一行一条。
    只做路径提取，不涉内容 —— 供「先出目录树、再逐个写文件」的快速规划用。
    """
    s = (text or "").strip()
    m = re.search(r"```(?:json)?\s*(.+?)(?:```|\Z)", s, re.S | re.I)
    if m:
        s = m.group(1).strip()

    out, seen = [], set()

    def _add(p):
        p = str(p or "").strip().strip("`*_\"' \t").replace("\\", "/").strip()
        while p.startswith("./"):
            p = p[2:]
        p = p.strip()
        if not p or p in seen:
            return
        if p.startswith("/") or p.startswith("~") or ".." in p.split("/"):
            return
        seen.add(p)
        out.append(p)

    i, j = s.find("{"), s.rfind("}")
    obj = None
    if i >= 0 and j > i:
        try:
            obj = json.loads(s[i:j + 1])
        except Exception:
            obj = None
    if isinstance(obj, dict):
        files = obj.get("files") or obj.get("tree") or []
        if isinstance(files, dict):                     # {"files": {"app.py": {...}}} 也认
            files = list(files.keys())
        for it in (files if isinstance(files, list) else []):
            if isinstance(it, str):
                _add(it.split("|")[0])
            elif isinstance(it, dict):
                _add(it.get("path") or it.get("name") or "")
    if not out:
        # 兜底：一行一条路径（模型偶尔回成纯文本列表）
        for line in s.splitlines():
            line = line.strip().lstrip("-*+ ").strip()
            if not line or line[0] in "{}[]":
                continue
            p = line.split("|")[0].strip().strip("`*_\"' \t").strip()
            if p.endswith("/") or re.search(r"\.[A-Za-z0-9]{1,8}$", p):
                _add(p)
    return out[:40]


def parse_manifest(text):
    """从模型输出里抠出文件清单；失败返回 []。

    依次尝试：① 严格 JSON（容忍 ``` 围栏、前后说明）→ ② 逐条扫 {"path","content"}
    （容忍输出被截断）→ ③ Markdown 写法（一行文件名 + 紧跟代码块，模型常这么回）。
    """
    raw = (text or "").strip()
    s = raw
    m = re.search(r"```(?:json)?\s*(.+?)(?:```|\Z)", s, re.S | re.I)
    if m:
        s = m.group(1).strip()
    i, j = s.find("{"), s.rfind("}")
    if i >= 0 and j > i:
        try:
            obj = json.loads(s[i:j + 1])
            files = obj.get("files") if isinstance(obj, dict) else obj
            if isinstance(files, dict):        # 模型写成 {"app.py": "内容", ...} 也认
                files = [{"path": k, "content": v} for k, v in files.items()]
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
    # ② 整体解析不出来（多半是被截断）：按 "path"/"content" 逐条捞，能救几个是几个
    out = [f for f in _iter_raw_files(raw) if f["path"]]
    if out:
        return out
    # ③ 兜底：模型按 Markdown 写（一行文件名 + 紧跟代码块）
    seen, out = set(), []
    for mm in re.finditer(
            r"(?m)^[ \t>]*(?:#{1,6}[ \t]*|[-*+][ \t]*)?`?"
            r"([A-Za-z0-9_][A-Za-z0-9_./\-]*\.[A-Za-z0-9]{1,8})`?[ \t]*:?[ \t]*\r?\n"
            r"```[^\n]*\r?\n(.*?)```", raw, re.S):
        path = mm.group(1).strip()
        content = mm.group(2)
        if not path or path in seen or not content.strip():
            continue
        seen.add(path)
        out.append({"path": path, "content": content})
    return out


def prepare_manifest(target, files):
    """校验清单并规划落盘：返回 (可写入项, 被跳过的相对路径列表)。

    只接受相对路径，且规范化后必须仍在 target 内 —— 这是防「路径穿越」的关键一环。
    每项是 {"path", "full", "content", "bytes"}：先把「哪些文件、多大、写到哪」定下来，
    调用方就能在建目录 / 写文件之前把完整的文件树先展示给用户（流式进度用得上）。
    """
    items, skipped = [], []
    target_abs = os.path.abspath(target)
    prefix = target_abs + os.sep
    total = 0
    for it in files or []:
        rel = str(it.get("path") or "").strip().replace("\\", "/")
        content = it.get("content")
        if not rel or content is None:
            if rel:
                skipped.append(rel)
            continue
        if len(items) >= MAX_FILES:
            skipped.append(rel)
            continue
        if len(rel) > MAX_PATH_LEN or "\x00" in rel or _BAD_PATH.search(rel):
            skipped.append(rel)
            continue
        full = os.path.abspath(os.path.normpath(os.path.join(target_abs, rel)))
        if not full.startswith(prefix):
            skipped.append(rel)
            continue
        text = str(content)
        data = text.encode("utf-8")
        if len(data) > MAX_FILE_BYTES or total + len(data) > MAX_TOTAL_BYTES:
            skipped.append(rel)
            continue
        total += len(data)
        items.append({"path": rel, "full": full, "content": text, "bytes": len(data)})
    return items, skipped


def write_prepared(items):
    """把 prepare_manifest 的产出逐个落盘（父目录按需创建），返回 (written, skipped)。"""
    written, skipped = [], []
    for it in items or []:
        try:
            parent = os.path.dirname(it["full"])
            if parent:
                os.makedirs(parent, exist_ok=True)
            with open(it["full"], "w", encoding="utf-8") as fh:
                fh.write(it["content"])
        except Exception:
            skipped.append(it["path"])
            continue
        written.append(it["path"])
    return written, skipped


def write_manifest(target, files):
    """把清单落到 target 下，返回 (写入的相对路径列表, 被跳过的路径列表)。"""
    items, skipped = prepare_manifest(target, files)
    written, failed = write_prepared(items)
    return written, skipped + failed


def plan_dirs(items):
    """从待写入清单里抽出要建的目录（含各级父目录），父目录排在前、同级按名称排。"""
    seen, out = set(), []
    for it in items or []:
        parts = str(it["path"]).split("/")[:-1]
        for i in range(1, len(parts) + 1):
            d = "/".join(parts[:i])
            if d and d not in seen:
                seen.add(d)
                out.append(d)
    out.sort(key=lambda d: (d.count("/"), d.lower()))
    return out
