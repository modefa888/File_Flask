#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""文件管理可视化工具（重构版）启动入口。

    python run.py [--port 5000] [--no-browser]
"""
import argparse
import os
import sys
import threading
import webbrowser

from app import create_app, config


def open_browser(port: int) -> None:
    webbrowser.open(f"http://localhost:{port}")


def main() -> None:
    parser = argparse.ArgumentParser(description="文件管理可视化工具")
    parser.add_argument("--port", "-P", type=int, default=None, help="服务端口")
    parser.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    parser.add_argument("--debug", "-D", action="store_true",
                        help="调试模式：改动代码后自动重载，并显示交互式错误页")
    args = parser.parse_args()

    port = args.port or config.PORT
    debug = args.debug or config.DEBUG

    print(f"📁 默认起始路径: {config.DEFAULT_START_PATH}")
    print(f"🌐 服务地址: http://{config.HOST}:{port}（本机: http://localhost:{port}）")
    print("💡 在浏览器中可自由切换任意文件夹，路径会自动保存")
    print("按 Ctrl+C 停止服务")

    # 仅在“首次”启动时自动打开浏览器；重载子进程（WERKZEUG_RUN_MAIN）不再重复打开
    if not args.no_browser and os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        threading.Timer(1.0, open_browser, args=[port]).start()

    app = create_app()
    # 始终让模板改动即时生效：非 debug 模式下 Jinja 会缓存模板，
    # 改了 templates/*.html 却只刷新浏览器看不到效果，容易被误判为“修改无效”。
    app.config["TEMPLATES_AUTO_RELOAD"] = True
    try:
        app.run(host=config.HOST, port=port, debug=debug,
                use_reloader=debug, threaded=True)
    except KeyboardInterrupt:
        print("\n服务已停止")
    except OSError as e:
        if "Address already in use" in str(e):
            print(f"错误: 端口 {port} 已被占用，请使用 --port 指定其他端口")
        else:
            print(f"错误: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()