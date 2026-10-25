# -*- coding: utf-8 -*-
"""
task_script.py

只包含任务脚本：
  1. run_task() 返回 JSON 数据（多个字段）
  2. build_reply() 用这些字段生成自定义回复消息

定时任务框架只需要调用 run_task()，然后把返回值交给 build_reply() 即可。
"""

import json
from typing import Any, Dict, List


# ============================================================
# 1. 任务函数：返回 JSON 数据
# ============================================================
def run_task() -> Dict[str, Any]:
    """
    实际业务逻辑写在这里。
    返回 JSON 兼容的 dict；字段顺序就是回复模板里使用的顺序。
    如果框架要求直接返回 JSON 文本，改成：
        return json.dumps(data, ensure_ascii=False)
    """
    data = {
        "order_count": 128,
        "sales_amount": 35680.5,
        "error_count": 3,
        "hot_product": "无线耳机",
    }
    return data


# ============================================================
# 3. 本地直接运行测试
# ============================================================
if __name__ == "__main__":
    result = run_task()

    # 以 JSON 格式打印返回值
    print(json.dumps(result, ensure_ascii=False, indent=2))