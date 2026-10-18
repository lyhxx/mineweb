# packs/ — 材质包与蓝图

这个目录放两类纯数据文件，都不参与构建，`node tools/serve.mjs` 会直接当作静态资源提供。

## 材质包

一个材质包就是一个 `pack.json` 加上若干 PNG：

```
packs/my-pack/
├── pack.json
└── tiles/
    ├── stone.png
    └── grass_top.png
```

`pack.json` 只需要列出**要替换的**贴图，其余保持内置的程序化贴图：

```json
{
  "name": "My Pack",
  "tiles": {
    "stone": "tiles/stone.png",
    "grass/top": "tiles/grass_top.png",
    "cobblestone/east": "tiles/cobble_east.png"
  }
}
```

- 键是 `方块` 或 `方块/面`，面取 `north` `south` `west` `east` `top` `bottom`
- 相对路径相对 `pack.json` 解析
- 图片会被缩放到 16×16 且**不做平滑**，保持像素风；非正方形会被拉伸
- 单张贴图加载失败只影响那一格，不会让方块变透明

游戏内加载：

```
/pack http://127.0.0.1:8137/packs/my-pack/pack.json
/pack off          # 还原内置材质
```

## 蓝图

蓝图同样是纯 JSON，`/paste` 支持本地保存的名字、内置名字，或一个 URL：

```bash
node tools/ai-build.mjs "a 7x7 stone watchtower" packs/watchtower.json
```

```
/paste http://127.0.0.1:8137/packs/watchtower.json
/paste hut        # 内置示例
/save my_house    # 把身边 15x15x15 存进浏览器 localStorage
/bp               # 列出可用蓝图
```

格式说明见 `js/world/blueprint.js` 顶部注释，或 `tools/ai-build.mjs` 里的 schema。
