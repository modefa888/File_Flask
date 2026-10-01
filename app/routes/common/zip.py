"""ZIP 压缩包查看 / 下载 / 解压 / 嵌套读取路由。"""
import os
import io
import json
import shutil
import tempfile
import mimetypes
import subprocess
import threading
import time
import uuid

from flask import Blueprint, request, jsonify, Response as FlaskResponse
from urllib.parse import quote

from ...log import get_logger
from ...services.common.filecore import format_size, format_size_safe, _invalidate_list_cache
from ...services.common.archive_history import add_record as _add_archive_record


_log = get_logger()
bp = Blueprint("zip", __name__)

# 内存保护上限：zip 成员处理一律走流式，超限直接拒绝，避免把服务端内存打爆
_ZIP_PREVIEW_LIMIT = 50 * 1024 * 1024      # 在线预览（base64）最大 50MB
_ZIP_NESTED_LIMIT = 300 * 1024 * 1024      # 嵌套包外层成员驻留内存上限 300MB
_ZIP_EXTRACT_LIMIT = 2 * 1024 * 1024 * 1024  # 整包重新打包上限 2GB

# ---------- 实时解压进度（任务制） ----------
_UNZIP_TASKS = {}
_UNZIP_LOCK = threading.Lock()


def _unzip_worker(task_id, zip_path, target, dest_dir):
    task = _UNZIP_TASKS.get(task_id)
    if not task:
        return
    try:
        import zipfile
        count = 0
        target_prefix = target + os.sep
        with zipfile.ZipFile(zip_path, 'r') as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                rel = _decode_zip_name(info).replace('\\', '/').lstrip('/')
                if (not rel or rel == '..' or rel.startswith('../') or '/../' in rel
                        or os.path.isabs(rel)):
                    continue
                dest_file = os.path.abspath(os.path.join(target, rel))
                if dest_file != target and not dest_file.startswith(target_prefix):
                    continue
                os.makedirs(os.path.dirname(dest_file), exist_ok=True)
                size = info.file_size
                with _UNZIP_LOCK:
                    task["current"] = rel
                    base = task["done_bytes"]
                with zf.open(info) as src, open(dest_file, 'wb') as out:
                    remaining = size
                    while remaining > 0:
                        chunk = src.read(min(512 * 1024, remaining))
                        if not chunk:
                            break
                        out.write(chunk)
                        remaining -= len(chunk)
                        with _UNZIP_LOCK:
                            task["done_bytes"] = base + (size - remaining)
                with _UNZIP_LOCK:
                    task["done_files"] += 1
                    task["done_bytes"] = base + size
                count += 1
        _invalidate_list_cache(target)
        _invalidate_list_cache(dest_dir)
        with _UNZIP_LOCK:
            task["status"] = "done"
            task["result"] = {"path": target, "name": os.path.basename(target), "files": count}
        _add_archive_record("unzip", os.path.basename(target), dest_dir, "%d 个文件" % count)
    except zipfile.BadZipFile:
        with _UNZIP_LOCK:
            task["status"] = "error"
            task["error"] = "无效的 zip 文件"
    except Exception as e:
        with _UNZIP_LOCK:
            task["status"] = "error"
            task["error"] = str(e)


def _unrar_bin():
    """返回可用的 RAR 解压程序路径（优先 unrar，其次 unar），没有则 None"""
    for name in ("unrar", "unar"):
        p = shutil.which(name)
        if p:
            return p
    return None


def _rar_worker(task_id, rar_path, target, dest_dir, password=""):
    """调用系统 unrar/unar 解压 RAR（后台任务，进度按文件数累计）"""
    task = _UNZIP_TASKS.get(task_id)
    if not task:
        return
    try:
        os.makedirs(target, exist_ok=True)
        cmd = _rar_cmd(rar_path, target, password)
        if os.path.basename(cmd[0]) == "unrar":
            cmd += [target + os.sep]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL, text=True, errors="replace")
        count = 0
        for line in proc.stdout:
            line = line.strip()
            if line.startswith("Extracting") and ("OK" in line or line.endswith("...")):
                count += 1
                with _UNZIP_LOCK:
                    task["done_files"] = count
                    task["current"] = line.split("...")[-1].strip()
        proc.wait()
        if proc.returncode != 0:
            if password:
                raise RuntimeError("解压 RAR 失败：密码错误或缺失分卷")
            raise RuntimeError("RAR 需要密码")
        _invalidate_list_cache(target)
        _invalidate_list_cache(dest_dir)
        with _UNZIP_LOCK:
            task["status"] = "done"
            task["done_files"] = count
            task["result"] = {"path": target, "name": os.path.basename(target), "files": count}
        _add_archive_record("unrar", os.path.basename(rar_path), dest_dir, "%d 个文件" % count)
    except Exception as e:
        with _UNZIP_LOCK:
            task["status"] = "error"
            task["error"] = str(e)


def _decode_zip_name(info):
    """还原 zip 成员文件名。Windows 打包的中文名多为 GBK 编码且无 UTF-8 标记(0x800)，
    Python zipfile 默认按 cp437 解码会乱码。还原原始字节后依次尝试 utf-8 / gbk。"""
    name = info.filename
    if getattr(info, "flag_bits", 0) & 0x800:   # 已带 UTF-8 标记
        return name
    try:
        raw = name.encode("cp437")
    except (UnicodeEncodeError, AttributeError):
        return name
    for enc in ("utf-8", "gbk"):
        try:
            return raw.decode(enc)
        except (UnicodeDecodeError, ValueError):
            continue
    return name


def _find_zip_info(zf, entry_name):
    """按名字找成员：先精确原名，找不到再按解码后的显示名匹配。"""
    try:
        return zf.getinfo(entry_name)
    except KeyError:
        pass
    for info in zf.infolist():
        if _decode_zip_name(info) == entry_name:
            return info
    raise KeyError(entry_name)


# ---------- RAR 支持（系统 unrar / lsar 解析，沿用 zip 查看器流程） ----------
def _ext_icon(ext):
    ext = (ext or "").lower()
    if ext in ("png", "jpg", "jpeg", "gif", "svg", "webp"):
        return "bi-file-image"
    if ext in ("mp4", "webm", "mkv", "avi", "mov"):
        return "bi-file-play"
    if ext in ("mp3", "wav", "ogg", "flac"):
        return "bi-file-music"
    if ext in ("zip", "rar", "7z", "tar", "gz"):
        return "bi-file-zip"
    if ext in ("py", "js", "ts", "html", "css", "json", "xml", "md", "txt", "log", "csv", "sql", "ini", "yml"):
        return "bi-file-code"
    if ext == "pdf":
        return "bi-file-earmark-pdf"
    return "bi-file-earmark"


def _rar_bin():
    """返回可用的 RAR 解压程序路径（优先 unrar，其次 unar），没有则 None"""
    for name in ("unrar", "unar"):
        p = shutil.which(name)
        if p:
            return p
    return None


def _lsar_bin():
    p = shutil.which("lsar")
    return p


def _rar_members(rar_path, password=""):
    """用 lsar -j 解析 RAR 成员；返回 [(name, size, compressed, is_dir), ...]"""
    exe = _lsar_bin()
    if not exe:
        raise RuntimeError("系统未安装 lsar，无法读取 RAR 内容")
    cmd = [exe, "-j"]
    if password:
        cmd += ["-p", password]
    cmd += ["--", rar_path]
    out = subprocess.run(cmd, capture_output=True,
                         text=True, errors="replace", timeout=60, stdin=subprocess.DEVNULL)
    s = out.stdout.find("{")
    e = out.stdout.rfind("}")
    if s < 0 or e < 0:
        raise RuntimeError("无法解析 RAR 内容")
    data = json.loads(out.stdout[s:e + 1])
    members = []
    for it in data.get("lsarContents", []):
        name = (it.get("XADFileName") or "").strip()
        if not name:
            continue
        is_dir = bool(it.get("XADIsDirectory")) or name.endswith("/")
        size = int(it.get("XADFileSize") or 0)
        csize = int(it.get("XADCompressedSize") or 0)
        members.append((name.rstrip("/"), size, csize, is_dir))
    return members


def _rar_cmd(rar_path, dest_dir, password=""):
    """构造 unrar/unar 解压命令（解压全部或按名过滤由调用方追加参数）"""
    exe = _rar_bin()
    if not exe:
        raise RuntimeError("系统未安装 unrar，无法解压 RAR")
    if os.path.basename(exe) == "unrar":
        cmd = [exe, "x", "-y", "-o+"]
        if password:
            cmd.append("-p" + password)
        cmd += ["--", rar_path]
    else:
        cmd = [exe, "-f", "-o", dest_dir]
        if password:
            cmd += ["-p", password]
        cmd += ["--", rar_path]
    return cmd


def _rar_extract(rar_path, entry_name, dest_dir, password=""):
    """把 RAR 中单个成员解压到 dest_dir（保留相对路径），返回落盘路径"""
    cmd = _rar_cmd(rar_path, dest_dir, password)
    exe = cmd[0]
    if os.path.basename(exe) == "unrar":
        cmd += [entry_name, dest_dir + os.sep]
    else:
        cmd += [entry_name]
    proc = subprocess.run(cmd, capture_output=True, text=True, errors="replace",
                          stdin=subprocess.DEVNULL, timeout=120)
    if proc.returncode != 0:
        if password:
            raise RuntimeError("提取 RAR 成员失败：密码错误或缺失分卷")
        raise RuntimeError("RAR 需要密码")
    rel = entry_name.replace("\\", "/").lstrip("/")
    fpath = os.path.join(dest_dir, *rel.split("/"))
    if not os.path.isfile(fpath):
        raise RuntimeError("未找到 RAR 成员: " + entry_name)
    return fpath


def _rar_extract_all(rar_path, dest_dir, password=""):
    """把整个 RAR 解压到 dest_dir"""
    cmd = _rar_cmd(rar_path, dest_dir, password)
    cmd += [dest_dir + os.sep] if os.path.basename(cmd[0]) == "unrar" else []
    proc = subprocess.run(cmd, capture_output=True, text=True, errors="replace",
                          stdin=subprocess.DEVNULL, timeout=600)
    if proc.returncode != 0:
        if password:
            raise RuntimeError("解压 RAR 失败：密码错误或缺失分卷")
        raise RuntimeError("RAR 需要密码")





@bp.route("/api/zip/contents")
def api_zip_contents():
    """列出 zip 文件中的文件清单。可选参数 dir=xxx 只列出该子目录下的直接子项。"""
    _log.info("GET /api/zip/contents")
    zip_path = request.args.get("path", "")
    dir_param = request.args.get("dir", "")
    if not zip_path:
        return jsonify({"error": "未指定 zip 文件路径"}), 400
    zip_path = os.path.abspath(os.path.normpath(zip_path))
    if not os.path.isfile(zip_path):
        return jsonify({"error": "文件不存在"}), 400
    if not (zip_path.lower().endswith('.zip') or zip_path.lower().endswith('.rar')):
        return jsonify({"error": "不是 zip/rar 文件"}), 400
    dir_param = dir_param.strip().rstrip('/')
    lower = zip_path.lower()

    if lower.endswith('.rar'):
        try:
            members = _rar_members(zip_path, request.args.get("pwd", ""))
            entries = []
            seen_dirs = set()
            all_names = []
            all_file_sizes = {}
            all_compressed_sizes = {}
            for (name, size, csize, is_dir) in members:
                all_names.append(name)
                if not is_dir and name not in all_file_sizes:
                    all_file_sizes[name] = size
                    all_compressed_sizes[name] = csize
                if dir_param:
                    if not name.startswith(dir_param + '/'):
                        continue
                    rest = name[len(dir_param) + 1:]
                    if not rest:
                        continue
                    if '/' in rest:
                        top = rest.split('/')[0]
                        if top and top not in seen_dirs:
                            seen_dirs.add(top)
                            entries.append({"name": top, "size": 0, "compressed": 0,
                                            "is_dir": True, "icon": 'bi-folder-fill',
                                            "type": 'directory', "ext": ''})
                        continue
                elif '/' in name:
                    top = name.split('/')[0]
                    if top and top not in seen_dirs:
                        seen_dirs.add(top)
                        entries.append({"name": top, "size": 0, "compressed": 0,
                                        "is_dir": True, "icon": 'bi-folder-fill',
                                        "type": 'directory', "ext": ''})
                    continue
                display_name = (name[len(dir_param) + 1:]
                                if dir_param and name.startswith(dir_param + '/') else name)
                ext = (display_name.split('.')[-1] if '.' in display_name else '').lower()
                entries.append({
                    "name": display_name, "size": size, "compressed": csize,
                    "is_dir": is_dir, "icon": _ext_icon(ext),
                    "type": 'directory' if is_dir else 'file',
                    "ext": ext if not is_dir else '',
                })
            for e in entries:
                if e['is_dir']:
                    dir_name = e['name']
                    dir_path_full = (dir_param + '/' if dir_param else '') + dir_name
                    has_children = any(n.startswith(dir_path_full + '/') for n in all_names)
                    e['is_empty'] = not has_children
                    if not e['is_empty']:
                        e['size'] = sum(v for k, v in all_file_sizes.items()
                                        if k.startswith(dir_path_full + '/'))
                        e['compressed'] = sum(v for k, v in all_compressed_sizes.items()
                                              if k.startswith(dir_path_full + '/'))
            dedup = {}
            for e in entries:
                if e['name'] in dedup:
                    if e.get('is_empty') is False and dedup[e['name']].get('is_empty') is not False:
                        dedup[e['name']] = e
                    continue
                dedup[e['name']] = e
            entries = list(dedup.values())
            total_uncompressed = sum(e['size'] for e in entries if not e['is_dir'])
            return jsonify({
                "success": True,
                "zip_path": zip_path,
                "zip_name": os.path.basename(zip_path),
                "zip_size": os.path.getsize(zip_path),
                "zip_size_str": format_size_safe(os.path.getsize(zip_path)),
                "total_uncompressed": total_uncompressed,
                "total_uncompressed_str": format_size_safe(total_uncompressed),
                "entry_count": len(entries),
                "entries": entries,
            })
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    try:
        import zipfile
        entries = []
        seen_dirs = set()
        all_names = []  # 全量文件名列表（含完整路径），用于判断目录是否为空
        all_file_sizes = {}  # full_path -> file_size
        all_compressed_sizes = {}  # full_path -> compress_size
        with zipfile.ZipFile(zip_path, 'r') as zf:
            for info in zf.infolist():
                raw_name = _decode_zip_name(info)
                name = raw_name.rstrip('/')
                all_names.append(name)
                if not info.is_dir() and not raw_name.endswith('/'):
                    full_path = (dir_param + '/' if dir_param else '') + (name[len(dir_param) + 1:] if dir_param and name.startswith(dir_param + '/') else name)
                    if full_path not in all_file_sizes:
                        all_file_sizes[full_path] = info.file_size
                        all_compressed_sizes[full_path] = info.compress_size
                if dir_param:
                    if not name.startswith(dir_param + '/'):
                        continue
                    rest = name[len(dir_param) + 1:]
                    if not rest:
                        continue  # skip the parent directory entry itself
                    if '/' in rest:
                        top = rest.split('/')[0]
                        if top and top not in seen_dirs:
                            seen_dirs.add(top)
                            entries.append({
                                "name": top, "size": 0, "compressed": 0,
                                "is_dir": True, "icon": 'bi-folder-fill',
                                "type": 'directory', "ext": '',
                            })
                        continue
                elif '/' in raw_name:
                    top = raw_name.split('/')[0]
                    if top and top not in seen_dirs:
                        seen_dirs.add(top)
                        entries.append({
                            "name": top, "size": 0, "compressed": 0,
                            "is_dir": True, "icon": 'bi-folder-fill',
                            "type": 'directory', "ext": '',
                        })
                    continue
                # 处理直接子项（文件 or 顶层目录条目）
                size = info.file_size
                compressed = info.compress_size
                is_dir = info.is_dir()
                if is_dir:
                    icon = 'bi-folder-fill'
                    entry_type = 'directory'
                else:
                    ext = (raw_name.split('.')[-1] if '.' in raw_name else '').lower()
                    entry_type = 'file'
                    if ext in ('png','jpg','jpeg','gif','svg','webp'):
                        icon = 'bi-file-image'
                    elif ext in ('mp4','webm','mkv','avi','mov'):
                        icon = 'bi-file-play'
                    elif ext in ('mp3','wav','ogg','flac'):
                        icon = 'bi-file-music'
                    elif ext in ('zip','rar','7z','tar','gz'):
                        icon = 'bi-file-zip'
                    elif ext in ('py','js','ts','html','css','json','xml','md','txt','log','csv','sql','ini','yml'):
                        icon = 'bi-file-code'
                    elif ext in ('pdf',):
                        icon = 'bi-file-earmark-pdf'
                    else:
                        icon = 'bi-file-earmark'
                # 显示名：用相对路径（去掉已过滤的前缀）
                display_name = (name[len(dir_param) + 1:] if dir_param and name.startswith(dir_param + '/') else name)
                entries.append({
                    "name": display_name,
                    "size": size, "compressed": compressed,
                    "is_dir": is_dir, "icon": icon,
                    "type": entry_type,
                    "ext": ext if not is_dir else '',
                })
        zip_size = os.path.getsize(zip_path)
        # 为每个目录条目计算 is_empty + 递归大小
        for e in entries:
            if e['is_dir']:
                dir_name = e['name']
                dir_path_full = (dir_param + '/' if dir_param else '') + dir_name
                has_children = any(n.startswith(dir_path_full + '/') for n in all_names)
                e['is_empty'] = not has_children
                if not e['is_empty']:
                    e['size'] = sum(v for k, v in all_file_sizes.items() if k.startswith(dir_path_full + '/'))
                    e['compressed'] = sum(v for k, v in all_compressed_sizes.items() if k.startswith(dir_path_full + '/'))
        # 按名称去重（显式目录条目 + 虚拟目录条目同名时，保留非空的那个）
        dedup = {}
        for e in entries:
            if e['name'] in dedup:
                # 优先保留非空的
                if e.get('is_empty') is False and dedup[e['name']].get('is_empty') is not False:
                    dedup[e['name']] = e
                continue
            dedup[e['name']] = e
        entries = list(dedup.values())
        total_uncompressed = sum(e['size'] for e in entries if not e['is_dir'])
        return jsonify({
            "success": True,
            "zip_path": zip_path,
            "zip_name": os.path.basename(zip_path),
            "zip_size": zip_size,
            "zip_size_str": format_size_safe(zip_size),
            "total_uncompressed": total_uncompressed,
            "total_uncompressed_str": format_size_safe(total_uncompressed),
            "entry_count": len(entries),
            "entries": entries,
        })
    except zipfile.BadZipFile:
        return jsonify({"error": "无效的 zip 文件"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/api/zip/file")
def api_zip_file():
    """从 zip 文件中下载单个文件"""
    _log.info("GET /api/zip/file")
    zip_path = request.args.get("zip_path", "")
    entry_name = request.args.get("entry", "")
    if not zip_path or not entry_name:
        return jsonify({"error": "缺少参数"}), 400
    zip_path = os.path.abspath(os.path.normpath(zip_path))
    if not os.path.isfile(zip_path):
        return jsonify({"error": "zip 文件不存在"}), 400

    if zip_path.lower().endswith('.rar'):
        try:
            tmp = tempfile.mkdtemp(prefix="ziprar_")
            fpath = _rar_extract(zip_path, entry_name, tmp, request.args.get("pwd", ""))
            content_type, _ = mimetypes.guess_type(entry_name)
            content_type = content_type or 'application/octet-stream'
            download_name = entry_name.split('/')[-1] or entry_name
            if download_name.startswith('/') or download_name.startswith('\\'):
                download_name = download_name.lstrip('/\\')
            size = os.path.getsize(fpath)

            def _gen():
                with open(fpath, 'rb') as f:
                    while True:
                        b = f.read(512 * 1024)
                        if not b:
                            break
                        yield b
                shutil.rmtree(tmp, ignore_errors=True)

            resp = FlaskResponse(_gen(), mimetype=content_type)
            resp.headers['Content-Length'] = str(size)
            resp.headers['Content-Disposition'] = (
                f'attachment; filename*="UTF-8\'\'{quote(download_name)}"; filename="{quote(download_name)}"')
            return resp
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    try:
        import zipfile
        with zipfile.ZipFile(zip_path, 'r') as zf:
            try:
                info = _find_zip_info(zf, entry_name)
            except KeyError:
                return jsonify({"error": f"文件中没有: {entry_name}"}), 404
            if info.is_dir():
                return jsonify({"error": "目录无法下载"}), 400

            content_type, _ = mimetypes.guess_type(entry_name)
            content_type = content_type or 'application/octet-stream'
            download_name = _decode_zip_name(info)
            if download_name.startswith('/') or download_name.startswith('\\'):
                download_name = download_name.lstrip('/\\')

        # 流式解压：边读边发（512KB 块），内存占用恒定，GB 级成员也不会卡死
        def _gen():
            with zipfile.ZipFile(zip_path, 'r') as z:
                with z.open(info) as f:
                    remaining = info.file_size
                    while remaining > 0:
                        chunk = f.read(min(512 * 1024, remaining))
                        if not chunk:
                            break
                        remaining -= len(chunk)
                        yield chunk

        resp = FlaskResponse(_gen(), mimetype=content_type)
        resp.headers['Content-Length'] = str(info.file_size)
        resp.headers['Content-Disposition'] = f'attachment; filename*="UTF-8\'\'{quote(download_name)}"; filename="{quote(download_name)}"'
        return resp
    except zipfile.BadZipFile:
        return jsonify({"error": "无效的 zip 文件"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/api/zip/extract")
def api_zip_extract():
    """下载解压后的压缩包"""
    _log.info("GET /api/zip/extract")
    zip_path = request.args.get("zip_path", "")
    if not zip_path:
        return jsonify({"error": "缺少参数"}), 400
    zip_path = os.path.abspath(os.path.normpath(zip_path))
    if not os.path.isfile(zip_path):
        return jsonify({"error": "文件不存在"}), 400

    try:
        import zipfile
        import io
        with zipfile.ZipFile(zip_path, 'r') as zf:
            total = sum(i.file_size for i in zf.infolist() if not i.is_dir())
            if total > _ZIP_EXTRACT_LIMIT:
                return jsonify({
                    "error": f"解压后共 {format_size(total)}，超过在线处理上限（{format_size(_ZIP_EXTRACT_LIMIT)}），请直接下载压缩包或分批解压"
                }), 400
            # 重新打包，确保所有路径扁平化
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as out:
                for info in zf.infolist():
                    if info.filename.endswith('/') or info.filename.endswith('\\'):
                        continue
                    data = zf.read(info)
                    # 取最后一层文件名（解码修正，避免中文乱码）
                    base = os.path.basename(_decode_zip_name(info))
                    if not base:
                        base = 'unnamed_file'
                    out.writestr(base, data)
            buf.seek(0)
            zip_name = os.path.basename(zip_path).replace('.zip', '_extracted.zip')
            resp = FlaskResponse(buf.read(), mimetype='application/zip')
            resp.headers['Content-Disposition'] = f'attachment; filename*="UTF-8\'\'{quote(zip_name)}"; filename="{quote(zip_name)}"'
            return resp
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/api/zip/preview")
def api_zip_preview():
    """读取 zip 中单个文件（base64 内联，用于在线预览）"""
    _log.info("GET /api/zip/preview")
    zip_path = request.args.get("zip_path", "")
    entry_name = request.args.get("entry", "")
    if not zip_path or not entry_name:
        return jsonify({"error": "缺少参数"}), 400
    zip_path = os.path.abspath(os.path.normpath(zip_path))
    if not os.path.isfile(zip_path):
        return jsonify({"error": "zip 文件不存在"}), 400

    if zip_path.lower().endswith('.rar'):
        try:
            import base64
            tmp = tempfile.mkdtemp(prefix="ziprar_")
            try:
                fpath = _rar_extract(zip_path, entry_name, tmp, request.args.get("pwd", ""))
                size = os.path.getsize(fpath)
                if size > _ZIP_PREVIEW_LIMIT:
                    return jsonify({
                        "error": f"文件过大（{format_size(size)}），无法在线预览，请下载后查看"
                    }), 400
                with open(fpath, 'rb') as f:
                    data = f.read()
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
            ext = (entry_name.split('.')[-1] if '.' in entry_name else '').lower()
            content_type, _ = mimetypes.guess_type(entry_name)
            content_type = content_type or 'application/octet-stream'
            return jsonify({
                "success": True,
                "ext": ext,
                "content_type": content_type,
                "size": len(data),
                "size_str": format_size(len(data)),
                "content": base64.b64encode(data).decode("utf-8"),
            })
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    try:
        import zipfile
        import base64
        with zipfile.ZipFile(zip_path, 'r') as zf:
            try:
                info = _find_zip_info(zf, entry_name)
            except KeyError:
                return jsonify({"error": f"文件中没有: {entry_name}"}), 404
            if info.is_dir():
                return jsonify({"error": "目录无法预览"}), 400
            if info.file_size > _ZIP_PREVIEW_LIMIT:
                return jsonify({
                    "error": f"文件过大（{format_size(info.file_size)}），无法在线预览，请下载后查看"
                }), 400
            data = zf.read(entry_name)
            ext = (info.filename.split('.')[-1] if '.' in info.filename else '').lower()
            content_type, _ = mimetypes.guess_type(entry_name)
            content_type = content_type or 'application/octet-stream'
            return jsonify({
                "success": True,
                "ext": ext,
                "content_type": content_type,
                "size": len(data),
                "size_str": format_size(len(data)),
                "content": base64.b64encode(data).decode("utf-8"),
            })
    except zipfile.BadZipFile:
        return jsonify({"error": "无效的 zip 文件"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/api/zip/create", methods=["POST"])
def api_zip_create():
    """把多个文件/目录压缩为一个 zip 文件，保存在目标目录（默认为父目录）"""
    _log.info("POST /api/zip/create")
    data = request.get_json()
    if not data:
        return jsonify({"error": "无效请求"}), 400
    paths = data.get("paths", [])
    if not paths:
        return jsonify({"error": "未指定要压缩的文件"}), 400
    dest_dir = data.get("dest_dir", "")
    name_hint = (data.get("name", "") or "压缩包").strip()
    if not dest_dir or not os.path.isdir(dest_dir):
        dest_dir = os.path.abspath(os.path.normpath(paths[0]))
        while dest_dir and os.path.isfile(dest_dir):
            dest_dir = os.path.dirname(dest_dir)
        if not os.path.isdir(dest_dir):
            return jsonify({"error": "无法确定保存目录"}), 400

    # 校验每个路径存在且不能把 zip 自身压缩进去
    abs_paths = []
    for p in paths:
        ap = os.path.abspath(os.path.normpath(p))
        if not os.path.exists(ap):
            return jsonify({"error": f"路径不存在: {p}"}), 400
        abs_paths.append(ap)

    # 生成目标 zip 文件名（避免同名冲突）
    if not name_hint or name_hint.endswith('.zip'):
        base = name_hint
    else:
        base = name_hint + ".zip"
    if not base.endswith('.zip'):
        base += '.zip'
    target = os.path.join(dest_dir, base)
    if not target.endswith('.zip'):
        target += '.zip'
    counter = 1
    while os.path.exists(target):
        target = os.path.join(dest_dir, f"{base[:-4]}_{counter}.zip")
        counter += 1

    # 把目标也规范化，避免自身被压缩进自身
    target = os.path.abspath(target)

    try:
        import zipfile
        total = 0
        with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as zf:
            for ap in abs_paths:
                if os.path.isdir(ap):
                    for root, dirs, files in os.walk(ap):
                        for f in files:
                            fp = os.path.join(root, f)
                            arc = os.path.relpath(fp, os.path.dirname(ap))
                            zf.write(fp, arc)
                            total += 1
                else:
                    arc = os.path.relpath(ap, dest_dir)
                    zf.write(ap, arc)
                    total += 1
        _invalidate_list_cache(dest_dir)
        final_size = os.path.getsize(target)
        _add_archive_record("zip", os.path.basename(target), dest_dir,
                            "%d 个文件 · %s" % (total, format_size(final_size)))
        return jsonify({
            "success": True,
            "path": target,
            "name": os.path.basename(target),
            "size": final_size,
            "size_str": format_size(final_size),
            "files": total,
        })
    except Exception as e:
        try:
            if os.path.exists(target):
                os.remove(target)
        except OSError:
            pass
        return jsonify({"error": str(e)}), 500


# ---------- 实时压缩进度（任务制） ----------
_ZIP_CREATE_TASKS = {}
_ZIP_CREATE_LOCK = threading.Lock()


def _zip_create_worker(task_id, target, file_list, dest_dir):
    """后台线程：逐个文件写入 zip，实时更新进度。"""
    task = _ZIP_CREATE_TASKS.get(task_id)
    if not task:
        return
    try:
        import zipfile
        with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as zf:
            for fp, arc in file_list:
                with _ZIP_CREATE_LOCK:
                    task["current"] = arc
                    base = task["done_bytes"]
                try:
                    size = os.path.getsize(fp)
                except OSError:
                    size = 0
                try:
                    zf.write(fp, arc)
                except Exception:
                    # 单个文件失败不中断整体
                    with _ZIP_CREATE_LOCK:
                        task["errors"].append("跳过: " + arc)
                        task["done_files"] += 1
                        task["done_bytes"] = base + size
                    continue
                with _ZIP_CREATE_LOCK:
                    task["done_files"] += 1
                    task["done_bytes"] = base + size
        final_size = os.path.getsize(target)
        _invalidate_list_cache(dest_dir)
        total = task["done_files"]
        _add_archive_record("zip", os.path.basename(target), dest_dir,
                            "%d 个文件 · %s" % (total, format_size(final_size)))
        with _ZIP_CREATE_LOCK:
            task["status"] = "done"
            task["result"] = {"path": target, "name": os.path.basename(target),
                              "files": total, "size": final_size,
                              "size_str": format_size(final_size)}
    except Exception as e:
        try:
            if os.path.exists(target):
                os.remove(target)
        except OSError:
            pass
        with _ZIP_CREATE_LOCK:
            task["status"] = "error"
            task["error"] = str(e)


@bp.route("/api/zip/create/start", methods=["POST"])
def api_zip_create_start():
    """启动异步压缩任务，返回 task_id 供前端轮询实时进度（可挂后台）。"""
    _log.info("POST /api/zip/create/start")
    data = request.get_json(silent=True) or {}
    paths = data.get("paths", [])
    if not paths:
        return jsonify({"error": "未指定要压缩的文件"}), 400
    dest_dir = data.get("dest_dir", "")
    name_hint = (data.get("name", "") or "压缩包").strip()
    if not dest_dir or not os.path.isdir(dest_dir):
        dest_dir = os.path.abspath(os.path.normpath(paths[0]))
        while dest_dir and os.path.isfile(dest_dir):
            dest_dir = os.path.dirname(dest_dir)
        if not os.path.isdir(dest_dir):
            return jsonify({"error": "无法确定保存目录"}), 400

    abs_paths = []
    for p in paths:
        ap = os.path.abspath(os.path.normpath(p))
        if not os.path.exists(ap):
            return jsonify({"error": f"路径不存在: {p}"}), 400
        abs_paths.append(ap)

    # 生成目标 zip 文件名（避免同名冲突）
    if name_hint.lower().endswith('.zip'):
        name_hint = name_hint[:-4]
    base = (name_hint or "压缩包") + ".zip"
    target = os.path.join(dest_dir, base)
    counter = 1
    while os.path.exists(target):
        target = os.path.join(dest_dir, f"{base[:-4]}_{counter}.zip")
        counter += 1
    target = os.path.abspath(target)

    # 收集文件清单 + 统计总量（仅 stat，开销小）
    file_list = []
    total_files, total_bytes = 0, 0
    try:
        for ap in abs_paths:
            if os.path.isdir(ap):
                for root, dirs, files in os.walk(ap):
                    for f in files:
                        fp = os.path.join(root, f)
                        if fp == target:
                            continue
                        arc = os.path.relpath(fp, os.path.dirname(ap))
                        try:
                            sz = os.path.getsize(fp)
                        except OSError:
                            sz = 0
                        file_list.append((fp, arc))
                        total_files += 1
                        total_bytes += sz
            else:
                if ap == target:
                    continue
                arc = os.path.relpath(ap, dest_dir)
                try:
                    sz = os.path.getsize(ap)
                except OSError:
                    sz = 0
                file_list.append((ap, arc))
                total_files += 1
                total_bytes += sz
    except Exception as e:
        return jsonify({"error": "扫描文件失败: " + str(e)}), 400
    if not file_list:
        return jsonify({"error": "没有可压缩的文件"}), 400

    task_id = uuid.uuid4().hex[:16]
    with _ZIP_CREATE_LOCK:
        now = time.time()
        for k in [k for k, v in _ZIP_CREATE_TASKS.items() if now - v.get("started_at", 0) > 1800]:
            _ZIP_CREATE_TASKS.pop(k, None)
        _ZIP_CREATE_TASKS[task_id] = {
            "status": "running", "total_files": total_files, "total_bytes": total_bytes,
            "done_files": 0, "done_bytes": 0, "current": "", "error": "",
            "errors": [], "started_at": time.time(),
        }
    threading.Thread(target=_zip_create_worker,
                     args=(task_id, target, file_list, dest_dir), daemon=True).start()
    return jsonify({"success": True, "task_id": task_id,
                    "total_files": total_files, "total_bytes": total_bytes})


@bp.route("/api/zip/create/progress")
def api_zip_create_progress():
    """查询压缩任务实时进度（与解压进度接口结构一致）。"""
    task_id = request.args.get("task_id", "")
    with _ZIP_CREATE_LOCK:
        task = _ZIP_CREATE_TASKS.get(task_id)
        if not task:
            return jsonify({"error": "任务不存在或已过期"}), 404
        snap = dict(task)
    total_bytes = snap.get("total_bytes") or 0
    done_bytes = min(snap.get("done_bytes") or 0, total_bytes)
    total_files = snap.get("total_files") or 0
    done_files = min(snap.get("done_files") or 0, total_files)
    if total_bytes > 0:
        percent = done_bytes / total_bytes * 100
    elif total_files > 0:
        percent = done_files / total_files * 100
    else:
        percent = 100 if snap["status"] != "running" else 0
    return jsonify({
        "status": snap["status"], "current": snap.get("current", ""),
        "done_files": done_files, "total_files": total_files,
        "done_bytes": done_bytes, "total_bytes": total_bytes,
        "percent": round(percent, 1),
        "errors": snap.get("errors", []) or ([snap["error"]] if snap.get("error") else []),
        "result": snap.get("result"),
    })


@bp.route("/api/zip/unzip", methods=["POST"])
def api_zip_unzip():
    """解压 zip 到磁盘：流式逐成员写盘（内存占用恒定，GB 级压缩包也不会卡死）。"""
    _log.info("POST /api/zip/unzip")
    data = request.get_json(silent=True) or {}
    zip_path = os.path.abspath(os.path.normpath((data.get("path") or "").strip()))
    if not zip_path.lower().endswith(".zip") or not os.path.isfile(zip_path):
        return jsonify({"error": "不是有效的 zip 文件"}), 400

    dest_dir = (data.get("dest_dir") or "").strip() or os.path.dirname(zip_path)
    dest_dir = os.path.abspath(os.path.normpath(dest_dir))
    if not os.path.isdir(dest_dir):
        return jsonify({"error": "目标目录不存在"}), 400

    name_hint = (data.get("name") or "").strip() or os.path.basename(zip_path)[:-4] or "解压结果"
    target = os.path.join(dest_dir, name_hint)
    counter = 1
    while os.path.exists(target):
        target = os.path.join(dest_dir, "%s_%d" % (name_hint, counter))
        counter += 1
    target = os.path.abspath(target)
    target_prefix = target + os.sep

    try:
        import zipfile
        count = 0
        with zipfile.ZipFile(zip_path, 'r') as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                # 防路径穿越：仅允许落在 target 内的相对路径（用解码后的名字，中文不乱码）
                rel = _decode_zip_name(info).replace('\\', '/').lstrip('/')
                if (not rel or rel == '..' or rel.startswith('../') or '/../' in rel
                        or os.path.isabs(rel)):
                    continue
                dest_file = os.path.abspath(os.path.join(target, rel))
                if dest_file != target and not dest_file.startswith(target_prefix):
                    continue
                os.makedirs(os.path.dirname(dest_file), exist_ok=True)
                with zf.open(info) as src, open(dest_file, 'wb') as out:
                    remaining = info.file_size
                    while remaining > 0:
                        chunk = src.read(min(512 * 1024, remaining))
                        if not chunk:
                            break
                        out.write(chunk)
                        remaining -= len(chunk)
                count += 1
        _invalidate_list_cache(target)
        _invalidate_list_cache(dest_dir)
        _add_archive_record("unzip", os.path.basename(target), dest_dir, "%d 个文件" % count)
        return jsonify({
            "success": True, "path": target, "name": os.path.basename(target), "files": count,
        })
    except zipfile.BadZipFile:
        return jsonify({"error": "无效的 zip 文件"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/api/zip/unzip/start", methods=["POST"])
def api_zip_unzip_start():
    """启动异步解压任务，返回 task_id 供前端轮询实时进度（可挂后台）"""
    _log.info("POST /api/zip/unzip/start")
    data = request.get_json(silent=True) or {}
    zip_path = os.path.abspath(os.path.normpath((data.get("path") or "").strip()))
    lower = zip_path.lower()
    is_zip = lower.endswith(".zip") and os.path.isfile(zip_path)
    is_rar = lower.endswith(".rar") and os.path.isfile(zip_path)
    if is_rar and not _unrar_bin():
        return jsonify({"error": "系统未安装 unrar，无法解压 RAR"}), 400
    if not (is_zip or is_rar) or not os.path.isfile(zip_path):
        return jsonify({"error": "不是有效的 zip/rar 文件"}), 400
    dest_dir = (data.get("dest_dir") or "").strip() or os.path.dirname(zip_path)
    dest_dir = os.path.abspath(os.path.normpath(dest_dir))
    if not os.path.isdir(dest_dir):
        return jsonify({"error": "目标目录不存在"}), 400
    name_hint = (data.get("name") or "").strip() or os.path.basename(zip_path)[:-4] or "解压结果"
    password = (data.get("password") or "").strip()
    target = os.path.join(dest_dir, name_hint)
    counter = 1
    while os.path.exists(target):
        target = os.path.join(dest_dir, "%s_%d" % (name_hint, counter))
        counter += 1
    target = os.path.abspath(target)
    # 仅读目录统计总字节与成员文件数（不解码，开销小），用于进度计算
    if is_rar:
        total_files, total_bytes = 0, 0
        exe = shutil.which("unrar")
        if exe:
            try:
                lb = [exe, "lb"]
                if password:
                    lb.append("-p" + password)
                lb += ["--", zip_path]
                out = subprocess.run(lb, capture_output=True,
                                     text=True, errors="replace", timeout=30,
                                     stdin=subprocess.DEVNULL)
                total_files = sum(1 for ln in out.stdout.splitlines() if ln.strip())
            except Exception:
                total_files = 0
        task_id = uuid.uuid4().hex[:16]
        with _UNZIP_LOCK:
            _UNZIP_TASKS[task_id] = {
                "status": "running", "total_files": total_files, "total_bytes": total_bytes,
                "done_files": 0, "done_bytes": 0, "current": "", "error": "",
                "started_at": time.time(),
            }
        threading.Thread(target=_rar_worker, args=(task_id, zip_path, target, dest_dir, password), daemon=True).start()
        return jsonify({"success": True, "task_id": task_id,
                        "total_files": total_files, "total_bytes": total_bytes})
    try:
        import zipfile
        total_files, total_bytes = 0, 0
        with zipfile.ZipFile(zip_path, 'r') as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                rel = _decode_zip_name(info).replace('\\', '/').lstrip('/')
                if (not rel or rel == '..' or rel.startswith('../') or '/../' in rel
                        or os.path.isabs(rel)):
                    continue
                total_files += 1
                total_bytes += info.file_size
    except zipfile.BadZipFile:
        return jsonify({"error": "无效的 zip 文件"}), 400
    task_id = uuid.uuid4().hex[:16]
    with _UNZIP_LOCK:
        now = time.time()
        for k in [k for k, v in _UNZIP_TASKS.items() if now - v.get("started_at", 0) > 1800]:
            _UNZIP_TASKS.pop(k, None)
        _UNZIP_TASKS[task_id] = {
            "status": "running", "total_files": total_files, "total_bytes": total_bytes,
            "done_files": 0, "done_bytes": 0, "current": "", "error": "",
            "started_at": time.time(),
        }
    threading.Thread(target=_unzip_worker, args=(task_id, zip_path, target, dest_dir), daemon=True).start()
    return jsonify({"success": True, "task_id": task_id,
                    "total_files": total_files, "total_bytes": total_bytes})


@bp.route("/api/zip/unzip/progress")
def api_zip_unzip_progress():
    """查询解压任务实时进度"""
    task_id = request.args.get("task_id", "")
    with _UNZIP_LOCK:
        task = _UNZIP_TASKS.get(task_id)
        if not task:
            return jsonify({"error": "任务不存在或已过期"}), 404
        snap = dict(task)
    total_bytes = snap.get("total_bytes") or 0
    done_bytes = min(snap.get("done_bytes") or 0, total_bytes)
    total_files = snap.get("total_files") or 0
    done_files = min(snap.get("done_files") or 0, total_files)
    if total_bytes > 0:
        percent = done_bytes / total_bytes * 100
    elif total_files > 0:
        percent = done_files / total_files * 100
    else:
        percent = 100 if snap["status"] != "running" else 0
    return jsonify({
        "status": snap["status"], "current": snap.get("current", ""),
        "done_files": done_files, "total_files": total_files,
        "done_bytes": done_bytes, "total_bytes": total_bytes,
        "percent": round(percent, 1),
        "errors": [snap["error"]] if snap.get("error") else [],
        "result": snap.get("result"),
    })


def _nested_unzip_worker(task_id, outer_data, member_name, target, dest_dir):
    """解压嵌套 zip（外层包内的 zip 成员）到磁盘：外层成员已在内存，逐成员流式写盘"""
    task = _UNZIP_TASKS.get(task_id)
    if not task:
        return
    try:
        import zipfile
        import io
        count = 0
        target_prefix = target + os.sep
        with zipfile.ZipFile(io.BytesIO(outer_data), 'r') as inner:
            for info in inner.infolist():
                if info.is_dir():
                    continue
                rel = _decode_zip_name(info).replace('\\', '/').lstrip('/')
                if (not rel or rel == '..' or rel.startswith('../') or '/../' in rel
                        or os.path.isabs(rel)):
                    continue
                dest_file = os.path.abspath(os.path.join(target, rel))
                if dest_file != target and not dest_file.startswith(target_prefix):
                    continue
                os.makedirs(os.path.dirname(dest_file), exist_ok=True)
                size = info.file_size
                with inner.open(info) as src, open(dest_file, 'wb') as out:
                    remaining = size
                    while remaining > 0:
                        chunk = src.read(min(512 * 1024, remaining))
                        if not chunk:
                            break
                        out.write(chunk)
                        remaining -= len(chunk)
                        with _UNZIP_LOCK:
                            task["done_bytes"] += len(chunk)
                    with _UNZIP_LOCK:
                        task["done_files"] += 1
                        task["current"] = rel
                count += 1
        _invalidate_list_cache(target)
        _invalidate_list_cache(dest_dir)
        with _UNZIP_LOCK:
            task["status"] = "done"
            task["result"] = {"path": target, "name": os.path.basename(target), "files": count}
        _add_archive_record("unzip-nested", member_name, dest_dir, "%d 个文件" % count)
    except zipfile.BadZipFile:
        with _UNZIP_LOCK:
            task["status"] = "error"
            task["error"] = "嵌套文件不是有效的 zip 文件"
    except Exception as e:
        with _UNZIP_LOCK:
            task["status"] = "error"
            task["error"] = str(e)


@bp.route("/api/zip/nested/unzip/start", methods=["POST"])
def api_zip_nested_unzip_start():
    """把外层 zip 内的某个 zip 成员单独解压到磁盘（异步任务，进度复用 /api/zip/unzip/progress）"""
    _log.info("POST /api/zip/nested/unzip/start")
    data = request.get_json(silent=True) or {}
    zip_path = os.path.abspath(os.path.normpath((data.get("path") or data.get("zip_path") or "").strip()))
    outer_entry = (data.get("outer_entry") or "").strip()
    if not outer_entry:
        entry = (data.get("entry") or "").strip()
        outer_entry = entry.split('/', 1)[0] if entry else ""
    if not zip_path or not outer_entry:
        return jsonify({"error": "缺少参数"}), 400
    if not zip_path.lower().endswith('.zip') or not os.path.isfile(zip_path):
        return jsonify({"error": "外层不是有效的 zip 文件"}), 400
    dest_dir = (data.get("dest_dir") or "").strip() or os.path.dirname(zip_path)
    dest_dir = os.path.abspath(os.path.normpath(dest_dir))
    if not os.path.isdir(dest_dir):
        return jsonify({"error": "目标目录不存在"}), 400

    try:
        import zipfile
        with zipfile.ZipFile(zip_path, 'r') as zf:
            try:
                outer_info = _find_zip_info(zf, outer_entry)
            except KeyError:
                return jsonify({"error": f"文件中没有: {outer_entry}"}), 404
            if outer_info.file_size > _ZIP_NESTED_LIMIT:
                return jsonify({
                    "error": f"嵌套压缩包过大（{format_size(outer_info.file_size)}），无法解压"
                }), 400
            outer_data = zf.read(outer_info)
            member_name = _decode_zip_name(outer_info)
        with zipfile.ZipFile(io.BytesIO(outer_data), 'r') as inner:
            members = [i for i in inner.infolist() if not i.is_dir()]
            total_files = len(members)
            total_bytes = sum(i.file_size for i in members)
    except zipfile.BadZipFile:
        return jsonify({"error": "嵌套文件不是有效的 zip 文件"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    name_hint = (data.get("name") or "").strip() or member_name
    if name_hint.lower().endswith('.zip'):
        name_hint = name_hint[:-4]
    name_hint = (name_hint or "解压结果").replace('/', '_')
    target = os.path.join(dest_dir, name_hint)
    counter = 1
    while os.path.exists(target):
        target = os.path.join(dest_dir, "%s_%d" % (name_hint, counter))
        counter += 1
    target = os.path.abspath(target)

    task_id = uuid.uuid4().hex[:16]
    with _UNZIP_LOCK:
        now = time.time()
        for k in [k for k, v in _UNZIP_TASKS.items() if now - v.get("started_at", 0) > 1800]:
            _UNZIP_TASKS.pop(k, None)
        _UNZIP_TASKS[task_id] = {
            "status": "running", "total_files": total_files, "total_bytes": total_bytes,
            "done_files": 0, "done_bytes": 0, "current": "", "error": "",
            "started_at": time.time(),
        }
    threading.Thread(target=_nested_unzip_worker,
                     args=(task_id, outer_data, member_name, target, dest_dir),
                     daemon=True).start()
    return jsonify({"success": True, "task_id": task_id,
                    "total_files": total_files, "total_bytes": total_bytes})


@bp.route("/api/zip/nested")
def api_zip_nested():
    """把 zip 内的某个文件当作 zip 读取，返回其目录清单（用于嵌套压缩包查看）。
    entry 格式: outer_entry[/inner_subdir]，例如 hello.zip/sub 表示查看 hello.zip 内 sub 目录下的文件。"""
    _log.info("GET /api/zip/nested")
    zip_path = request.args.get("zip_path", "")
    entry = request.args.get("entry", "")
    # 优先使用显式参数：outer_entry=外层成员完整路径（可含 /），inner_dir=嵌套包内子目录。
    # 旧的 entry=outer_entry/inner_sub 拼接格式无法区分「成员名带 /」的情况，已废弃。
    outer_entry = (request.args.get("outer_entry") or "").strip()
    inner_dir = (request.args.get("inner_dir") or "").strip().rstrip('/')
    if not outer_entry and entry:
        parts = entry.split('/', 1)
        outer_entry = parts[0]
        inner_dir = (parts[1] if len(parts) > 1 else '').rstrip('/')
    if not zip_path or not outer_entry:
        return jsonify({"error": "缺少参数"}), 400
    zip_path = os.path.abspath(os.path.normpath(zip_path))
    if not os.path.isfile(zip_path):
        return jsonify({"error": "zip 文件不存在"}), 400

    try:
        import zipfile
        import io
        with zipfile.ZipFile(zip_path, 'r') as zf:
            try:
                outer_info = _find_zip_info(zf, outer_entry)
            except KeyError:
                return jsonify({"error": f"文件中没有: {outer_entry}"}), 404
            if outer_info.file_size > _ZIP_NESTED_LIMIT:
                return jsonify({
                    "error": f"嵌套压缩包过大（{format_size(outer_info.file_size)}），无法在线查看"
                }), 400
            data = zf.read(outer_info)

        entries = []
        prefix = inner_dir + '/' if inner_dir else ''
        zip_size = len(data)
        seen_dirs = set()
        all_inner_names = []
        inner_file_sizes = {}
        inner_compressed_sizes = {}
        with zipfile.ZipFile(io.BytesIO(data), 'r') as inner:
            for info in inner.infolist():
                name = info.filename
                all_inner_names.append(name.rstrip('/'))
                if not info.is_dir() and not info.filename.endswith('/'):
                    rel = name[len(prefix):] if name.startswith(prefix) else name
                    if rel not in inner_file_sizes:
                        inner_file_sizes[rel] = info.file_size
                        inner_compressed_sizes[rel] = info.compress_size
                if not name.startswith(prefix):
                    continue
                rest = name[len(prefix):]
                if not rest:
                    continue  # skip the parent directory entry itself
                # 只有确实还有更深路径时，才收集虚拟目录
                if '/' in rest:
                    top = rest.split('/')[0]
                    if top and top not in seen_dirs:
                        seen_dirs.add(top)
                        entries.append({
                            "name": top,
                            "size": 0,
                            "compressed": 0,
                            "is_dir": True,
                            "icon": 'bi-folder-fill',
                            "type": 'directory',
                            "ext": '',
                        })
                    continue  # only show direct children
                size = info.file_size
                compressed = info.compress_size
                is_dir = info.is_dir()
                if is_dir:
                    icon = 'bi-folder-fill'
                    entry_type = 'directory'
                else:
                    ext = (name.split('.')[-1] if '.' in name else '').lower()
                    entry_type = 'file'
                    if ext in ('png','jpg','jpeg','gif','svg','webp'):
                        icon = 'bi-file-image'
                    elif ext in ('mp4','webm','mkv','avi','mov'):
                        icon = 'bi-file-play'
                    elif ext in ('mp3','wav','ogg','flac'):
                        icon = 'bi-file-music'
                    elif ext in ('zip','rar','7z','tar','gz'):
                        icon = 'bi-file-zip'
                    elif ext in ('py','js','ts','html','css','json','xml','md','txt','log','csv','sql','ini','yml'):
                        icon = 'bi-file-code'
                    elif ext in ('pdf',):
                        icon = 'bi-file-earmark-pdf'
                    else:
                        icon = 'bi-file-earmark'
                entries.append({
                    "name": rest,
                    "size": size,
                    "compressed": compressed,
                    "is_dir": is_dir,
                    "icon": icon,
                    "type": entry_type,
                    "ext": ext if not is_dir else '',
                })
        # 计算 is_empty + 递归大小（成员名是完整路径，需拼上当前内层目录前缀）
        for e in entries:
            if e['is_dir']:
                dir_path_full = prefix + e['name']
                has_children = any(n.startswith(dir_path_full + '/') for n in all_inner_names)
                e['is_empty'] = not has_children
                if not e['is_empty']:
                    e['size'] = sum(v for k, v in inner_file_sizes.items() if k.startswith(dir_path_full + '/'))
                    e['compressed'] = sum(v for k, v in inner_compressed_sizes.items() if k.startswith(dir_path_full + '/'))
        # 按名称去重（显式目录条目 + 虚拟目录条目同名时，保留非空的那个）
        dedup = {}
        for e in entries:
            if e['name'] in dedup:
                if e.get('is_empty') is False and dedup[e['name']].get('is_empty') is not False:
                    dedup[e['name']] = e
                continue
            dedup[e['name']] = e
        entries = list(dedup.values())
        total_uncompressed = sum(e['size'] for e in entries if not e['is_dir'])
        return jsonify({
            "success": True,
            "zip_name": os.path.basename(outer_entry),
            "zip_size": zip_size,
            "zip_size_str": format_size_safe(zip_size),
            "total_uncompressed": total_uncompressed,
            "total_uncompressed_str": format_size_safe(total_uncompressed),
            "entry_count": len(entries),
            "entries": entries,
        })
    except zipfile.BadZipFile:
        return jsonify({"error": "嵌套文件不是有效的 zip 文件"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/api/zip/nested/preview")
def api_zip_nested_preview():
    """读取嵌套 zip 内单个文件（base64 内联）。entry 格式: outer_entry/inner_path"""
    _log.info("GET /api/zip/nested/preview")
    zip_path = request.args.get("zip_path", "")
    entry = request.args.get("entry", "")
    outer_entry = (request.args.get("outer_entry") or "").strip()
    inner_name = (request.args.get("inner_path") or "").strip()
    if not outer_entry and entry:
        parts = entry.split('/', 1)
        outer_entry = parts[0]
        inner_name = parts[1] if len(parts) > 1 else ''
    if not inner_name:
        inner_name = os.path.basename(outer_entry)
    if not zip_path or not outer_entry:
        return jsonify({"error": "缺少参数"}), 400
    zip_path = os.path.abspath(os.path.normpath(zip_path))
    if not os.path.isfile(zip_path):
        return jsonify({"error": "zip 文件不存在"}), 400
    try:
        import zipfile
        import io
        import base64
        with zipfile.ZipFile(zip_path, 'r') as zf:
            try:
                outer_info = _find_zip_info(zf, outer_entry)
            except KeyError:
                return jsonify({"error": f"文件中没有: {outer_entry}"}), 404
            if outer_info.file_size > _ZIP_NESTED_LIMIT:
                return jsonify({
                    "error": f"嵌套压缩包过大（{format_size(outer_info.file_size)}），无法在线查看"
                }), 400
            data = zf.read(outer_info)
        with zipfile.ZipFile(io.BytesIO(data), 'r') as inner:
            try:
                inner_info = inner.getinfo(inner_name)
            except KeyError:
                return jsonify({"error": f"嵌套 zip 中未找到: {inner_name}"}), 404
            if inner_info.file_size > _ZIP_PREVIEW_LIMIT:
                return jsonify({
                    "error": f"文件过大（{format_size(inner_info.file_size)}），无法在线预览，请下载后查看"
                }), 400
            inner_data = inner.read(inner_name)
            ext = (inner_name.split('.')[-1] if '.' in inner_name else '').lower()
            content_type, _ = mimetypes.guess_type(inner_name)
            content_type = content_type or 'application/octet-stream'
            return jsonify({
                "success": True,
                "ext": ext,
                "content_type": content_type,
                "size": len(inner_data),
                "size_str": format_size(len(inner_data)),
                "content": base64.b64encode(inner_data).decode("utf-8"),
            })
    except zipfile.BadZipFile:
        return jsonify({"error": "无效的 zip 文件"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/api/zip/nested/file")
def api_zip_nested_file():
    """从嵌套 zip 下载单个文件"""
    _log.info("GET /api/zip/nested/file")
    zip_path = request.args.get("zip_path", "")
    entry = request.args.get("entry", "")
    outer_entry = (request.args.get("outer_entry") or "").strip()
    inner_name = (request.args.get("inner_path") or "").strip()
    if not outer_entry and entry:
        parts = entry.split('/', 1)
        outer_entry = parts[0]
        inner_name = parts[1] if len(parts) > 1 else ''
    if not inner_name:
        inner_name = os.path.basename(outer_entry)
    if not zip_path or not outer_entry:
        return jsonify({"error": "缺少参数"}), 400
    zip_path = os.path.abspath(os.path.normpath(zip_path))
    if not os.path.isfile(zip_path):
        return jsonify({"error": "zip 文件不存在"}), 400
    try:
        import zipfile
        import io
        with zipfile.ZipFile(zip_path, 'r') as zf:
            try:
                outer_info = _find_zip_info(zf, outer_entry)
            except KeyError:
                return jsonify({"error": f"文件中没有: {outer_entry}"}), 404
            if outer_info.file_size > _ZIP_NESTED_LIMIT:
                return jsonify({
                    "error": f"嵌套压缩包过大（{format_size(outer_info.file_size)}），无法在线提取"
                }), 400
            data = zf.read(outer_info)
        with zipfile.ZipFile(io.BytesIO(data), 'r') as inner:
            try:
                inner_info = inner.getinfo(inner_name)
            except KeyError:
                return jsonify({"error": f"嵌套 zip 中未找到: {inner_name}"}), 404
            if inner_info.is_dir():
                return jsonify({"error": "目录无法下载"}), 400
            content_type, _ = mimetypes.guess_type(inner_name)
            content_type = content_type or 'application/octet-stream'

            # 内层文件流式解压（外层成员已驻留内存，不再复制内层明文）
            def _gen():
                with zipfile.ZipFile(io.BytesIO(data), 'r') as z:
                    with z.open(inner_info) as f:
                        remaining = inner_info.file_size
                        while remaining > 0:
                            chunk = f.read(min(512 * 1024, remaining))
                            if not chunk:
                                break
                            remaining -= len(chunk)
                            yield chunk

            resp = FlaskResponse(_gen(), mimetype=content_type)
            resp.headers['Content-Length'] = str(inner_info.file_size)
            resp.headers['Content-Disposition'] = f'attachment; filename*="UTF-8\'\'{quote(inner_name)}"; filename="{quote(inner_name)}"'
            return resp
    except zipfile.BadZipFile:
        return jsonify({"error": "无效的 zip 文件"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500
