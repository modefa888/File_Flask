  // ---------- 删除 ----------
  function doDelete(item) {
    confirmBox({
      title: "删除确认",
      message: "确定删除 “" + item.name + "” 吗？删除后可在回收站找回。",
      okText: "删除", danger: true,
      onOk: function () { doDeleteConfirmed(item); }
    });
  }
  function doDeleteConfirmed(item) {
    var abs = itemAbs(item);
    startDelete([abs], function () { localRemoveItems([abs]); });
  }
