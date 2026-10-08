#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
定时任务测试脚本
用于验证调度器是否按时触发、日志是否正常、退出码是否正确。
"""

import argparse
import logging
import os
import random
import sys
import time
from datetime import datetime
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser(description="定时任务测试脚本")
    parser.add_argument(
        "--name",
        default=os.getenv("TASK_NAME", "task-test"),
        help="任务名称，默认读取环境变量 TASK_NAME",
    )
    parser.add_argument(
        "--duration",
        type=float,
        default=2.0,
        help="模拟工作时长（秒），默认 2 秒",
    )
    parser.add_argument(
        "--fail",
        action="store_true",
        help="强制任务失败，用于测试告警",
    )
    parser.add_argument(
        "--fail-rate",
        type=float,
        default=0.0,
        help="随机失败概率，0~1，例如 0.3 表示 30% 概率失败",
    )
    parser.add_argument(
        "--log-dir",
        default=os.getenv("TASK_LOG_DIR", "./logs"),
        help="日志目录，默认 ./logs",
    )
    return parser.parse_args()


def setup_logger(name: str, log_dir: str) -> logging.Logger:
    log_path = Path(log_dir)
    log_path.mkdir(parents=True, exist_ok=True)
    log_file = log_path / f"{datetime.now():%Y-%m-%d}.log"

    logger = logging.getLogger(name)
    logger.setLevel(logging.INFO)
    logger.handlers.clear()

    fmt = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # 输出到文件
    fh = logging.FileHandler(log_file, encoding="utf-8")
    fh.setFormatter(fmt)
    logger.addHandler(fh)

    # 输出到控制台，方便青龙面板 / cron 捕获
    ch = logging.StreamHandler(sys.stdout)
    ch.setFormatter(fmt)
    logger.addHandler(ch)

    return logger


def main() -> int:
    args = parse_args()
    logger = setup_logger(args.name, args.log_dir)

    start = time.time()
    logger.info("=" * 50)
    logger.info("任务开始: %s", args.name)
    logger.info("当前时间: %s", datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    logger.info("进程 PID: %s", os.getpid())
    logger.info("模拟工作时长: %.1f 秒", args.duration)

    try:
        # 模拟业务处理
        total = int(args.duration)
        for i in range(total):
            time.sleep(1)
            logger.info("处理中... %d/%d", i + 1, total)

        # 处理不足 1 秒的部分
        remainder = args.duration % 1
        if remainder:
            time.sleep(remainder)

        # 模拟失败
        if args.fail:
            raise RuntimeError("模拟任务失败（--fail）")

        if args.fail_rate > 0 and random.random() < args.fail_rate:
            raise RuntimeError(f"模拟随机失败（失败概率 {args.fail_rate}）")

        elapsed = time.time() - start
        logger.info("任务成功: %s，耗时 %.2f 秒", args.name, elapsed)
        return 0

    except Exception as e:
        elapsed = time.time() - start
        logger.exception("任务失败: %s，耗时 %.2f 秒，错误: %s", args.name, elapsed, e)
        return 1

    finally:
        logger.info("任务结束: %s", args.name)
        logger.info("=" * 50)


if __name__ == "__main__":
    sys.exit(main())