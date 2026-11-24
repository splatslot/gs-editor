# GSEditor

**写真から作った 3D シーン（ガウシアンスプラッティング）をブラウザで開いて、ゴミを消し、原点と向きを直して、Blender でリライトできる状態にして保存するツールです。**

**インストールは要りません。ブラウザで開くだけ →** https://takumanakata.github.io/gs-editor/
（Chrome か Edge で。ファイルはブラウザの中だけで処理され、どこにも送られません）

![GSEditor](docs/editor.png)

## 使い方

1. **GS ファイル**（.ply / .spz / .splat / .ksplat）を画面にドロップ
2. **見る**：中ドラッグで回転、Shift＋中ドラッグで移動、ホイールで前後。右上のキューブで Top / Front / Right
3. **消す**：左の Select で左ドラッグして粒を選び（W で 箱／丸／投げ縄）、**X** で削除
4. **原点と向き**：**O** で原点にしたい場所をクリック → **Alt+G** で世界原点へ → **R** で回して水平に
5. 右下の **Export**。Blender 5.3 にそのまま立った状態で入る .ply になる

左上の **GSEditor** か **?** を押すと、画面の左に簡単な使い方が出ます。操作は Blender と同じです。G / R / S で移動・回転・スケール、`R` `Z` `90` ⏎ のような数値入力、Ctrl+Z で戻る。

## もう少し

| | |
|---|---|
| 選択 | Shift で追加、Ctrl で除外、A で全選択、Alt+A で解除、Ctrl+I で反転。丸は Shift＋ホイールで大きさ |
| 分ける | 粒を選んで **P**（右クリック → Separate Selection）。その部分が別のオブジェクトになる。**O** で原点、**F2** かダブルクリックで名前 |
| ビューで選ぶ | シーンの粒や Volume の線をクリックすると、それが選ばれる（Outliner で選ぶのと同じ） |
| Clip Volume | 左の箱／球ボタン。範囲の外（または内）を一時的に隠して、中を掃除しやすくする。書き出しには影響しない |
| 複数ファイル | 何枚でも読み込める。右の Outliner で切り替え、Export で1つのファイルにまとまる |
| Transform パネル | Blender と同じ Z-up の値。Ctrl+A（Apply Transform）で今の位置・向きを 0 にする |
| 書き出し | Each object → own file で、分けたオブジェクトを1つずつ別ファイルに。Keep で 50% / 25% / 10% に間引ける（大きく濃い粒を残す） |
| 形式 | 既定は **.ply — Blender (Z up)**：Blender 5.3 にそのまま立った状態で入る。UE のプラグインなどには .ply — standard 3DGS axes |
| リライト準備 | 読み込むと浮遊ゴミを自動で掃除し（Ctrl+Z で戻せる）、法線と光の焼き付き量を計算する。画面は焼き付きを弱めた色で、**Space を押している間**だけ撮影時の見た目。書き出す .ply には法線（relight_nx/ny/nz）と焼き付き量（baked_light）が入る |
| 上の軸 | Info → Up axis。Z up のファイルはたいてい自動で見分ける |
| 保存されるもの | 消した粒を除き、原点・向き・大きさを焼き込んだファイル。元の精度と色（SH）はそのまま。10GB 級のファイルでも OK |
| 大きいスキャン | 300万粒を超えると、自動で軽い表示（Light）に。選ぶ・消す・書き出しは全部の粒で行う。Info → Display: Full で全部描く |

ブラウザは何も記憶しません。リロードすると、ファイルそのままの状態から始まります。

---

MIT ライセンス（[LICENSE](LICENSE)）。中身は [three.js](https://threejs.org/)・[Spark](https://github.com/sparkjsdev/spark)・[@playcanvas/splat-transform](https://github.com/playcanvas/splat-transform)。
作る側のメモは [_dev/NOTES.md](_dev/NOTES.md)、変更履歴は [CHANGELOG.md](CHANGELOG.md)。
