'use strict';

/**
 * 文章页原生分享栏与打赏弹窗交互模块
 * - 完全自托管：零第三方分享脚本、零图标字体、零 innerHTML；
 * - 内置精简 ISO/IEC 18004 QR Code (UTF-8 Byte Mode, ECC L, V1-V14) 单路径 SVG 构造器；
 * - 集成系统分享 (navigator.share)、复制链接 (live-region 无障碍播报)、微信原生 Popover 扫码弹层、打赏点击切换与 PJAX 幂等生命周期管理。
 */
(() => {
  if (typeof window.__moriPostShareInit === 'function') {
    window.__moriPostShareInit();
    return;
  }

  // ---------------------------------------------------------------------------
  // 1. 精简标准 QR Code 编码器（GF(256) + ECC Level L, Version 1~14）
  // ---------------------------------------------------------------------------
  const GF_EXP = new Uint8Array(512);
  const GF_LOG = new Uint8Array(256);
  (() => {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      GF_EXP[i] = x;
      GF_EXP[i + 255] = x;
      GF_LOG[x] = i;
      x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
    }
  })();

  const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);

  // Version 1~14 Level L: [count1, total1, data1, count2?, total2?, data2?]
  const RS_BLOCKS_L = [
    null,
    [1, 26, 19],
    [1, 44, 34],
    [1, 70, 55],
    [1, 100, 80],
    [1, 134, 108],
    [2, 86, 68],
    [2, 98, 78],
    [2, 121, 97],
    [2, 146, 116],
    [2, 86, 68, 2, 87, 69],
    [4, 101, 81],
    [2, 116, 92, 2, 117, 93],
    [4, 133, 107],
    [3, 145, 115, 1, 146, 116]
  ];

  const ALIGN_POS = [
    null,
    [],
    [6, 18],
    [6, 22],
    [6, 26],
    [6, 30],
    [6, 34],
    [6, 22, 38],
    [6, 24, 42],
    [6, 26, 46],
    [6, 28, 50],
    [6, 30, 54],
    [6, 32, 58],
    [6, 34, 62],
    [6, 26, 46, 66]
  ];

  const getRsGenerator = ecLen => {
    let poly = [1];
    for (let i = 0; i < ecLen; i++) {
      const next = new Array(poly.length + 1).fill(0);
      const factor = GF_EXP[i];
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], factor);
      }
      poly = next;
    }
    return poly;
  };

  const computeRsEc = (data, ecLen) => {
    const gen = getRsGenerator(ecLen);
    const work = new Uint8Array(data.length + ecLen);
    work.set(data);
    for (let i = 0; i < data.length; i++) {
      const coef = work[i];
      if (coef !== 0) {
        for (let j = 0; j < gen.length; j++) {
          work[i + j] ^= gfMul(gen[j], coef);
        }
      }
    }
    return work.subarray(data.length);
  };

  const bchDigit = data => {
    let digit = 0;
    let d = data;
    while (d !== 0) {
      digit++;
      d >>>= 1;
    }
    return digit;
  };

  const getBchFormatInfo = mask => {
    // ECC Level L = 01
    const data = (1 << 3) | mask;
    let d = data << 10;
    while (bchDigit(d) - bchDigit(0x537) >= 0) {
      d ^= 0x537 << (bchDigit(d) - bchDigit(0x537));
    }
    return ((data << 10) | d) ^ 0x5412;
  };

  const getBchVersionInfo = version => {
    let d = version << 12;
    while (bchDigit(d) - bchDigit(0x1f25) >= 0) {
      d ^= 0x1f25 << (bchDigit(d) - bchDigit(0x1f25));
    }
    return (version << 12) | d;
  };

  const encodeQrBytes = text => {
    const bytes = new TextEncoder().encode(text);
    let version = 1;
    let totalDataBytes = 0;
    for (; version < RS_BLOCKS_L.length; version++) {
      const spec = RS_BLOCKS_L[version];
      const countBits = version < 10 ? 8 : 16;
      const cap = spec[0] * spec[2] + (spec.length > 3 ? spec[3] * spec[5] : 0);
      const neededBits = 4 + countBits + bytes.length * 8;
      if (neededBits <= cap * 8) {
        totalDataBytes = cap;
        break;
      }
    }
    if (!totalDataBytes) return null;

    const bits = [];
    const pushBits = (val, len) => {
      for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    };
    pushBits(4, 4); // Byte mode
    pushBits(bytes.length, version < 10 ? 8 : 16);
    for (const b of bytes) pushBits(b, 8);

    const totalBits = totalDataBytes * 8;
    pushBits(0, Math.min(4, totalBits - bits.length));
    while (bits.length % 8 !== 0) bits.push(0);
    let padIdx = 0;
    while (bits.length < totalBits) {
      pushBits(padIdx++ % 2 === 0 ? 0xec : 0x11, 8);
    }

    const rawData = new Uint8Array(totalDataBytes);
    for (let i = 0; i < bits.length; i++) {
      if (bits[i]) rawData[i >>> 3] |= 0x80 >>> (i & 7);
    }

    const spec = RS_BLOCKS_L[version];
    const blocks = [];
    let offset = 0;
    let maxData = 0;
    let maxEc = 0;
    for (let g = 0; g < spec.length; g += 3) {
      const count = spec[g];
      const total = spec[g + 1];
      const dc = spec[g + 2];
      const ecLen = total - dc;
      maxData = Math.max(maxData, dc);
      maxEc = Math.max(maxEc, ecLen);
      for (let b = 0; b < count; b++) {
        const dcSlice = rawData.subarray(offset, offset + dc);
        offset += dc;
        blocks.push({ dc: dcSlice, ec: computeRsEc(dcSlice, ecLen) });
      }
    }

    const interleaved = [];
    for (let i = 0; i < maxData; i++) {
      for (const blk of blocks) {
        if (i < blk.dc.length) interleaved.push(blk.dc[i]);
      }
    }
    for (let i = 0; i < maxEc; i++) {
      for (const blk of blocks) {
        if (i < blk.ec.length) interleaved.push(blk.ec[i]);
      }
    }

    return { version, codewords: interleaved };
  };

  const MASK_FNS = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (_, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
  ];

  const penaltyScore = (grid, size) => {
    let score = 0;
    // Rule 1: 5+ consecutive same-color modules
    for (let r = 0; r < size; r++) {
      let runRow = 1;
      let runCol = 1;
      for (let c = 1; c < size; c++) {
        if (grid[r][c] === grid[r][c - 1]) runRow++;
        else {
          if (runRow >= 5) score += 3 + (runRow - 5);
          runRow = 1;
        }
        if (grid[c][r] === grid[c - 1][r]) runCol++;
        else {
          if (runCol >= 5) score += 3 + (runCol - 5);
          runCol = 1;
        }
      }
      if (runRow >= 5) score += 3 + (runRow - 5);
      if (runCol >= 5) score += 3 + (runCol - 5);
    }
    // Rule 2: 2x2 blocks
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = grid[r][c];
        if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) {
          score += 3;
        }
      }
    }
    // Rule 3: finder-like 1:1:3:1:1 patterns
    for (let r = 0; r < size; r++) {
      for (let c = 0; c <= size - 11; c++) {
        const pH =
          grid[r][c] === 1 && grid[r][c + 1] === 0 && grid[r][c + 2] === 1 && grid[r][c + 3] === 1 &&
          grid[r][c + 4] === 1 && grid[r][c + 5] === 0 && grid[r][c + 6] === 1;
        if (pH && (
          (!grid[r][c + 7] && !grid[r][c + 8] && !grid[r][c + 9] && !grid[r][c + 10]) ||
          (c >= 4 && !grid[r][c - 1] && !grid[r][c - 2] && !grid[r][c - 3] && !grid[r][c - 4])
        )) score += 40;

        const pV =
          grid[c][r] === 1 && grid[c + 1][r] === 0 && grid[c + 2][r] === 1 && grid[c + 3][r] === 1 &&
          grid[c + 4][r] === 1 && grid[c + 5][r] === 0 && grid[c + 6][r] === 1;
        if (pV && (
          (!grid[c + 7][r] && !grid[c + 8][r] && !grid[c + 9][r] && !grid[c + 10][r]) ||
          (c >= 4 && !grid[c - 1][r] && !grid[c - 2][r] && !grid[c - 3][r] && !grid[c - 4][r])
        )) score += 40;
      }
    }
    // Rule 4: dark ratio balance
    let dark = 0;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) dark += grid[r][c];
    }
    const pct = Math.abs((dark * 100) / (size * size) - 50) / 5;
    score += Math.floor(pct) * 10;
    return score;
  };

  const buildQrMatrix = text => {
    const encoded = encodeQrBytes(text);
    if (!encoded) return null;
    const { version, codewords } = encoded;
    const size = version * 4 + 17;

    const createBlank = () => Array.from({ length: size }, () => new Int8Array(size).fill(-1));

    const placeFunctionPatterns = (grid, maskId, testPhase) => {
      const placeFinder = (row, col) => {
        for (let r = -1; r <= 7; r++) {
          if (row + r < 0 || row + r >= size) continue;
          for (let c = -1; c <= 7; c++) {
            if (col + c < 0 || col + c >= size) continue;
            const dark = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
              (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
              (r >= 2 && r <= 4 && c >= 2 && c <= 4);
            grid[row + r][col + c] = dark ? 1 : 0;
          }
        }
      };

      placeFinder(0, 0);
      placeFinder(size - 7, 0);
      placeFinder(0, size - 7);

      // Alignment patterns
      const pos = ALIGN_POS[version];
      for (const r of pos) {
        for (const c of pos) {
          if (grid[r][c] !== -1) continue;
          for (let dr = -2; dr <= 2; dr++) {
            for (let dc = -2; dc <= 2; dc++) {
              grid[r + dr][c + dc] =
                Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0) ? 1 : 0;
            }
          }
        }
      }

      // Timing patterns
      for (let i = 8; i < size - 8; i++) {
        if (grid[i][6] === -1) grid[i][6] = i % 2 === 0 ? 1 : 0;
        if (grid[6][i] === -1) grid[6][i] = i % 2 === 0 ? 1 : 0;
      }

      // Format info
      const fmtBits = getBchFormatInfo(maskId);
      for (let i = 0; i < 15; i++) {
        const mod = !testPhase && ((fmtBits >>> i) & 1) === 1 ? 1 : 0;
        if (i < 6) grid[i][8] = mod;
        else if (i < 8) grid[i + 1][8] = mod;
        else grid[size - 15 + i][8] = mod;

        if (i < 8) grid[8][size - i - 1] = mod;
        else if (i < 9) grid[8][15 - i] = mod;
        else grid[8][15 - i - 1] = mod;
      }
      grid[size - 8][8] = 1; // Dark module

      // Version info (V7+)
      if (version >= 7) {
        const verBits = getBchVersionInfo(version);
        for (let i = 0; i < 18; i++) {
          const mod = !testPhase && ((verBits >>> i) & 1) === 1 ? 1 : 0;
          grid[Math.floor(i / 3)][(i % 3) + size - 11] = mod;
          grid[(i % 3) + size - 11][Math.floor(i / 3)] = mod;
        }
      }
    };

    const fillData = (grid, maskId) => {
      const maskFn = MASK_FNS[maskId];
      let dir = -1;
      let row = size - 1;
      let bitIdx = 7;
      let byteIdx = 0;

      for (let col = size - 1; col > 0; col -= 2) {
        if (col === 6) col--;
        while (true) {
          for (let c = 0; c < 2; c++) {
            const x = col - c;
            if (grid[row][x] === -1) {
              let dark = false;
              if (byteIdx < codewords.length) {
                dark = ((codewords[byteIdx] >>> bitIdx) & 1) === 1;
              }
              if (maskFn(row, x)) dark = !dark;
              grid[row][x] = dark ? 1 : 0;
              bitIdx--;
              if (bitIdx === -1) {
                byteIdx++;
                bitIdx = 7;
              }
            }
          }
          row += dir;
          if (row < 0 || row >= size) {
            row -= dir;
            dir = -dir;
            break;
          }
        }
      }
    };

    let bestMask = 0;
    let minLost = Infinity;
    for (let m = 0; m < 8; m++) {
      const testGrid = createBlank();
      placeFunctionPatterns(testGrid, m, true);
      fillData(testGrid, m);
      const lost = penaltyScore(testGrid, size);
      if (lost < minLost) {
        minLost = lost;
        bestMask = m;
      }
    }

    const finalGrid = createBlank();
    placeFunctionPatterns(finalGrid, bestMask, false);
    fillData(finalGrid, bestMask);
    return finalGrid;
  };

  const buildQrSvgElement = url => {
    const matrix = buildQrMatrix(url);
    if (!matrix) return null;
    const size = matrix.length;
    const segments = [];
    for (let r = 0; r < size; r++) {
      let c = 0;
      while (c < size) {
        if (matrix[r][c] === 1) {
          const start = c;
          while (c < size && matrix[r][c] === 1) c++;
          segments.push(`M${start},${r}h${c - start}v1h${start - c}z`);
        } else {
          c++;
        }
      }
    }
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('width', '148');
    svg.setAttribute('height', '148');
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', '本文分享链接二维码');

    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('fill', '#13110f');
    path.setAttribute('d', segments.join(''));
    svg.appendChild(path);
    return svg;
  };

  // ---------------------------------------------------------------------------
  // 2. 分享动作、微信 Popover 弹窗与打赏切换控制
  // ---------------------------------------------------------------------------
  let shareController = null;
  let liveToggle = false;

  const announceStatus = (container, text) => {
    if (!container) return;
    liveToggle = !liveToggle;
    container.textContent = text + (liveToggle ? '\u00A0' : '');
  };

  const fallbackCopyText = text => {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (_) {
      ok = false;
    }
    area.remove();
    return ok;
  };

  const initPostShare = () => {
    if (shareController) shareController.abort();
    shareController = new AbortController();
    const { signal } = shareController;

    const root = document.querySelector('[data-share-root]');
    if (root) {
      const shareUrl = root.dataset.url || window.location.href;
      const shareTitle = root.dataset.title || document.title;
      const shareDesc = root.dataset.description || '';
      const statusEl = root.querySelector('.share-status');

      // 复制文章链接
      const copyBtn = root.querySelector('.share-btn--copy');
      if (copyBtn) {
        const labelEl = copyBtn.querySelector('.share-btn-label');
        const defaultLabel = labelEl ? labelEl.textContent : '复制链接';
        let resetTimer = null;

        copyBtn.addEventListener('click', async () => {
          let copied = false;
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            try {
              await navigator.clipboard.writeText(shareUrl);
              copied = true;
            } catch (_) {
              copied = fallbackCopyText(shareUrl);
            }
          } else {
            copied = fallbackCopyText(shareUrl);
          }

          if (copied) {
            copyBtn.classList.add('is-copied');
            if (labelEl) labelEl.textContent = '已复制';
            announceStatus(statusEl, '已复制文章链接');
            clearTimeout(resetTimer);
            resetTimer = setTimeout(() => {
              copyBtn.classList.remove('is-copied');
              if (labelEl) labelEl.textContent = defaultLabel;
              if (statusEl) statusEl.textContent = '';
            }, 1800);
          } else {
            announceStatus(statusEl, '当前环境不支持自动复制，请手动复制地址栏链接');
          }
        }, { signal });
      }

      // 分享按钮：优先调用系统 Web Share，不支持或调用异常时降级为二维码扫码弹窗
      const nativeBtn = root.querySelector('.share-btn--native');
      const popover = root.querySelector('#post-wechat-popover');
      let toggleQrPopover = null;
      let openQrPopover = null;

      if (nativeBtn && popover) {
        const qrFrame = popover.querySelector('.wechat-qrcode-frame');
        const closeBtn = popover.querySelector('.wechat-qrcode-close');
        const supportsPopover = typeof HTMLElement !== 'undefined' && Object.hasOwn(HTMLElement.prototype, 'popover');

        const ensureQrRendered = () => {
          if (!qrFrame || qrFrame.dataset.renderedUrl === shareUrl) return;
          const svg = buildQrSvgElement(shareUrl);
          if (svg) {
            qrFrame.replaceChildren(svg);
            qrFrame.dataset.renderedUrl = shareUrl;
          }
        };

        const positionPopover = () => {
          if (typeof CSS !== 'undefined' && CSS.supports && CSS.supports('position-anchor: --x')) {
            popover.style.left = '';
            popover.style.top = '';
            return;
          }
          const btnRect = nativeBtn.getBoundingClientRect();
          const popRect = popover.getBoundingClientRect();
          const margin = 12;
          const left = Math.max(
            margin,
            Math.min(window.innerWidth - popRect.width - margin, btnRect.right - popRect.width)
          );
          let top = btnRect.top - popRect.height - 10;
          if (top < margin) top = btnRect.bottom + 10;
          popover.style.left = `${left}px`;
          popover.style.top = `${top}px`;
        };

        if (supportsPopover) {
          popover.hidden = false;
          popover.addEventListener('toggle', e => {
            const isOpen = e.newState === 'open';
            if (nativeBtn.hasAttribute('aria-controls')) {
              nativeBtn.setAttribute('aria-expanded', String(isOpen));
            }
            if (isOpen) {
              ensureQrRendered();
              requestAnimationFrame(positionPopover);
            }
          }, { signal });

          window.addEventListener('resize', () => {
            if (popover.matches(':popover-open')) positionPopover();
          }, { passive: true, signal });

          if (closeBtn) {
            closeBtn.addEventListener('click', () => {
              requestAnimationFrame(() => nativeBtn.focus());
            }, { signal });
          }

          openQrPopover = () => {
            if (!popover.matches(':popover-open')) {
              ensureQrRendered();
              popover.showPopover();
            }
          };
          toggleQrPopover = () => {
            ensureQrRendered();
            if (typeof popover.togglePopover === 'function') {
              popover.togglePopover();
            } else if (popover.matches(':popover-open')) {
              popover.hidePopover();
            } else {
              popover.showPopover();
            }
          };
        } else {
          popover.removeAttribute('popover');
          popover.hidden = true;
          const setFallbackOpen = open => {
            if (open) ensureQrRendered();
            popover.hidden = !open;
            popover.classList.toggle('is-fallback-open', open);
            if (nativeBtn.hasAttribute('aria-controls')) {
              nativeBtn.setAttribute('aria-expanded', String(open));
            }
            if (open) requestAnimationFrame(positionPopover);
          };

          openQrPopover = () => setFallbackOpen(true);
          toggleQrPopover = () => setFallbackOpen(popover.hidden);

          if (closeBtn) {
            closeBtn.addEventListener('click', () => {
              setFallbackOpen(false);
              nativeBtn.focus();
            }, { signal });
          }
          document.addEventListener('click', e => {
            if (!popover.hidden && !popover.contains(e.target) && !nativeBtn.contains(e.target)) {
              setFallbackOpen(false);
            }
          }, { signal });
          document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && !popover.hidden) {
              setFallbackOpen(false);
              nativeBtn.focus();
            }
          }, { signal });
        }
      }

      if (nativeBtn) {
        const supportsNativeShare = typeof navigator.share === 'function';
        if (!supportsNativeShare && popover && toggleQrPopover) {
          nativeBtn.setAttribute('aria-controls', 'post-wechat-popover');
          nativeBtn.setAttribute('aria-expanded', 'false');
        }

        nativeBtn.addEventListener('click', async e => {
          if (!supportsNativeShare) {
            e.stopPropagation();
            if (toggleQrPopover) toggleQrPopover();
            return;
          }
          try {
            await navigator.share({ title: shareTitle, text: shareDesc, url: shareUrl });
          } catch (err) {
            if (err && err.name === 'AbortError') return;
            if (openQrPopover) {
              nativeBtn.setAttribute('aria-controls', 'post-wechat-popover');
              openQrPopover();
              announceStatus(statusEl, '已打开扫码分享卡片');
            } else {
              announceStatus(statusEl, '系统分享未能打开，请尝试复制链接');
            }
          }
        }, { signal });
      }
    }

    // 文章打赏按钮点击 / 键盘 / Escape 收起交互
    const rewardBox = document.querySelector('#post .post-reward');
    const rewardBtn = rewardBox && rewardBox.querySelector('.reward-button');
    if (rewardBox && rewardBtn) {
      const setRewardOpen = open => {
        rewardBox.classList.toggle('is-open', open);
        rewardBtn.setAttribute('aria-expanded', String(open));
      };
      rewardBtn.addEventListener('click', e => {
        e.stopPropagation();
        setRewardOpen(!rewardBox.classList.contains('is-open'));
      }, { signal });
      document.addEventListener('click', e => {
        if (rewardBox.classList.contains('is-open') && !rewardBox.contains(e.target)) {
          setRewardOpen(false);
        }
      }, { signal });
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && rewardBox.classList.contains('is-open')) {
          setRewardOpen(false);
          rewardBtn.focus();
        }
      }, { signal });
    }
  };

  window.__moriPostShareInit = initPostShare;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPostShare, { once: true });
  } else {
    initPostShare();
  }
  document.addEventListener('pjax:complete', initPostShare);
})();
