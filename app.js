/* ===========================================================
   台紙メーカー - app.js
   全処理はブラウザ内で完結。大量画像でも落ちないよう、
   重い処理はチャンク分割 + requestAnimationFrame で少しずつ進める。
   =========================================================== */

(function () {
  "use strict";

  /* ---------- 用紙サイズ定義 (mm, 幅×高さ) ---------- */
  const PAPER_SIZES = {
    B4L: { w: 364, h: 257, label: "B4 横" },
    B4P: { w: 257, h: 364, label: "B4 縦" },
    A4L: { w: 297, h: 210, label: "A4 横" },
    A4P: { w: 210, h: 297, label: "A4 縦" },
    A3L: { w: 420, h: 297, label: "A3 横" },
    A3P: { w: 297, h: 420, label: "A3 縦" },
    B5L: { w: 257, h: 182, label: "B5 横" },
    B5P: { w: 182, h: 257, label: "B5 縦" },
  };

  /* ---------- 設定値 ---------- */
  const MAX_THUMB_EDGE = 220;       // アップロード直後のサムネ表示サイズ
  const CHUNK_SIZE = 4;             // 一度に処理する画像数（チャンク）
  const PDF_EXPORT_DPI = 200;       // PDF書き出し時の解像度(dpi)。画質重視だが暴走しない範囲

  // 画像枚数に応じてセル用画像の最大辺を調整（枚数が多いほど1枚あたりの
  // 表示面積は小さくなるため、メモリと速度を優先して解像度を落とす）。
  // 画質はできる限り保ちつつ、大量アップロード時のクラッシュを防ぐための安全策。
  function getMaxCellEdge(fileCount) {
    if (fileCount <= 30) return 1100;
    if (fileCount <= 80) return 850;
    if (fileCount <= 160) return 650;
    if (fileCount <= 300) return 500;
    return 380;
  }

  /* ---------- 状態管理 ---------- */
  const state = {
    files: [],          // {id, file, thumbUrl, fullBitmapPromise}
    n: 0,                // グリッド辺の数
    bigCount: 0,         // 大きく表示する枚数
    bigSelectedIds: [],  // 選ばれた画像id (順番維持)
    cells: [],           // 最終レイアウト: {id, row, col, span(1|2), imgUrl, colorScore}
    paperKey: "B4L",
    processedImages: {}, // id -> {url, w, h, avgColor:{r,g,b}}
  };

  let idSeq = 0;

  /* ---------- DOM取得 ---------- */
  const $ = (id) => document.getElementById(id);
  const dropzone = $("dropzone");
  const fileInput = $("fileInput");
  const thumbsStrip = $("thumbsStrip");
  const uploadStatus = $("uploadStatus");
  const uploadProgressTrack = $("uploadProgressTrack");
  const uploadProgressFill = $("uploadProgressFill");
  const countInfo = $("countInfo");
  const clearAllBtn = $("clearAllBtn");

  const bigPickSection = $("bigPickSection");
  const bigPickGrid = $("bigPickGrid");
  const bigPickHint = $("bigPickHint");
  const bigPickStatus = $("bigPickStatus");
  const confirmBigPickBtn = $("confirmBigPickBtn");

  const layoutSection = $("layoutSection");
  const gridStage = $("gridStage");
  const renderProgressTrack = $("renderProgressTrack");
  const renderProgressFill = $("renderProgressFill");
  const shuffleBtn = $("shuffleBtn");
  const downloadPdfBtn = $("downloadPdfBtn");
  const pdfStatus = $("pdfStatus");
  const paperSizeSelect = $("paperSize");

  /* ============================================================
     ユーティリティ
     ============================================================ */

  function nextFrame() {
    return new Promise((res) => requestAnimationFrame(() => res()));
  }

  function idleWait() {
    // 描画スレッドに一息つかせる（大量画像でのフリーズ防止）
    return new Promise((res) => {
      if ("requestIdleCallback" in window) {
        requestIdleCallback(() => res(), { timeout: 200 });
      } else {
        setTimeout(res, 0);
      }
    });
  }

  function setProgress(track, fill, ratio) {
    track.classList.add("on");
    fill.style.width = Math.round(ratio * 100) + "%";
    if (ratio >= 1) {
      setTimeout(() => track.classList.remove("on"), 400);
    }
  }

  // (n-1)^2 < count <= n^2 となる自然数 n を求める
  function computeN(count) {
    if (count <= 0) return 1;
    let n = Math.ceil(Math.sqrt(count));
    if (n < 1) n = 1;
    // 境界チェック（浮動小数点誤差の保険）
    while ((n - 1) * (n - 1) >= count) n--;
    while (n * n < count) n++;
    return n;
  }

  /* ============================================================
     画像読み込み・縮小（チャンク分割処理）
     ============================================================ */

  function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function loadImageEl(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  // 画像を最大辺 maxEdge に収まるように canvas でリサイズし、dataURLを返す
  function resizeImage(img, maxEdge, quality) {
    let { width, height } = img;
    const longEdge = Math.max(width, height);
    if (longEdge > maxEdge) {
      const scale = maxEdge / longEdge;
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, width, height);
    return {
      url: canvas.toDataURL("image/jpeg", quality || 0.85),
      w: width,
      h: height,
      canvas,
    };
  }

  // 簡易平均色を算出（縮小した小さいcanvasからサンプリング）
  function computeAvgColor(canvas) {
    const sw = 16, sh = 16;
    const tmp = document.createElement("canvas");
    tmp.width = sw;
    tmp.height = sh;
    const ctx = tmp.getContext("2d");
    ctx.drawImage(canvas, 0, 0, sw, sh);
    const data = ctx.getImageData(0, 0, sw, sh).data;
    let r = 0, g = 0, b = 0, cnt = 0;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i]; g += data[i + 1]; b += data[i + 2];
      cnt++;
    }
    return { r: r / cnt, g: g / cnt, b: b / cnt };
  }

  /* ============================================================
     アップロード処理（チャンク分割）
     ============================================================ */

  function addFilesToState(fileList) {
    const arr = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
    if (arr.length === 0) return;
    for (const f of arr) {
      state.files.push({ id: `img_${idSeq++}`, file: f });
    }
    processUploadQueue();
  }

  let uploadInProgress = false;

  async function processUploadQueue() {
    if (uploadInProgress) {
      // 既に実行中のループが、追加されたファイルも順次拾っていく（下のwhileループ参照）
      return;
    }
    uploadInProgress = true;
    uploadStatus.textContent = "画像を読み込み中…";
    uploadStatus.classList.add("busy");

    // 未処理ファイルが無くなるまでループし続ける（アップロード中に追加された分も拾う）
    let totalProcessedInSession = 0;
    let totalTargetSnapshot = 0;

    while (true) {
      const targets = state.files.filter((f) => !f.thumbUrl && !f._processing && !f._error);
      if (targets.length === 0) break;
      targets.forEach((f) => (f._processing = true));
      totalTargetSnapshot += targets.length;

      for (let i = 0; i < targets.length; i += CHUNK_SIZE) {
        const chunk = targets.slice(i, i + CHUNK_SIZE);
        await Promise.all(
          chunk.map(async (entry) => {
            try {
              const dataUrl = await readFileAsDataURL(entry.file);
              const img = await loadImageEl(dataUrl);
              const thumb = resizeImage(img, MAX_THUMB_EDGE, 0.8);
              const maxEdge = getMaxCellEdge(state.files.length);
              const full = resizeImage(img, maxEdge, 0.9);
              const avgColor = computeAvgColor(full.canvas);
              entry.thumbUrl = thumb.url;
              state.processedImages[entry.id] = {
                url: full.url,
                w: full.w,
                h: full.h,
                avgColor,
              };
            } catch (e) {
              console.error("画像読み込み失敗:", entry.file.name, e);
              entry._error = true;
            }
            totalProcessedInSession++;
          })
        );
        setProgress(
          uploadProgressTrack,
          uploadProgressFill,
          totalProcessedInSession / Math.max(totalTargetSnapshot, 1)
        );
        renderThumbsStrip(); // 逐次表示更新
        await nextFrame();
        await idleWait();
      }
    }

    uploadInProgress = false;
    uploadStatus.classList.remove("busy");
    uploadStatus.textContent = `${state.files.length} 枚アップロード済み`;
    renderThumbsStrip();
    updateCountInfo();
  }

  function renderThumbsStrip() {
    thumbsStrip.innerHTML = "";
    for (const entry of state.files) {
      const chip = document.createElement("div");
      chip.className = "thumb-chip";
      if (entry.thumbUrl) {
        const img = document.createElement("img");
        img.src = entry.thumbUrl;
        chip.appendChild(img);
      } else {
        chip.style.background = "#e0dccf";
      }
      const rm = document.createElement("div");
      rm.className = "rm";
      rm.textContent = "×";
      rm.addEventListener("click", (e) => {
        e.stopPropagation();
        removeFile(entry.id);
      });
      chip.appendChild(rm);
      thumbsStrip.appendChild(chip);
    }
    clearAllBtn.style.display = state.files.length ? "inline-block" : "none";
  }

  function removeFile(id) {
    state.files = state.files.filter((f) => f.id !== id);
    delete state.processedImages[id];
    state.bigSelectedIds = state.bigSelectedIds.filter((bid) => bid !== id);
    renderThumbsStrip();
    // 枚数が変わったのでレイアウトは一旦隠し、updateCountInfoの結果に委ねる
    layoutSection.classList.add("hidden");
    updateCountInfo();
  }

  function updateCountInfo() {
    const count = state.files.length;
    if (count === 0) {
      countInfo.classList.remove("on");
      bigPickSection.classList.add("hidden");
      layoutSection.classList.add("hidden");
      return;
    }
    const n = computeN(count);
    const remainder = n * n - count;
    const bigCount = n >= 2 ? Math.floor(remainder / 3) : 0; // 2x2の大画像は n>=2 でのみ配置可能
    state.n = n;
    state.bigCount = bigCount;

    let msg = `画像 <b>${count}</b> 枚 → <b>${n}×${n}</b> グリッドで配置します。`;
    if (bigCount > 0) {
      msg += `　余白 ${remainder} 枚ぶん → <b>${bigCount}</b> 枚を大きく表示できます（各2×2マス使用）。`;
    } else if (remainder > 0) {
      msg += `　余白 ${remainder} マスができますが、拡大候補には足りないため通常配置になります。`;
    } else {
      msg += `　ちょうど敷き詰められます。`;
    }
    countInfo.innerHTML = msg;
    countInfo.classList.add("on");

    if (bigCount > 0) {
      showBigPickSection();
    } else {
      bigPickSection.classList.add("hidden");
      state.bigSelectedIds = [];
      buildLayout();
    }
  }

  /* ============================================================
     大きく表示する画像の選択UI
     ============================================================ */

  function showBigPickSection() {
    bigPickSection.classList.remove("hidden");
    bigPickHint.textContent = `${state.bigCount} 枚を選んでください（クリックで選択/解除）。選んだ写真は2×2マス分の大きさで表示されます。`;
    state.bigSelectedIds = state.bigSelectedIds.filter((id) =>
      state.files.some((f) => f.id === id)
    );
    renderBigPickGrid();
  }

  function renderBigPickGrid() {
    bigPickGrid.innerHTML = "";
    for (const entry of state.files) {
      const item = document.createElement("div");
      item.className = "pick-item";
      if (state.bigSelectedIds.includes(entry.id)) item.classList.add("selected");
      if (entry.thumbUrl) {
        const img = document.createElement("img");
        img.src = entry.thumbUrl;
        item.appendChild(img);
      }
      const badge = document.createElement("span");
      badge.className = "idx-order";
      const orderIdx = state.bigSelectedIds.indexOf(entry.id);
      badge.textContent = orderIdx >= 0 ? orderIdx + 1 : "";
      item.appendChild(badge);

      item.addEventListener("click", () => {
        toggleBigPick(entry.id);
      });
      bigPickGrid.appendChild(item);
    }
    updateBigPickStatus();
  }

  function toggleBigPick(id) {
    const idx = state.bigSelectedIds.indexOf(id);
    if (idx >= 0) {
      state.bigSelectedIds.splice(idx, 1);
    } else {
      if (state.bigSelectedIds.length >= state.bigCount) {
        bigPickStatus.textContent = `選択できるのは ${state.bigCount} 枚までです。`;
        bigPickStatus.classList.add("err");
        return;
      }
      state.bigSelectedIds.push(id);
    }
    bigPickStatus.classList.remove("err");
    renderBigPickGrid();
  }

  function updateBigPickStatus() {
    const remain = state.bigCount - state.bigSelectedIds.length;
    if (remain > 0) {
      bigPickStatus.textContent = `あと ${remain} 枚選択してください。`;
      bigPickStatus.classList.remove("err");
    } else {
      bigPickStatus.textContent = "選択完了。「この選択でレイアウトを作る」を押してください。";
      bigPickStatus.classList.remove("err");
    }
  }

  confirmBigPickBtn.addEventListener("click", () => {
    if (state.bigCount > 0 && state.bigSelectedIds.length !== state.bigCount) {
      bigPickStatus.textContent = `${state.bigCount} 枚選択してください（現在 ${state.bigSelectedIds.length} 枚）。`;
      bigPickStatus.classList.add("err");
      return;
    }
    buildLayout();
  });

  /* ============================================================
     レイアウト計算：n×n グリッドに配置し、大画像は2x2で占有。
     色の分散は「簡易的」に、平均色をベクトル化して
     隣接セルの色距離ができるだけ大きくなるよう貪欲法で配置する。
     ============================================================ */

  // グリッド occupancy 管理: 2次元配列 (n x n) に null/占有マークを置く
  function buildOccupancyGrid(n) {
    const grid = [];
    for (let r = 0; r < n; r++) {
      grid.push(new Array(n).fill(null));
    }
    return grid;
  }

  function canPlaceBig(grid, n, r, c) {
    if (r + 1 >= n || c + 1 >= n) return false;
    return (
      grid[r][c] === null &&
      grid[r][c + 1] === null &&
      grid[r + 1][c] === null &&
      grid[r + 1][c + 1] === null
    );
  }

  function markBig(grid, r, c, marker) {
    grid[r][c] = marker;
    grid[r][c + 1] = marker;
    grid[r + 1][c] = marker;
    grid[r + 1][c + 1] = marker;
  }

  function colorDistance(c1, c2) {
    const dr = c1.r - c2.r, dg = c1.g - c2.g, db = c1.b - c2.b;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }

  function buildLayout() {
    const n = state.n;
    const allIds = state.files.map((f) => f.id);
    const bigIds = new Set(state.bigSelectedIds);
    const smallIds = allIds.filter((id) => !bigIds.has(id));

    const grid = buildOccupancyGrid(n);
    const cells = []; // {key, id, row, col, span}
    let cellKeySeq = 0;
    const nextCellKey = () => `cell_${cellKeySeq++}`;

    // --- 大画像の配置位置を先に決める（できるだけ分散: 均等間隔グリッド探索） ---
    const bigPositions = findBigPositions(n, bigIds.size);
    let biIdx = 0;
    const bigIdList = Array.from(bigIds);
    for (const pos of bigPositions) {
      if (biIdx >= bigIdList.length) break;
      if (canPlaceBig(grid, n, pos.r, pos.c)) {
        const id = bigIdList[biIdx++];
        markBig(grid, pos.r, pos.c, id);
        cells.push({ key: nextCellKey(), id, row: pos.r, col: pos.c, span: 2 });
      }
    }
    // 万一置けなかった大画像があれば、空いている場所を総当たりで探す
    while (biIdx < bigIdList.length) {
      let placed = false;
      for (let r = 0; r < n - 1 && !placed; r++) {
        for (let c = 0; c < n - 1 && !placed; c++) {
          if (canPlaceBig(grid, n, r, c)) {
            const id = bigIdList[biIdx++];
            markBig(grid, r, c, id);
            cells.push({ key: nextCellKey(), id, row: r, col: c, span: 2 });
            placed = true;
          }
        }
      }
      if (!placed) break; // 配置不能（理論上起きないはずだが安全策）
    }

    // --- 残りマスに小画像を色分散を考慮しながら貪欲法で配置 ---
    // 空きマスの座標一覧
    const emptyCells = [];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (grid[r][c] === null) emptyCells.push({ r, c });
      }
    }

    // 色データを取得
    const colorOf = (id) => {
      const p = state.processedImages[id];
      return p ? p.avgColor : { r: 128, g: 128, b: 128 };
    };

    // 貪欲法: 各空きマスを順番に処理し、そのマスの「既配置隣接セル」との
    // 色距離合計が最大になる画像を、残っている画像から選ぶ。
    // 計算量を抑えるため候補は毎回全画像を見るがO(cells * remaining)で十分軽い。
    const remaining = smallIds.slice();
    const placedColorGrid = {}; // "r,c" -> color

    // 大画像もお隣情報として使えるように登録
    for (const cell of cells) {
      const col = colorOf(cell.id);
      for (let dr = 0; dr < cell.span; dr++) {
        for (let dc = 0; dc < cell.span; dc++) {
          placedColorGrid[`${cell.row + dr},${cell.col + dc}`] = col;
        }
      }
    }

    // 処理順は中心から外側へ（見た目のバランスが良くなりやすい）
    const centerR = (n - 1) / 2, centerC = (n - 1) / 2;
    emptyCells.sort((a, b) => {
      const da = Math.hypot(a.r - centerR, a.c - centerC);
      const db = Math.hypot(b.r - centerR, b.c - centerC);
      return da - db;
    });

    function neighborsOf(r, c) {
      return [
        [r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1],
      ];
    }

    for (const { r, c } of emptyCells) {
      if (remaining.length === 0) break;
      const neigh = neighborsOf(r, c)
        .map(([nr, nc]) => placedColorGrid[`${nr},${nc}`])
        .filter(Boolean);

      let bestIdx = 0;
      let bestScore = -Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const col = colorOf(remaining[i]);
        let score;
        if (neigh.length === 0) {
          // 隣接情報がない場合はランダム性を持たせる（分散のため）
          score = Math.random();
        } else {
          score = neigh.reduce((sum, nc2) => sum + colorDistance(col, nc2), 0) / neigh.length;
        }
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }
      const chosenId = remaining.splice(bestIdx, 1)[0];
      cells.push({ key: nextCellKey(), id: chosenId, row: r, col: c, span: 1 });
      placedColorGrid[`${r},${c}`] = colorOf(chosenId);
    }

    // 大画像が4マス消費するため、単純計算上まだ空きマスが残ることがある
    // （(n^2-count)/3 は近似式のため）。残った空きマスは、既に配置した
    // 小画像の中から色分散を保ちつつ再利用して埋める（画像を1枚も余らせない・
    // 空白マスを作らないための保険）。
    if (remaining.length === 0) {
      const stillEmpty = [];
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          if (grid[r][c] === null) {
            const filled = cells.some(
              (cell) =>
                r >= cell.row &&
                r < cell.row + cell.span &&
                c >= cell.col &&
                c < cell.col + cell.span
            );
            if (!filled) stillEmpty.push({ r, c });
          }
        }
      }
      const reusePool = smallIds.length ? smallIds : allIds;
      for (const { r, c } of stillEmpty) {
        const neigh = neighborsOf(r, c)
          .map(([nr, nc]) => placedColorGrid[`${nr},${nc}`])
          .filter(Boolean);
        let bestId = reusePool[0];
        let bestScore = -Infinity;
        for (const id of reusePool) {
          const col = colorOf(id);
          const score =
            neigh.length === 0
              ? Math.random()
              : neigh.reduce((sum, nc2) => sum + colorDistance(col, nc2), 0) / neigh.length;
          if (score > bestScore) {
            bestScore = score;
            bestId = id;
          }
        }
        cells.push({ key: nextCellKey(), id: bestId, row: r, col: c, span: 1, reused: true });
        placedColorGrid[`${r},${c}`] = colorOf(bestId);
      }
    }

    state.cells = cells;
    renderGridStage();
  }

  // 大画像を可能な限り均等に分散配置する位置候補を生成
  // 2x2ブロックの左上座標が取りうる範囲は r,c ∈ [0, n-2]
  function findBigPositions(n, count) {
    if (count === 0 || n < 2) return [];
    const maxIdx = n - 2; // 左上座標の最大値

    // 候補座標を全列挙
    const allCandidates = [];
    for (let r = 0; r <= maxIdx; r++) {
      for (let c = 0; c <= maxIdx; c++) {
        allCandidates.push({ r, c });
      }
    }

    // 貪欲法: 既に選んだ位置たちからの最小距離が最大になる候補を
    // 1つずつ選んでいく（Farthest Point Sampling に近い簡易分散配置）
    const chosen = [];
    // 最初の1点は中央寄りから
    const center = { r: maxIdx / 2, c: maxIdx / 2 };
    allCandidates.sort(
      (a, b) =>
        Math.hypot(a.r - center.r, a.c - center.c) -
        Math.hypot(b.r - center.r, b.c - center.c)
    );
    chosen.push(allCandidates.shift());

    while (chosen.length < count && allCandidates.length > 0) {
      let bestIdx = 0;
      let bestMinDist = -Infinity;
      for (let i = 0; i < allCandidates.length; i++) {
        const cand = allCandidates[i];
        let minDist = Infinity;
        for (const ch of chosen) {
          // 2x2ブロック同士が重なるかどうかも考慮した距離（ブロック間の実距離に近似）
          const d = Math.hypot(cand.r - ch.r, cand.c - ch.c);
          if (d < minDist) minDist = d;
        }
        if (minDist > bestMinDist) {
          bestMinDist = minDist;
          bestIdx = i;
        }
      }
      chosen.push(allCandidates.splice(bestIdx, 1)[0]);
    }

    // 残りの座標も分散順のまま後ろに連結しておく（配置失敗時のフォールバック候補として使用）
    return chosen.concat(allCandidates);
  }

  /* ============================================================
     グリッド描画 + ドラッグ&ドロップ（ポインタイベントで統一）
     ============================================================ */

  let stageGeom = { n: 1, cellPx: 100, paddingPx: 0 };

  function getPaperPx() {
    // 画面表示用: mm を px に変換（画面上のプレビュー用スケール、印刷解像度とは別）
    // コンテナ幅に収まるようスケールを自動調整する
    const paper = PAPER_SIZES[state.paperKey];
    const containerEl = gridStage.parentElement; // .canvas-stage-wrap
    const availableW = Math.max(containerEl.clientWidth - 40, 240); // padding分を差し引く
    const naturalScale = 2.5;
    let scale = naturalScale;
    if (paper.w * naturalScale > availableW) {
      scale = availableW / paper.w;
    }
    // 縦向きなどで縦が長すぎる場合、画面の高さに対しても収める（過度に長くならないように）
    const maxH = Math.max(window.innerHeight * 0.7, 300);
    if (paper.h * scale > maxH) {
      scale = maxH / paper.h;
    }
    return { w: paper.w * scale, h: paper.h * scale };
  }

  function renderGridStage() {
    layoutSection.classList.remove("hidden");
    const n = state.n;
    const { w: stageW, h: stageH } = getPaperPx();
    const side = Math.min(stageW, stageH); // 正方形グリッドを用紙内に収める（余白は用紙側で調整）
    // 用紙のアスペクト比に合わせて、グリッド全体を用紙いっぱいに敷き詰める矩形にする
    // ここでは用紙全体を使い切る形にする（正方形セルではなく用紙比率に合わせる）
    gridStage.style.width = stageW + "px";
    gridStage.style.height = stageH + "px";
    gridStage.innerHTML = "";

    const cellW = stageW / n;
    const cellH = stageH / n;
    stageGeom = { n, cellW, cellH, stageW, stageH };

    for (const cell of state.cells) {
      const div = document.createElement("div");
      div.className = "cell" + (cell.span === 2 ? " big-cell" : "");
      div.dataset.key = cell.key;
      positionCellDiv(div, cell, cellW, cellH);

      const img = document.createElement("img");
      const p = state.processedImages[cell.id];
      img.src = p ? p.url : "";
      img.draggable = false;
      div.appendChild(img);

      attachDragHandlers(div);
      gridStage.appendChild(div);
    }
  }

  function positionCellDiv(div, cell, cellW, cellH) {
    div.style.left = cell.col * cellW + "px";
    div.style.top = cell.row * cellH + "px";
    div.style.width = cell.span * cellW + "px";
    div.style.height = cell.span * cellH + "px";
  }

  function refreshAllCellPositions() {
    const { cellW, cellH } = stageGeom;
    const nodes = gridStage.querySelectorAll(".cell");
    nodes.forEach((div) => {
      const key = div.dataset.key;
      const cell = state.cells.find((c) => c.key === key);
      if (cell) positionCellDiv(div, cell, cellW, cellH);
    });
  }

  /* ---- ドラッグ&ドロップで2セルの位置(row,col,span)を交換 ---- */

  let dragCtx = null;

  function attachDragHandlers(div) {
    div.addEventListener("pointerdown", onPointerDown);
  }

  function onPointerDown(e) {
    const div = e.currentTarget;
    div.setPointerCapture(e.pointerId);
    const rect = gridStage.getBoundingClientRect();
    dragCtx = {
      div,
      key: div.dataset.key,
      startX: e.clientX,
      startY: e.clientY,
      origLeft: parseFloat(div.style.left),
      origTop: parseFloat(div.style.top),
      stageRect: rect,
      moved: false,
    };
    div.classList.add("dragging");
    div.addEventListener("pointermove", onPointerMove);
    div.addEventListener("pointerup", onPointerUp);
    div.addEventListener("pointercancel", onPointerUp);
  }

  function onPointerMove(e) {
    if (!dragCtx) return;
    const dx = e.clientX - dragCtx.startX;
    const dy = e.clientY - dragCtx.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragCtx.moved = true;
    dragCtx.div.style.left = dragCtx.origLeft + dx + "px";
    dragCtx.div.style.top = dragCtx.origTop + dy + "px";

    // ドロップ先ハイライト
    clearDropTargetHighlight();
    const targetDiv = findCellUnderPoint(e.clientX, e.clientY, dragCtx.div);
    if (targetDiv) targetDiv.classList.add("drop-target");
  }

  function findCellUnderPoint(clientX, clientY, excludeDiv) {
    const els = document.elementsFromPoint(clientX, clientY);
    for (const el of els) {
      if (el.classList && el.classList.contains("cell") && el !== excludeDiv) {
        return el;
      }
    }
    return null;
  }

  function clearDropTargetHighlight() {
    gridStage.querySelectorAll(".cell.drop-target").forEach((el) =>
      el.classList.remove("drop-target")
    );
  }

  function onPointerUp(e) {
    if (!dragCtx) return;
    const div = dragCtx.div;
    div.classList.remove("dragging");
    div.removeEventListener("pointermove", onPointerMove);
    div.removeEventListener("pointerup", onPointerUp);
    div.removeEventListener("pointercancel", onPointerUp);
    clearDropTargetHighlight();

    if (dragCtx.moved) {
      const targetDiv = findCellUnderPoint(e.clientX, e.clientY, div);
      if (targetDiv) {
        swapCells(dragCtx.key, targetDiv.dataset.key);
      } else {
        // ドロップ失敗 → 元位置に戻す
        refreshAllCellPositions();
      }
    } else {
      // クリックのみ（移動なし）: 位置そのまま
      refreshAllCellPositions();
    }
    dragCtx = null;
  }

  function swapCells(keyA, keyB) {
    if (keyA === keyB) {
      refreshAllCellPositions();
      return;
    }
    const cellA = state.cells.find((c) => c.key === keyA);
    const cellB = state.cells.find((c) => c.key === keyB);
    if (!cellA || !cellB) return;

    // ---- 同サイズ同士：位置をそのまま交換 ----
    if (cellA.span === cellB.span) {
      const tmpRow = cellA.row, tmpCol = cellA.col;
      cellA.row = cellB.row; cellA.col = cellB.col;
      cellB.row = tmpRow; cellB.col = tmpCol;
      refreshAllCellPositions();
      return;
    }

    // ---- 異サイズ：dragした側がどちらか判定 ----
    // keyA = ドラッグ元、keyB = ドロップ先
    const dragCell = cellA; // onPointerDownで記録したdragCtx.keyがkeyA
    const dropCell = cellB;

    // 1×1 → 2×2 はサポート外
    if (dragCell.span === 1 && dropCell.span === 2) {
      pdfStatusFlash("小さい升目から大きい升目への入れ替えはできません（大きい升目からドラッグしてください）。");
      refreshAllCellPositions();
      return;
    }

    // ---- 2×2 → 1×1 の交換 ----
    // ドロップ先の1×1セルを左上とする2×2範囲の4枚と交換する。
    // ただし範囲がグリッド外にはみ出す場合は左上座標をクランプする。
    const bigCell = dragCell;   // span=2（ドラッグ元）
    const dropSmall = dropCell; // span=1（ドロップ先）
    const n = state.n;

    // ドロップ先を左上にした2×2の左上座標（グリッド内に収まるようクランプ）
    const newBigRow = Math.min(dropSmall.row, n - 2);
    const newBigCol = Math.min(dropSmall.col, n - 2);

    // その2×2範囲に含まれる1×1セルを全て収集
    // （2×2セルが入っていたらその交換は不可）
    const targetSmalls = [];
    for (let dr = 0; dr < 2; dr++) {
      for (let dc = 0; dc < 2; dc++) {
        const r = newBigRow + dr;
        const c = newBigCol + dc;
        // この座標を占有しているセルを探す
        const found = state.cells.find((cell) => {
          if (cell.key === bigCell.key) return false; // ドラッグ元自身は除外
          if (cell.span === 2) {
            // 2×2セルが占める4マスをチェック
            return r >= cell.row && r < cell.row + 2 &&
                   c >= cell.col && c < cell.col + 2;
          }
          return cell.row === r && cell.col === c;
        });
        if (found && found.span === 2) {
          // 2×2セル同士の交換になってしまう場合はそちらに委ねる（通常の交換）
          const tmpRow = bigCell.row, tmpCol = bigCell.col,
                tmpSpan = bigCell.span;
          bigCell.row = found.row; bigCell.col = found.col;
          found.row = tmpRow; found.col = tmpCol;
          refreshAllCellPositions();
          return;
        }
        if (found && !targetSmalls.some((s) => s.key === found.key)) {
          targetSmalls.push(found);
        }
      }
    }

    // 2×2範囲にちょうど4枚の1×1が揃っていない場合は中止
    if (targetSmalls.length !== 4) {
      pdfStatusFlash("2×2範囲に別のサイズの升目が含まれているため入れ替えできません。");
      refreshAllCellPositions();
      return;
    }

    // 元の2×2の位置（4マス分）に4枚の1×1を配置する
    const oldBigRow = bigCell.row;
    const oldBigCol = bigCell.col;
    const positions = [
      { r: oldBigRow,     c: oldBigCol     },
      { r: oldBigRow,     c: oldBigCol + 1 },
      { r: oldBigRow + 1, c: oldBigCol     },
      { r: oldBigRow + 1, c: oldBigCol + 1 },
    ];
    targetSmalls.forEach((cell, i) => {
      cell.row = positions[i].r;
      cell.col = positions[i].c;
      // span は 1 のまま
    });

    // 2×2セルをドロップ先の2×2範囲へ移動
    bigCell.row = newBigRow;
    bigCell.col = newBigCol;
    // span は 2 のまま

    refreshAllCellPositions();
  }

  function pdfStatusFlash(msg) {
    pdfStatus.textContent = msg;
    pdfStatus.classList.add("err");
    setTimeout(() => {
      pdfStatus.classList.remove("err");
      pdfStatus.textContent = "";
    }, 2600);
  }

  shuffleBtn.addEventListener("click", () => {
    buildLayout();
  });

  /* ============================================================
     PDF書き出し（高画質・チャンク処理でクラッシュ回避）
     ============================================================ */

  downloadPdfBtn.addEventListener("click", async () => {
    if (!state.cells.length) return;
    downloadPdfBtn.disabled = true;
    shuffleBtn.disabled = true;
    pdfStatus.classList.remove("err");
    pdfStatus.textContent = "PDFを作成しています…";

    try {
      await exportToPdf();
      pdfStatus.textContent = "PDFのダウンロードが完了しました。";
    } catch (e) {
      console.error(e);
      pdfStatus.textContent = "PDF作成中にエラーが発生しました。もう一度お試しください。";
      pdfStatus.classList.add("err");
    } finally {
      downloadPdfBtn.disabled = false;
      shuffleBtn.disabled = false;
    }
  });

  async function exportToPdf() {
    const paper = PAPER_SIZES[state.paperKey];
    // キャンバス総ピクセル数が大きくなりすぎないよう、枚数が多いときはDPIを少し落とす
    // （ブラウザによっては巨大canvasでメモリエラーになるため安全策）
    const cellCount = state.cells.length;
    let dpi = PDF_EXPORT_DPI;
    if (cellCount > 300) dpi = 130;
    else if (cellCount > 150) dpi = 160;
    else if (cellCount > 80) dpi = 180;

    const mmToPx = dpi / 25.4;
    const pageWpx = Math.round(paper.w * mmToPx);
    const pageHpx = Math.round(paper.h * mmToPx);

    // 大きな一枚キャンバスに全セルを描画してからPDFに埋め込む
    const canvas = document.createElement("canvas");
    canvas.width = pageWpx;
    canvas.height = pageHpx;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, pageWpx, pageHpx);

    const n = state.n;
    const cellWpx = pageWpx / n;
    const cellHpx = pageHpx / n;

    const total = state.cells.length;
    let done = 0;

    for (const cell of state.cells) {
      const p = state.processedImages[cell.id];
      if (p) {
        const img = await loadImageEl(p.url);
        const dx = cell.col * cellWpx;
        const dy = cell.row * cellHpx;
        const dw = cell.span * cellWpx;
        const dh = cell.span * cellHpx;
        drawImageCover(ctx, img, dx, dy, dw, dh);
      }
      done++;
      setProgress(renderProgressTrack, renderProgressFill, done / total);
      if (done % 3 === 0) {
        await nextFrame();
        await idleWait();
      }
    }

    await nextFrame();

    // jsPDF に反映
    const orientation = paper.w >= paper.h ? "l" : "p";
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({
      orientation,
      unit: "mm",
      format: [paper.w, paper.h],
      compress: true,
    });

    const imgData = canvas.toDataURL("image/jpeg", 0.92);
    pdf.addImage(imgData, "JPEG", 0, 0, paper.w, paper.h, undefined, "FAST");
    pdf.save(`台紙_${paper.label.replace(/\s/g, "")}.pdf`);
  }

  // object-fit: cover 相当の描画
  function drawImageCover(ctx, img, dx, dy, dw, dh) {
    const iw = img.width, ih = img.height;
    const targetRatio = dw / dh;
    const srcRatio = iw / ih;
    let sx, sy, sw, sh;
    if (srcRatio > targetRatio) {
      sh = ih;
      sw = ih * targetRatio;
      sx = (iw - sw) / 2;
      sy = 0;
    } else {
      sw = iw;
      sh = iw / targetRatio;
      sx = 0;
      sy = (ih - sh) / 2;
    }
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
  }

  /* ============================================================
     アップロードUIイベント
     ============================================================ */

  dropzone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (e) => {
    addFilesToState(e.target.files);
    fileInput.value = "";
  });

  ["dragenter", "dragover"].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("drag");
    });
  });
  ["dragleave", "drop"].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove("drag");
    });
  });
  dropzone.addEventListener("drop", (e) => {
    if (e.dataTransfer && e.dataTransfer.files) {
      addFilesToState(e.dataTransfer.files);
    }
  });

  clearAllBtn.addEventListener("click", () => {
    state.files = [];
    state.processedImages = {};
    state.bigSelectedIds = [];
    state.cells = [];
    renderThumbsStrip();
    updateCountInfo();
    bigPickSection.classList.add("hidden");
    layoutSection.classList.add("hidden");
    uploadStatus.textContent = "";
  });

  paperSizeSelect.addEventListener("change", (e) => {
    state.paperKey = e.target.value;
    if (state.cells.length) {
      renderGridStage();
    }
  });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (!state.cells.length) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      renderGridStage();
    }, 200);
  });

  // 初期状態
  state.paperKey = paperSizeSelect.value;

})();
