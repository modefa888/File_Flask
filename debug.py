#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Python 调试（Debug）练习代码

包含 5 个故意写错的用例，用于练习：
  - 打断点 / 条件断点
  - 单步执行（step over / step into）
  - 观察变量（watch / print）
  - 查看调用栈
  - 异常断点

用法：
    python debug_demo.py             # 运行全部用例
    python debug_demo.py 3           # 只运行第 3 个用例
    python -m pdb debug_demo.py 3    # 用 pdb 调试第 3 个用例

每个用例都会打印【预期结果】和【实际结果】，请找出并修复 bug。
"""

import sys
import traceback


# ---------------------------------------------------------------- 用例 1
def case_1():
    """Bug 类型：循环边界错误（off-by-one）"""
    numbers = [2, 5, 8, 11, 14]
    evens = []
    for i in range(1, len(numbers)):        # ← 注意起始下标
        if numbers[i] % 2 == 0:
            evens.append(numbers[i])

    print("预期: [2, 8, 14]")
    print("实际:", evens)


# ---------------------------------------------------------------- 用例 2
def case_2():
    """Bug 类型：整除 vs 真除法"""
    data = [10, 20, 30, 45]
    total = 0
    for x in data:
        total += x
    avg = total // len(data)                # ← 运算符可疑

    print("预期: 26.25")
    print("实际:", avg)


# ---------------------------------------------------------------- 用例 3
def factorial(n):
    """Bug 类型：递归基准条件不完整，会无限递归"""
    if n == 1:                              # ← 0! 的情况没处理
        return 1
    return n * factorial(n - 1)


def case_3():
    """Bug 类型：递归 / 栈溢出"""
    print("5! 预期: 120, 实际:", factorial(5))
    print("0! 预期: 1,   实际:", factorial(0))   # 这里会抛 RecursionError


# ---------------------------------------------------------------- 用例 4
def case_4():
    """Bug 类型：遍历容器的同时修改容器"""
    nums = [1, -2, 3, -4, 5, -6, -7]
    for x in nums:                          # ← 边遍历边 remove
        if x < 0:
            nums.remove(x)

    print("预期: [1, 3, 5]")
    print("实际:", nums)


# ---------------------------------------------------------------- 用例 5
def case_5():
    """Bug 类型：类型错误（str 与 int 混加）"""
    items = ["1", "2", "3", "4"]
    total = 0
    for s in items:
        total += s                          # ← 字符串拼接到 int 上

    print("预期: 10")
    print("实际:", total)


# ---------------------------------------------------------------- 主程序
CASES = {
    1: case_1,
    2: case_2,
    3: case_3,
    4: case_4,
    5: case_5,
}


def main():
    if len(sys.argv) > 1:
        try:
            idx = int(sys.argv[1])
        except ValueError:
            idx = -1
        if idx not in CASES:
            print(f"用法: python {sys.argv[0]} [1-5]")
            sys.exit(1)
        selected = [idx]
    else:
        selected = sorted(CASES)

    for i in selected:
        print("=" * 60)
        print(f"用例 {i}: {CASES[i].__doc__}")
        print("-" * 60)
        try:
            CASES[i]()
        except Exception:
            print("!! 运行出错：")
            traceback.print_exc()
    print("=" * 60)


if __name__ == "__main__":
    main()