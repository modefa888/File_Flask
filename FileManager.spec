# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包配置：将 Flask 文件管理器打包为单文件可执行。
构建命令：
    .venv/bin/pyinstaller FileManager.spec --noconfirm
产物：dist/FileManager，运行后自动打开浏览器。
"""
import os

project_root = os.path.abspath(os.curdir)

a = Analysis(
    ['run.py'],
    pathex=[project_root],
    binaries=[],
    # 模板为运行时渲染所需的非 Python 数据文件，必须打进包
    datas=[
        ('app/templates', 'app/templates'),
    ],
    hiddenimports=[],
    hookspath=[],
    runtime_hooks=[],
    excludes=['data', 'logs', '__pycache__', 'tests'],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='FileManager',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,          # 保留控制台窗口，便于查看服务地址与停止
    disable_windowed_traceback=False,
)