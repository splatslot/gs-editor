# 開発メモ（GSEditor）

純静的サイト。`master` に push すると GitHub Actions（`.github/workflows/pages.yml`）がビルドして
GitHub Pages（https://takumanakata.github.io/gs-editor/）に出す。サーバー処理は無い。

```
_dev/web/     Vite + TypeScript + three.js + Spark(@sparkjsdev/spark) + @playcanvas/splat-transform
  src/main.ts            配線（オブジェクト／ボリューム／active の管理、ジェスチャ、キーボード、書き出し）
  src/ui/                Editor（外枠と右パネル）、TransformPanel、VolumePanel、NumField、IntakePanel、HistoryPanel
  src/viewer/            Scene（グリッド・平行投影の相棒カメラ・ビュー依存ガイド）、SplatScene（読む・描く）、
                         ScanData（1スキャン＝全粒＋Worker＋描く用のコピー）、scanWorker（全粒の選択・削除・クリップ）、half（float16 表）、
                         SceneFrame（原点＝pivot と Apply Transform の基準）、NavControls、ViewCube、startFrame
  src/export/exportGS.ts 書き出し（元ファイルを読み直して焼き込む）
docs/         README の画像
```

```bash
npm --prefix _dev/web install
npm --prefix _dev/web run dev        # 開発サーバー
npm --prefix _dev/web test           # vitest
npm --prefix _dev/web run typecheck  # tsc --noEmit
```

- `01_Assets/`（git 管理外）に GS ファイルを置くと、開発サーバーで `?gs=<ファイル名>` で直接開ける
- Pages の `base` は `/gs-editor/`。Git Bash から渡すとパス変換されるので `MSYS_NO_PATHCONV=1`
- Pages のランナーは `npm install`（ローカルの lock と `npm ci` が合わないことがあった）

## 設計上の要点

- **Blender のオブジェクトと同じモデル。** `SceneFrame` は自分の原点（`pivot`、root ローカル）を持ち、回転・拡縮はそれを中心に起きる。
  `base` は Apply Transform（Ctrl+A）の基準で、パネルはそこからの相対値を読み、焼き込まれる root の変換は変わらない
- `GsObject {id,name,source,mesh,frame,data,visible}` の一覧と `ClipVolume` の一覧。active は object か volume のどちらか
- **大きいスキャン（`ScanData`）**：ファイルは `PackedSplats` として CPU に読むだけ（`SplatScene.read`）。描くのは別のコピー（`SplatScene.add`）。
  `LIGHT_MAX`（300万）を超えると Light：不透明度×大きい2軸の面積が大きい順に 300万粒を選び（パック済みの対数スケールのバイトを
  そのまま使うヒストグラムで、ソートなし）、少し大きく（比率^(1/8)）描く。Full は全粒をそのまま描く（そのときは全粒の配列＝描く配列。
  Light に戻すとき元の語に戻してから選び直す）
- **全粒の判定は Worker（`scanWorker.ts`）**：中心の float16（6バイト/粒）と状態ビット（削除1・クリップ2・選択4）を持ち、投影
  （Int16 のピクセル座標）、箱／丸（複数点）／投げ縄、クリップ、削除・復元、エクスポート行、寸法用サンプルを全部ここでやる。返事には
  「描いている粒のうち変わったもの」だけが入り、画面側はパック済みの語を直接書き換える（色の語＝選択の橙、スケールの語＝0で非表示）。
  メッセージは順番に処理されるので、画面側は投げっぱなしにして最後だけ待てばよい（`settle()`）
- 実測（このPC、1000万粒）：読み込み〜操作可能 約5秒、投影 0.18秒、箱選択 0.27秒、削除 0.34秒、画面側の停止は最大 0.05秒。
  描画は Light（300万）で 60fps、Full（1000万）で 49fps
- 書き出し：画面上の変換は `SceneFrame.root` に掛かっている。`SplatScene.FILE_FLIP`（OpenCV Y-down → Y-up の 180° 反転）は
  ビューアの都合なので書き出し時には外す。元ファイルを `@playcanvas/splat-transform` で読み直し（`bakeFiles`、複数ファイルを
  1つにまとめる）、消した行を落とし、位置・回転・スケール・SH を変換して書く。読み直せない場合は表示データから書く（基本色のみ）。
  保存先は `showSaveFilePicker`（焼き込みの前に呼ぶ）、非対応ブラウザはダウンロード。既定は `.spz`
- ナビは Blender：MMB 回転（選択の重心か、カーソル下の面を中心）、Shift+MMB 移動（OrbitControls は Shift で ROTATE→PAN を
  自分で入れ替えるので、Ctrl だけ DOLLY に割り当てる）、ホイール前後。軸ビューは平行投影の相棒カメラ（`scene.ortho`）に切り替え、
  グリッドはビューで変わる（透視では薄い床、Top では濃い床、Front/Side では縦グリッドと高さの軸）
- ビューキューブは CSS 3D。面クリックでスナップ、ドラッグで `nav.rotateBy`。行列は F·R·F で鏡像を防ぐ
- ダブルクリックの寄りは Layouter と同じ規則（30%、遠ざからない）
- 開発用 URL：`?light=<描く上限>` で小さいファイルでも Light を試せる。`?thin=stride`（k個おき）／`?bump=<指数>` は比較用
- `viewer/startFrame.ts` は GSLayouter と同一ファイル（最初の画を揃えるため）。片方だけ変えないこと
- ブラウザには何も保存しない（以前あった sidecar／localStorage の記憶は撤去）。リロードでファイルそのままに戻る
- 見た目は design.md 準拠：暗い全面ビューにすりガラスのフローティング UI、`corner-shape: superellipse(2)`、IBM Plex、Tabler Icons。
  表示は英語（読み込みパネルと履歴の行だけ日本語）

## Separate と書き出し（0.5.0）

- **Separate**：選択した粒（`selectedIdx`）を `ScanData.extract` で新しい CPU の `PackedSplats` に写し（読み込んだままのワード：選択の色や
  削除の 0 は外す）、新しい `ScanData`＋Worker＋描画を作る。transform と原点は元のオブジェクトの `frame.toJSON()` をコピー。
  元からはその粒を削除扱い（`hideSelected`）にする。`source.rowMap` に「新しいオブジェクトの番号 → 元ファイルの行」を持たせ、
  書き出しはその行だけを元ファイルから読み直す
- 履歴：undo でオブジェクトを外し（`detachObject`、データは保持）、redo で戻す。`HistoryEntry.discard(applied)` で、undo 済みのまま
  履歴から落ちたときにデータと Worker を解放する
- **書き出し**：`what` = each（オブジェクトごとに別ファイル。`showDirectoryPicker` で保存先を1回だけ聞く）／ one（全部を1ファイル）／
  active。`keep` < 1 は `ScanData.thin`（Light と同じ「不透明度×面積」の上位）
- **2GB の壁**：Chromium は 2GB を超える File を `arrayBuffer()` で一括読みできない（1.9GB OK、2.2GB で NotReadableError）。
  PLY は `export/plyRows.ts` で 64MB ずつ `File.slice` して、必要な行だけ（連続する行はまとめて）新しい PLY に写してから
  splat-transform に渡す。.spz / .splat / .ksplat は小さいので従来どおり一括で読む
- 実測（このPC、合成 9.9GB・4000万粒・SH3）：読み込み 46秒、Separate 約1秒、277万粒の PLY 書き出し 40秒（686MB）、
  25% 間引き 18秒、SPZ 51秒（70MB）

## Blender 5.3 での確認（2026-11-24）

- `wm.ply_import`（GS を自動判別）と `wm.spz_import` で、POINTCLOUD（`radiance:sh_*` 属性付き）として入る。EEVEE / Cycles で描ける
- **PLY は軸を変換しない**：標準的な 3DGS の PLY（Y が下向き）は横倒しで入る。→ 0.6.0 で **.ply — Blender (Z up)** を追加（既定）：
  書き出しの行列を `FILE_FLIP_INV` の代わりに `VIEW_TO_BLENDER`（three の Y-up → Blender の Z-up、X +90°）にして焼き込み、ヘッダーに
  `comment GSEditor up +Z (Blender)` を入れる。読み込み時にこの目印があれば、メッシュの向きを `FILE_FLIP` でなく `Z_UP`（X −90°）にする
  （`source.upZ`。Separate・Light/Full 切替・Replace でも引き継ぐ）。開き直しても同じ場所に出ることを確認済み
- **GSEditor の SPZ は Blender 5.3 で上下逆さまに入る**（高さが Z の負の側に出る。Spark で開く分には正しい）。Blender には PLY（Blender）を使う
- 本番データの中には最初から Z-up の PLY もある（目印なし）。GSEditor はそれを 3DGS の軸として開くので横倒しに見える → 手で回すか、
  今後「上の軸」の切り替えを付ける
- 実測：277万粒 1.3秒／1070万粒 6.5秒／4000万粒（9.9GB）19秒・メモリ 9.7GB（ピーク 19.6GB）。EEVEE 1280×720 1枚 2〜6秒

## リライト準備（0.7.0）

方針の正本は別スレッドの `gs-relight-plan.md`、Blender 側は別アドオン「GS Relight」（GPL。GSEditor は MIT なので、コードは写さず手法の説明から書いた）。

- **いつ**：読み込み直後、全体がそろっているときに Worker で1回（`viewer/relightPrep.ts`、`prep` メッセージ）。焼き付いた暗さは撮影時に実在した物が作ったものなので、切り抜く前に計算する。
  浮遊ゴミは実在しない遮りなので、その前に除く。回転・移動は書き出し時に法線へ同じ回転を掛けるだけ
- **升目**：細かい升目 h = 不透明度 0.5 超の粒の「最大軸の大きさ」の中央値 × 4（`ScanData.prepare` がパック済みのスケールのバイトから出す）。
  セル数が 800万を超えるなら h を大きくする。範囲は 0.5〜99.5% の位置で決め、外の粒は端のセルに入れる
- **浮遊ゴミ**（`CLEAN`）：遠い＝範囲の外へ「範囲の最大の辺 × 0.25」以上（軸ごとではなく最大の辺で測る。平らな敷地の街灯を消さないため）、
  薄い＝不透明度のバイト < 5、孤立＝周り 3×3×3 セルの粒が 3 未満。消した粒は普通の削除と同じ扱いで、履歴の最初の1件
- **法線**：セルごとに、周り 3×3×3 セルの粒の不透明度重み付きの共分散（セル中心からの局所座標の積率を float32 で持ち、隣のセルは平行移動で合成）の
  最小固有値の固有ベクトル（閉じた式）。粒が 4 未満なら無し（書き出しで「上」）。粒ごとには持たず、セルの値を粒に配る（Int8 ×3）。
  表裏は持たない。書き出し時に、ビューで上を向くように反転する
- **焼き付き量**：h × 7 の大きいセルで、表示色を線形化（^2.2）した輝度の不透明度重み付き平均を 3×3×3 でぼかし、粒の重み付き平均が 1 になるよう割る。下限 0.02
- **フラットな色**：linear / baked^0.6（`FLAT_STRENGTH`。Blender アドオンもこの値を前提にしているので固定）。画面は描いている粒の色のワードだけ置き換え（`flat0`）、
  SH は切る（書き出しで捨てるので）。Space を押している間は元の色と SH
- **上の軸**：法線が ±0.9 以上でそろうセルの数を軸ごとに数え、目印の無い **PLY** で Z が他の 3 倍を超えたら Z up とみなす（物ひとつのスキャンを誤判定しないよう、PLY 以外と僅差は対象外）
- **書き出し**（`export/exportGS.ts` の `toRelight`）：f_dc をフラットな色に、f_rest_* と nx/ny/nz を削除、relight_nx/ny/nz（出力の軸、単位長、ビューの上向き）と baked_light を追加。
  法線は位置と同じ回転（`part.matrix` の回転部分）を掛ける。PLY 以外の書き出しは廃止
- 実測（このPC）：garden 310万粒＝読み込み＋準備 4.7秒・書き出し 20秒（226MB）・自動掃除 448粒。合成 4000万粒（9.9GB）＝読み込み＋準備 69秒。
  Blender 5.3：書き出した PLY の読み込み 0.5秒（relight_* と baked_light が FLOAT 属性で入る）、GS Relight の Set Up Relight 0.6秒（ファイルの値を使う速い経路）、Cycles 960×540・32spp 7.7秒

## ライセンス

MIT。表示側 Spark / three.js、書き出し側 @playcanvas/splat-transform もすべて MIT。
