(function () {
    'use strict';

    /* ══════════════════════════════════════════════════════════════════
     *  飞牛影视弹幕增强脚本（弹弹Play 数据源版）
     *  运行环境：通过反向代理注入到飞牛影视 HTML 页面中
     *  弹幕数据：来自弹弹Play API + 第三方弹幕源（CORS 代理）
     *  视频信息：优先读取 MediaWarp 注入的 play/info 缓存，失败时调用飞牛 API
     * ══════════════════════════════════════════════════════════════════ */

    // ─── CORS 代理 & 弹弹Play API 配置 ───
    const DEFAULT_CORS  = 'https://ddplay-api.930524.xyz/cors/';
    const DEFAULT_API   = 'https://api.dandanplay.net';
    const PSEL          = 'div.xgplayer';
    const STORE         = 'fn_dm_dd_cfg_v1';
    const FONT          = '"PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';

    function getApiPrefix() {
        const cors = cfg.customCors || DEFAULT_CORS;
        const api  = cfg.customApi  || (cors + DEFAULT_API);
        return api;
    }

    // ─── 默认配置 ───
    const DEF = {
        on: true, opacity: 0.85, area: 35, fontSize: 22,
        lineHeight: 1.8, speed: 1, outline: true, density: 100,
        maxActive: 40, offset: 0,
        // ede.js 风格设置
        chConvert: 0, danmakuFilter: 0, danmakuModeFilter: 0,
        danmakuDensityLimit: 0, useAnitOverlap: 1,
        customCors: '', customApi: '',
    };

    let cfg = { ...DEF };
    try { Object.assign(cfg, JSON.parse(localStorage.getItem(STORE) || '{}')); } catch {}
    const save = () => localStorage.setItem(STORE, JSON.stringify(cfg));

    // ─── 画布 & 渲染状态 ───
    let cvs, ctx, lW, lH;
    let allDm = [], active = [];
    let eIdx = 0, rowData = [];
    let vid, raf = null;
    let injected = false;
    let showGuide = false;
    let playTime = 0, lastFrame = 0, lastDpr = 0;
    const texCache = new Map();
    let loading = false;

    // ─── UI 元素引用 ───
    let sBar, sTxt, sSub;
    let cntEl;
    let uiEls = [];
    let tooltipEl = null;
    let tipEl = null;
    let searchInp = null;

    // ─── 弹幕数据缓冲 ───
    let lastVideoKey = '';
    let rawDmBuf = null;
    let _epInfo = null; // {episodeId, animeTitle, episodeTitle}
    let _pendingInfo = null;


    /* ══════════════════════════════════════════════════════════════════
     *  工具函数
     * ══════════════════════════════════════════════════════════════════ */

    function $(tag, html, css) {
        const e = document.createElement(tag);
        if (html != null) e.innerHTML = html;
        if (css) e.style.cssText = css;
        return e;
    }

    async function ddFetch(url, opts = {}) {
        const fetchOpts = {
            method: opts.method || 'GET',
            headers: {
                'Accept': 'application/json',
                'User-Agent': navigator.userAgent,
                ...(opts.headers || {}),
            },
        };
        if (opts.body) fetchOpts.body = opts.body;
        console.log('[ddFetch]', fetchOpts.method, url);
        try {
            const r = await fetch(url, fetchOpts);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return await r.json();
        } catch (e) {
            console.error('[ddFetch 失败]', url, e.message);
            throw e;
        }
    }


    /* ══════════════════════════════════════════════════════════════════
     *  弹弹Play API 封装
     * ══════════════════════════════════════════════════════════════════ */

    const ddapi = {
        searchEpisodes(anime) {
            return ddFetch(`${getApiPrefix()}/api/v2/search/episodes?anime=${encodeURIComponent(anime)}`);
        },
        getComments(episodeId) {
            return ddFetch(`${getApiPrefix()}/api/v2/comment/${episodeId}?withRelated=true&chConvert=${cfg.chConvert}`);
        },
        getRelated(episodeId) {
            return ddFetch(`${getApiPrefix()}/api/v2/related/${episodeId}`);
        },
        getExtComment(url) {
            return ddFetch(`${getApiPrefix()}/api/v2/extcomment?chConvert=${cfg.chConvert}&url=${encodeURIComponent(url)}`);
        },
        searchAnime(kw) {
            return ddFetch(`${getApiPrefix()}/api/v2/search/anime?keyword=${encodeURIComponent(kw)}`);
        },
        getBangumi(id) {
            return ddFetch(`${getApiPrefix()}/api/v2/bangumi/${id}`);
        },
        getCommentById(cid) {
            return ddFetch(`${getApiPrefix()}/api/v2/comment/${cid}?format=json&duration=true`);
        },
    };


    /* ══════════════════════════════════════════════════════════════════
     *  视频信息提取（飞牛 play/info API）
     * ══════════════════════════════════════════════════════════════════ */

    /** 从 URL 收集项目和媒体 GUID，媒体 GUID 优先用于 play/info 请求。 */
    function getVideoGuids() {
        // /v/video/{guid}  或  /v/tv/episode/{guid}
        const m = location.pathname.match(/\/v\/(?:video|tv\/episode)\/([a-f0-9]+)/i);
        const itemGuid = m ? m[1] : null;
        const mediaGuid = new URLSearchParams(location.search).get('media_guid');
        return [...new Set([mediaGuid, itemGuid].filter(Boolean))];
    }

    function normalizePlayInfo(data, fallbackGuid) {
        if (!data) return null;
        const item = data.item || {};
        const title     = item.tv_title || item.title || '';
        const season    = item.season_number  || 0;
        const episode   = item.episode_number || 0;
        const isSeries  = data.type === 'Episode' || item.type === 'Episode' || season > 0 || episode > 0;
        const duration  = item.duration || 0;
        const guid      = data.guid || item.guid || data.media_guid || fallbackGuid;

        return { title, season, episode, guid, isSeries, duration };
    }

    function getCachedPlayInfo(guid) {
        const store = window.__MediaWarpFNTVPlayInfo;
        const data = store?.byGuid?.[guid] || null;
        return normalizePlayInfo(data, guid);
    }

    /** 获取飞牛播放信息 */
    async function fetchVideoInfo() {
        const guids = getVideoGuids();
        if (!guids.length) return null;

        for (const guid of guids) {
            const cached = getCachedPlayInfo(guid);
            if (cached?.title) return cached;
        }

        const guid = guids[0];

        try {
            const r = await fetch('/v/api/v1/play/info', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ media_guid: guid }),
            });
            const json = await r.json();
            if (json.code !== 0 || !json.data) return null;

            window.__MediaWarpFNTVPlayInfo?.put?.(json.data, { media_guid: guid });
            return normalizePlayInfo(json.data, guid);
        } catch (e) {
            console.error('[fetchVideoInfo 失败]', e);
            return null;
        }
    }


    /* ══════════════════════════════════════════════════════════════════
     *  弹幕匹配 & 加载（弹弹Play 数据源）
     * ══════════════════════════════════════════════════════════════════ */

    function makeCacheKey(info) {
        return `${info.guid || info.title}_S${info.season || 0}E${info.episode || 0}`;
    }

    /** 获取并加载弹幕 — 主入口 */
    async function fetchAndLoadDanmaku(info) {
        if (!info || !info.title || loading) return;
        loading = true;
        const videoKey = makeCacheKey(info);
        if (videoKey === lastVideoKey && allDm.length > 0) { loading = false; return; }
        lastVideoKey = videoKey;

        flash('正在匹配弹幕…', false, info.title);
        try {
            // 检查缓存
            const cacheKey = '_dd_ep_' + videoKey;
            const cached = localStorage.getItem(cacheKey);
            if (cached) {
                const epInfo = JSON.parse(cached);
                await loadCommentsFromEpisode(epInfo.episodeId, `${epInfo.animeTitle} ${epInfo.episodeTitle}`);
                loading = false;
                return;
            }

            // 搜索番剧
            let animeName = info.title;
            if (info.season > 1) animeName += info.season;

            let result = await ddapi.searchEpisodes(animeName);

            if (!result.animes || result.animes.length === 0) {
                // 尝试去掉年份后缀
                const cleaned = animeName.replace(/\s*\(\d{4}\)\s*$/, '').replace(/\s*\d{4}\s*$/, '').trim();
                if (cleaned !== animeName) {
                    result = await ddapi.searchEpisodes(cleaned);
                    animeName = cleaned;
                }
            }

            if (!result.animes || result.animes.length === 0) {
                flash('自动匹配失败，请手动搜索', true, animeName);
                loading = false;
                return;
            }

            // 取第一个匹配结果
            const anime = result.animes[0];
            const epNum = info.episode || 1;
            const firstEpTitle = anime.episodes?.[0]?.episodeTitle || '';
            const match = firstEpTitle.match(/第(\d+)话/);
            const initEp = match ? parseInt(match[1]) : 1;
            const epIdx = epNum < initEp ? epNum - 1 : epNum - initEp;

            if (!anime.episodes || epIdx < 0 || epIdx >= anime.episodes.length) {
                flash('未找到对应剧集', true, animeName);
                loading = false;
                return;
            }

            const ep = anime.episodes[epIdx];
            const epInfo = {
                episodeId: ep.episodeId,
                animeTitle: anime.animeTitle,
                episodeTitle: `S${String(info.season || 1).padStart(2, '0')}E${String(epNum).padStart(2, '0')} ${ep.episodeTitle}`,
            };
            localStorage.setItem(cacheKey, JSON.stringify(epInfo));

            await loadCommentsFromEpisode(ep.episodeId, `${epInfo.animeTitle} ${epInfo.episodeTitle}`);
        } catch (e) {
            console.error('[匹配异常]', e);
            flash('匹配异常：' + e.message, true);
        }
        loading = false;
    }

    /** 从 episodeId 加载弹幕（主弹幕 + 第三方源） */
    async function loadCommentsFromEpisode(episodeId, desc) {
        try {
            // 1. 获取主弹幕
            const data = await ddapi.getComments(episodeId);
            let comments = data.comments || [];

            // 2. 获取第三方弹幕源
            try {
                const related = await ddapi.getRelated(episodeId);
                if (related.relateds && related.relateds.length > 0) {
                    const { danmakuFilter } = cfg;
                    const matchBili = /^\[BiliBili\]/;
                    let hasBili = comments.some(c => matchBili.test((c.p || '').split(',').pop()));

                    let src = [];
                    for (const s of related.relateds) {
                        if ((danmakuFilter & 1) !== 1 && !hasBili && s.url.includes('bilibili.com/bangumi')) src.push(s.url);
                        if ((danmakuFilter & 1) !== 1 && s.url.includes('bilibili.com/video')) src.push(s.url);
                        if ((danmakuFilter & 2) !== 2 && s.url.includes('gamer')) src.push(s.url);
                        if ((danmakuFilter & 8) !== 8 && !s.url.includes('bilibili') && !s.url.includes('gamer')) src.push(s.url);
                    }

                    const extResults = await Promise.allSettled(src.map(u => ddapi.getExtComment(u)));
                    for (const r of extResults) {
                        if (r.status === 'fulfilled' && r.value?.comments) {
                            comments = comments.concat(r.value.comments);
                        }
                    }
                }
            } catch (e) {
                console.warn('[第三方弹幕源获取失败]', e.message);
            }

            if (comments.length === 0) {
                flash('该集暂无弹幕', true, desc);
                return;
            }

            // 3. 预处理 → 转换为渲染器格式 → 加载
            const processed = preProcessDanmaku(comments, lW || 1920, lH || 1080);
            const finalComments = cfg.useAnitOverlap ? antiOverlapFilter(processed, lW || 1920, lH || 1080) : processed;
            const dmArr = edeToRendererFormat(finalComments);

            loadDm(dmArr);
            flash(`加载成功，${dmArr.length} 条弹幕`, false, desc);
        } catch (e) {
            console.error('[加载弹幕失败]', e);
            flash('加载失败：' + e.message, true, desc);
        }
    }


    /* ══════════════════════════════════════════════════════════════════
     *  弹幕预处理引擎（来自 ede.js）
     *  来源过滤 + 模式过滤 + 密度过滤 + 去重
     * ══════════════════════════════════════════════════════════════════ */

    function preProcessDanmaku(all_cmts, containerWidth, containerHeight) {
        const { fontSize, speed, danmakuFilter, danmakuModeFilter, danmakuDensityLimit, offset } = cfg;
        const lineHeight = cfg.lineHeight || 1.8;

        const disableBilibili = (danmakuFilter & 1) === 1;
        const disableGamer    = (danmakuFilter & 2) === 2;
        const disableDandan   = (danmakuFilter & 4) === 4;
        const disableOther    = (danmakuFilter & 8) === 8;

        const dandanRegex = disableDandan ? /^(?!\[)|^.{0,3}\]/ : null;
        const otherRegex  = disableOther ? /^\[(?!(BiliBili|Gamer)).{3,}\]/ : null;

        let enabledModes = new Set([1, 4, 5, 6]);
        if ((danmakuModeFilter & 1) === 1) enabledModes.delete(4);
        if ((danmakuModeFilter & 2) === 2) enabledModes.delete(5);
        if ((danmakuModeFilter & 4) === 4) { enabledModes.delete(1); enabledModes.delete(6); }

        const shouldFilterDensity = danmakuDensityLimit > 0;
        const duration   = Math.ceil(containerWidth / (speed * 144));
        const lines      = Math.max(1, Math.floor((containerHeight * cfg.area / 100) / (fontSize * lineHeight)));
        const scrollLimit   = (9 - danmakuDensityLimit * 2) * lines;
        const verticalLimit = Math.max(1, lines - 1);

        const uniqueMap = new Map();
        const timeBuckets = {};
        const verticalTimeBuckets = {};
        const result = [];

        for (const comment of all_cmts) {
            const pWithoutUser = comment.p.substring(0, comment.p.lastIndexOf(','));
            const uniqueKey = pWithoutUser + comment.m;
            if (uniqueMap.has(uniqueKey)) continue;
            uniqueMap.set(uniqueKey, true);

            const parts  = comment.p.split(',');
            const time   = parseFloat(parts[0]);
            const modeId = parseInt(parts[1], 10);
            const user   = parts[3] || '';

            if ((disableBilibili && user.startsWith('[BiliBili]')) ||
                (disableGamer && user.startsWith('[Gamer]')) ||
                (dandanRegex && dandanRegex.test(user)) ||
                (otherRegex  && otherRegex.test(user))) continue;

            if (!enabledModes.has(modeId)) continue;

            if (shouldFilterDensity) {
                const timeIndex  = Math.ceil(time / duration);
                const isVertical = modeId === 4 || modeId === 5;
                if (isVertical) {
                    verticalTimeBuckets[timeIndex] = (verticalTimeBuckets[timeIndex] || 0) + 1;
                    if (verticalTimeBuckets[timeIndex] > verticalLimit) continue;
                } else {
                    timeBuckets[timeIndex] = (timeBuckets[timeIndex] || 0) + 1;
                    if (timeBuckets[timeIndex] > scrollLimit) continue;
                }
            }

            result.push({
                text: comment.m,
                mode: { 1: 'rtl', 4: 'bottom', 5: 'top', 6: 'ltr' }[modeId] || 'rtl',
                time: time + offset,
                colorInt: parseInt(parts[2], 10),
            });
        }

        return result;
    }


    /* ══════════════════════════════════════════════════════════════════
     *  弹幕防重叠（来自 ede.js）
     * ══════════════════════════════════════════════════════════════════ */

    const _widthCache = new Map();
    const _measureCtx = document.createElement('canvas').getContext('2d');
    function measureDanmakuWidth(text, font) {
        const k = text + '\x00' + font;
        if (_widthCache.has(k)) return _widthCache.get(k);
        _measureCtx.font = font;
        const w = _measureCtx.measureText(text).width;
        _widthCache.set(k, w);
        return w;
    }

    function antiOverlapFilter(allDanmaku, cw, ch) {
        const fontSize   = cfg.fontSize;
        const lineHeight = cfg.lineHeight || 1.8;
        const area       = cfg.area / 100;
        const trackCount = Math.max(1, Math.floor((ch * area) / (fontSize * lineHeight)));
        const duration   = Math.ceil(cw / (cfg.speed * 144));
        const font       = `bold ${fontSize}px ${FONT}`;

        const sorted = allDanmaku.slice().sort((a, b) => a.time - b.time);
        const groups = { rtl: [], ltr: [], top: [], bottom: [] };
        for (const d of sorted) { if (groups[d.mode]) groups[d.mode].push(d); }

        function filterScroll(arr) {
            if (!arr.length) return [];
            const tracks = new Array(trackCount).fill(0);
            const result = [];
            for (const d of arr) {
                const w = measureDanmakuWidth(d.text, font);
                const actualSpeed = (cw + w) / duration;
                const tEnter = w / actualSpeed;
                for (let i = 0; i < tracks.length; i++) {
                    if (d.time >= tracks[i]) {
                        result.push(d);
                        tracks[i] = d.time + tEnter;
                        break;
                    }
                }
            }
            return result;
        }

        function filterFixed(arr) {
            if (!arr.length) return [];
            const tracks = new Array(trackCount).fill(0);
            const result = [];
            for (const d of arr) {
                for (let i = 0; i < tracks.length; i++) {
                    if (d.time >= tracks[i]) {
                        result.push(d);
                        tracks[i] = d.time + duration;
                        break;
                    }
                }
            }
            return result;
        }

        return [
            ...filterScroll(groups.rtl),
            ...filterScroll(groups.ltr),
            ...filterFixed(groups.top),
            ...filterFixed(groups.bottom),
        ].sort((a, b) => a.time - b.time);
    }


    /* ══════════════════════════════════════════════════════════════════
     *  弹幕格式转换：ede.js 预处理格式 → Canvas 渲染器格式
     * ══════════════════════════════════════════════════════════════════ */

    function edeToRendererFormat(processed) {
        return processed.map(d => {
            const ci = d.colorInt ?? 16777215;
            return {
                text:  d.text,
                color: '#' + ci.toString(16).padStart(6, '0'),
                type:  d.mode === 'bottom' ? 1 : d.mode === 'top' ? 2 : 0,
                time:  d.time,
                w: 0,
            };
        }).sort((a, b) => a.time - b.time);
    }


    /* ══════════════════════════════════════════════════════════════════
     *  弹幕管理
     * ══════════════════════════════════════════════════════════════════ */

    function loadDm(dmArr) {
        console.log('[弹幕] loadDm 收到', dmArr.length, '条');
        allDm = dmArr;
        active = []; eIdx = 0; rowData = [];
        texCache.clear();
        measureAll(); refreshCnt();
        if (vid) onSeek();
        ensureLoop();
    }

    function measureAll() {
        ctx.save();
        ctx.font = `bold ${cfg.fontSize}px ${FONT}`;
        allDm.forEach(d => d.w = ctx.measureText(d.text).width);
        active.forEach(d => d.w = ctx.measureText(d.text).width);
        ctx.restore();
    }

    function clearDm() {
        console.log('[弹幕] 清除');
        allDm = []; active = []; eIdx = 0; rowData = [];
        texCache.clear(); rawDmBuf = null;
        refreshCnt();
    }

    function refreshCnt() {
        if (cntEl) cntEl.textContent = allDm.length ? ` (${allDm.length})` : '';
    }


    /* ══════════════════════════════════════════════════════════════════
     *  弹幕纹理（离屏 Canvas 缓存）
     * ══════════════════════════════════════════════════════════════════ */

    function getTex(text, color) {
        const dpr = window.devicePixelRatio || 1;
        if (dpr !== lastDpr) { texCache.clear(); lastDpr = dpr; }
        const key = `${text}\x00${color}\x00${cfg.fontSize}\x00${cfg.outline}`;
        let e = texCache.get(key);
        if (e) return e;

        const fs = cfg.fontSize;
        const sw = cfg.outline ? Math.max(2, fs / 10) : 0;
        const pad = Math.ceil(sw / 2) + 1;

        const tc = document.createElement('canvas');
        const t = tc.getContext('2d');
        t.font = `bold ${fs}px ${FONT}`;
        const tw = t.measureText(text).width;
        const cW = Math.ceil(tw) + pad * 2;
        const cH = Math.ceil(fs * 1.35) + pad * 2;

        tc.width = cW * dpr;
        tc.height = cH * dpr;
        t.scale(dpr, dpr);
        t.font = `bold ${fs}px ${FONT}`;
        t.textBaseline = 'top';

        if (cfg.outline) {
            t.strokeStyle = 'rgba(0,0,0,0.7)';
            t.lineWidth = sw;
            t.lineJoin = 'round';
            t.strokeText(text, pad, pad);
        }

        t.fillStyle = color;
        t.fillText(text, pad, pad);

        e = { c: tc, w: cW, h: cH, pad };
        texCache.set(key, e);
        if (texCache.size > 600) texCache.delete(texCache.keys().next().value);
        return e;
    }


    /* ══════════════════════════════════════════════════════════════════
     *  Canvas 初始化 & 播放器事件绑定
     * ══════════════════════════════════════════════════════════════════ */

    function initCvs(container, video) {
        const c = $('canvas', null,
            'position:absolute;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;');
        container.style.position = container.style.position || 'relative';
        container.appendChild(c);

        cvs = c;
        ctx = c.getContext('2d', { willReadFrequently: false, alpha: true });
        vid = video;

        function fit() {
            const r = container.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            lW = r.width; lH = r.height;
            c.width = lW * dpr; c.height = lH * dpr;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ensureLoop();
        }

        fit();
        new ResizeObserver(fit).observe(container);
        window.addEventListener('resize', fit);

        video.addEventListener('play',           () => { lastFrame = 0; ensureLoop(); });
        video.addEventListener('pause',          () => { ensureLoop(); });
        video.addEventListener('seeked',         () => onSeek());
        video.addEventListener('loadedmetadata', () => {
            playTime = video.currentTime;
        });
        video.addEventListener('ratechange',     () => { lastFrame = 0; });

        ensureLoop();
    }

    function onSeek() {
        if (!vid) return;
        active = []; rowData = [];
        lastFrame = 0;
        playTime = vid.currentTime;

        const t = vid.currentTime - cfg.offset;
        let lo = 0, hi = allDm.length;
        while (lo < hi) {
            const m = (lo + hi) >> 1;
            allDm[m].time <= t ? lo = m + 1 : hi = m;
        }
        eIdx = lo;
        ensureLoop();
    }


    /* ══════════════════════════════════════════════════════════════════
     *  弹幕渲染主循环
     * ══════════════════════════════════════════════════════════════════ */

    function ensureLoop() {
        if (!raf) { lastFrame = 0; raf = requestAnimationFrame(tick); }
    }

    function tick(ts) {
        const dt = lastFrame ? Math.min((ts - lastFrame) / 1000, 0.05) : 0;
        lastFrame = ts;
        const playing = vid && !vid.paused && !vid.ended;

        if (playing) {
            playTime += dt * (vid.playbackRate || 1);

            const drift = vid.currentTime - playTime;
            if (Math.abs(drift) > 1.5) {
                const delta = vid.currentTime - playTime;
                playTime = vid.currentTime;
                active.forEach(d => { d.born += delta; });
                rowData.forEach(r => { if (r) r.born += delta; });
            } else if (Math.abs(drift) > 0.02) {
                playTime += drift * 0.05;
            }

            if (cfg.on && allDm.length && vid.currentTime > 0) emitNew();
        }

        pruneActive();
        draw();

        if (playing || showGuide) { raf = requestAnimationFrame(tick); }
        else { raf = null; }
    }

    function countVisible() {
        let n = 0;
        for (const d of active) {
            if (d.paused) { n++; continue; }
            if (d.fixed) {
                if ((playTime - d.born) < d.life) n++;
            } else {
                const x = d.startX - (playTime - d.born) * d.spd;
                if (x + d.w > 0) n++;
            }
        }
        return n;
    }

    function emitNew() {
        const ct = vid.currentTime - cfg.offset;
        while (eIdx < allDm.length && allDm[eIdx].time <= ct + 0.2) {
            const dm = allDm[eIdx++];
            if (Math.random() * 100 >= cfg.density) continue;
            if (countVisible() >= cfg.maxActive) continue;
            fire(dm);
        }
    }

    function fire(dm) {
        const fs = cfg.fontSize;
        const lh = fs * cfg.lineHeight;
        const maxR = Math.floor(lH * cfg.area / 100 / lh);
        if (maxR <= 0) return;

        if (dm.type === 0) {
            const r = findRow(dm.w, maxR);
            if (r < 0) return;
            const spd = (120 + Math.random() * 50) * cfg.speed;
            rowData[r] = { born: playTime, spd, w: dm.w };
            active.push({
                text: dm.text, color: dm.color, w: dm.w,
                startX: lW + 5, y: r * lh + fs,
                spd, fixed: false, born: playTime,
                time: dm.time, paused: false, highlight: false
            });
        } else {
            const bound = lH * cfg.area / 100;
            const life = 4;
            active.push({
                text: dm.text, color: dm.color, w: dm.w,
                x: (lW - dm.w) / 2,
                y: dm.type === 2 ? fs * 1.5 : Math.max(fs * 2, bound - fs * 2),
                fixed: true, born: playTime, life,
                time: dm.time, paused: false, highlight: false
            });
        }
    }

    function findRow(nw, maxR) {
        let best = -1, bestClr = -1;
        for (let r = 0; r < maxR; r++) {
            const rd = rowData[r];
            if (!rd) return r;
            const elapsed = playTime - rd.born;
            if (elapsed < 0) continue;
            const rightEdge = (lW + 5) - elapsed * rd.spd + rd.w;
            if (rightEdge < 0) { rowData[r] = null; return r; }
            const clr = lW - rightEdge;
            if (clr > nw + 40 && clr > bestClr) { bestClr = clr; best = r; }
        }
        return best;
    }

    function pruneActive() {
        active = active.filter(d => {
            if (d.paused) return true;
            if (d.fixed) return (playTime - d.born) < d.life;
            const x = d.startX - (playTime - d.born) * d.spd;
            return x > -(lW * 2);
        });
    }


    /* ══════════════════════════════════════════════════════════════════
     *  绘制
     * ══════════════════════════════════════════════════════════════════ */

    function draw() {
        ctx.clearRect(0, 0, lW, lH);

        if (cfg.on && active.length) {
            ctx.save();
            ctx.globalAlpha = cfg.opacity;
            for (const d of active) {
                let x;
                if (d.paused) {
                    x = d.pauseX;
                } else if (d.fixed) {
                    if ((playTime - d.born) > d.life) continue;
                    x = d.x;
                } else {
                    x = d.startX - (playTime - d.born) * d.spd;
                    if (x > lW + 10) continue;
                }
                const tex = getTex(d.text, d.color);
                const dx = x - tex.pad;
                const dy = d.y - tex.pad;

                if (d.highlight) {
                    const p = 4;
                    ctx.fillStyle = 'rgba(79,140,255,0.25)';
                    ctx.beginPath();
                    if (ctx.roundRect) {
                        ctx.roundRect(dx - p, dy - p, tex.w + p * 2, tex.h + p * 2, 6);
                    } else {
                        ctx.rect(dx - p, dy - p, tex.w + p * 2, tex.h + p * 2);
                    }
                    ctx.fill();
                }
                ctx.drawImage(tex.c, dx, dy);
            }
            ctx.restore();
        }

        if (showGuide) {
            const gy = lH * cfg.area / 100;
            ctx.save();
            ctx.fillStyle = 'rgba(79,140,255,0.06)';
            ctx.fillRect(0, 0, lW, gy);
            ctx.globalAlpha = 0.5;
            ctx.strokeStyle = '#4f8cff';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([8, 5]);
            ctx.beginPath();
            ctx.moveTo(0, gy);
            ctx.lineTo(lW, gy);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = '#4f8cff';
            ctx.globalAlpha = 0.8;
            ctx.font = `12px ${FONT}`;
            ctx.textBaseline = 'top';
            ctx.fillText(`弹幕区域 ${cfg.area}%`, 10, gy + 6);
            ctx.restore();
        }
    }


    /* ══════════════════════════════════════════════════════════════════
     *  UI 自动隐藏
     * ══════════════════════════════════════════════════════════════════ */

    function setUIVis(vis) {
        uiEls.forEach(el => {
            el.style.opacity = vis ? '1' : '0';
            el.style.pointerEvents = vis ? (el._dmPE || 'none') : 'none';
        });
    }

    function setupAutoHide(container) {
        let timer, onUI = false;
        function show() {
            if (onUI) return;
            setUIVis(true);
            clearTimeout(timer);
            timer = setTimeout(() => setUIVis(false), 3000);
        }
        function hide() {
            if (onUI) return;
            clearTimeout(timer);
            setUIVis(false);
        }

        container.addEventListener('mousemove', show);
        container.addEventListener('mouseleave', hide);

        let ctrlObs = false;
        function tryObs() {
            if (ctrlObs) return;
            const ctrl = container.querySelector('.xgplayer-controls');
            if (!ctrl) return;
            ctrlObs = true;
            const chk = () => {
                if (!onUI) {
                    parseFloat(getComputedStyle(ctrl).opacity) > 0.1 ? show() : hide();
                }
            };
            ctrl.addEventListener('transitionend', chk);
            new MutationObserver(chk).observe(ctrl, { attributes: true, attributeFilter: ['class', 'style'] });
        }
        new MutationObserver(tryObs).observe(container, { childList: true });
        tryObs();

        uiEls.forEach(el => {
            el.addEventListener('mouseenter', () => { onUI = true; clearTimeout(timer); });
            el.addEventListener('mouseleave', () => {
                onUI = false;
                timer = setTimeout(() => setUIVis(false), 3000);
            });
        });

        show();
    }


    /* ══════════════════════════════════════════════════════════════════
     *  弹幕点击交互
     * ══════════════════════════════════════════════════════════════════ */

    function setupDanmakuTouch(container) {
        tooltipEl = $('div', null,
            'position:absolute;z-index:999998;background:rgba(0,0,0,.85);color:#fff;' +
            'padding:6px 14px;border-radius:8px;font-size:14px;font-weight:bold;' +
            'pointer-events:none;opacity:0;transition:opacity .3s;white-space:nowrap;backdrop-filter:blur(8px);');
        container.appendChild(tooltipEl);

        container.addEventListener('click', (e) => {
            for (const el of uiEls) { if (el.contains(e.target)) return; }
            if (!cfg.on || !active.length || !vid) return;

            const rect = container.getBoundingClientRect();
            const cx = e.clientX - rect.left;
            const cy = e.clientY - rect.top;
            const fs = cfg.fontSize;

            for (let i = active.length - 1; i >= 0; i--) {
                const d = active[i];
                if (d.paused) continue;
                let x;
                if (d.fixed) {
                    if ((playTime - d.born) > d.life) continue;
                    x = d.x;
                } else {
                    x = d.startX - (playTime - d.born) * d.spd;
                }
                if (cx >= x - 4 && cx <= x + d.w + 4 && cy >= d.y - 4 && cy <= d.y + fs * 1.35 + 4) {
                    d.paused = true;
                    d.pauseX = x;
                    d.pauseTime = playTime;
                    d.highlight = true;

                    const t = d.time;
                    tooltipEl.textContent =
                        `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
                    tooltipEl.style.left = Math.min(Math.max(x, 0), lW - 80) + 'px';
                    tooltipEl.style.top = Math.max(d.y - 30, 0) + 'px';
                    tooltipEl.style.opacity = '1';

                    setTimeout(() => {
                        d.paused = false;
                        d.highlight = false;
                        d.born += (playTime - d.pauseTime);
                        tooltipEl.style.opacity = '0';
                    }, 3000);

                    e.stopPropagation();
                    return;
                }
            }
        });
    }


    /* ══════════════════════════════════════════════════════════════════
     *  状态提示条
     * ══════════════════════════════════════════════════════════════════ */

    function flash(msg, err, sub) {
        if (!sBar) return;
        sTxt.textContent = msg;
        sTxt.style.color = err ? '#ff6666' : '#fff';
        sSub.textContent = sub || '';
        clearTimeout(sBar._t);
        sBar.style.opacity = '1';
        sBar._t = setTimeout(() => sBar.style.opacity = '0', 8000);
    }

    function mkStatus(c) {
        sBar = $('div', null,
            'position:absolute;left:20px;bottom:60px;z-index:99999;background:rgba(0,0,0,.75);' +
            'padding:10px 18px;border-radius:10px;font-size:14px;pointer-events:none;' +
            'transition:opacity .4s;opacity:0;backdrop-filter:blur(6px);display:flex;flex-direction:column;gap:4px;');
        sTxt = $('div', null, 'font-weight:500;color:#fff;');
        sSub = $('div', null, 'font-size:12px;color:#aaa;');
        sBar.append(sTxt, sSub);
        c.appendChild(sBar);
    }


    /* ══════════════════════════════════════════════════════════════════
     *  弹幕控制面板
     * ══════════════════════════════════════════════════════════════════ */

    function mkPanel(c) {
        const btn = $('div', '弹幕',
            'position:absolute;top:14px;right:70px;z-index:999999;background:rgba(20,20,20,.85);' +
            'backdrop-filter:blur(10px);color:#fff;border-radius:10px;padding:8px 16px;cursor:pointer;' +
            'font-size:14px;transition:opacity .3s,transform .2s;border:1px solid rgba(255,255,255,.08);' +
            'box-shadow:0 2px 12px rgba(0,0,0,.4);pointer-events:auto;');
        btn._dmPE = 'auto';

        cntEl = $('span', '', 'font-size:12px;color:#aaa;margin-left:4px;');
        btn.appendChild(cntEl);
        btn.onmouseenter = () => btn.style.transform = 'scale(1.05)';
        btn.onmouseleave = () => btn.style.transform = 'scale(1)';

        const pn = $('div', null,
            'position:absolute;top:58px;right:70px;width:420px;max-width:calc(100% - 20px);' +
            'height:600px;max-height:calc(100% - 70px);z-index:999999;background:rgba(18,18,18,.95);' +
            'backdrop-filter:blur(20px);border-radius:16px;overflow:hidden;' +
            'border:1px solid rgba(255,255,255,.08);box-shadow:0 10px 40px rgba(0,0,0,.6);' +
            'pointer-events:none;display:none;flex-direction:column;transition:opacity .3s;');
        pn._dmPE = 'auto';

        // Tab bar
        const tabBar = $('div', null,
            'display:flex;border-bottom:1px solid rgba(255,255,255,.08);flex-shrink:0;');
        const tabS = $('div', '弹幕搜索',
            'flex:1;text-align:center;padding:14px;cursor:pointer;font-size:15px;font-weight:bold;' +
            'color:#fff;border-bottom:2px solid #4f8cff;');
        const tabG = $('div', '&#9881; 设置',
            'flex:1;text-align:center;padding:14px;cursor:pointer;font-size:15px;font-weight:bold;color:#888;');
        tabBar.append(tabS, tabG);

        const vS = $('div', null, 'flex:1;overflow:hidden;display:flex;flex-direction:column;');
        const vG = $('div', null, 'flex:1;overflow-y:auto;display:none;padding:16px;box-sizing:border-box;');

        buildSearch(vS);
        buildSettings(vG);

        function sw(t) {
            const isS = t === 's';
            tabS.style.color = isS ? '#fff' : '#888';
            tabS.style.borderBottom = isS ? '2px solid #4f8cff' : 'none';
            tabG.style.color = isS ? '#888' : '#fff';
            tabG.style.borderBottom = isS ? 'none' : '2px solid #4f8cff';
            vS.style.display = isS ? 'flex' : 'none';
            vG.style.display = isS ? 'none' : 'block';
            showGuide = !isS;
            ensureLoop();
        }
        tabS.onclick = () => sw('s');
        tabG.onclick = () => sw('g');

        pn.append(tabBar, vS, vG);

        btn.onclick = () => {
            const vis = pn.style.display === 'none';
            pn.style.display = vis ? 'flex' : 'none';
            showGuide = vis && tabG.style.color === 'rgb(255, 255, 255)';
            ensureLoop();
        };

        c.append(btn, pn);
        uiEls.push(btn, pn);
    }


    /* ══════════════════════════════════════════════════════════════════
     *  搜索面板
     * ══════════════════════════════════════════════════════════════════ */

    function buildSearch(root) {
        const wrap = $('div', null, 'padding:14px;display:flex;gap:10px;flex-shrink:0;');

        const inp = document.createElement('input');
        inp.placeholder = '输入动漫名称';
        inp.style.cssText =
            'flex:1;background:#2b2b2b;border:none;outline:none;color:#fff;border-radius:10px;' +
            'padding:12px;font-size:14px;';

        const go = $('button', '搜索',
            'background:#4f8cff;border:none;color:#fff;border-radius:10px;padding:0 18px;cursor:pointer;font-size:14px;');
        wrap.append(inp, go);

        const tip = $('div', null, 'padding:0 14px 8px;color:#999;font-size:13px;flex-shrink:0;');
        const list = $('div', null, 'flex:1;overflow-y:auto;padding:0 10px 10px;');

        root.append(wrap, tip, list);

        tipEl = tip;
        searchInp = inp;

        // 面板先可用；播放信息到达后再回填当前剧集。
        void (async () => {
            const info = await fetchVideoInfo();
            if (!info?.title || searchInp !== inp) return;
            inp.value = info.title;
            tip.textContent = info.isSeries
                ? `当前：${info.title} S${String(info.season || 1).padStart(2, '0')}E${String(info.episode || 1).padStart(2, '0')}`
                : `当前：${info.title}`;
        })();

        async function doSearch(kw) {
            if (!kw) return;
            list.innerHTML = '<div style="color:#999;padding:20px;text-align:center;">搜索中...</div>';
            try {
                const r = await ddapi.searchAnime(kw);
                const animes = r.animes || [];
                list.innerHTML = '';
                if (!animes.length) {
                    list.innerHTML = '<div style="color:#999;padding:20px;text-align:center;">无结果</div>';
                    return;
                }
                for (const a of animes) {
                    const it = $('div', null,
                        'background:#252525;border-radius:12px;margin-bottom:10px;padding:14px;cursor:pointer;transition:background .2s;');
                    it.onmouseenter = () => it.style.background = '#303030';
                    it.onmouseleave = () => it.style.background = '#252525';
                    it.innerHTML = `<div style="color:#fff;font-size:15px;font-weight:bold;">${a.animeTitle || a.title || a.name}</div>`;

                    it.onclick = async () => {
                        list.innerHTML = '<div style="color:#999;padding:20px;text-align:center;">加载剧集...</div>';
                        const bg = await ddapi.getBangumi(a.animeId || a.id);
                        const eps = (bg.bangumi?.episodes || bg.episodes || bg.data?.episodes || [])
                            .sort((x, y) => {
                                const xNumber = Number(x.episodeNumber);
                                const yNumber = Number(y.episodeNumber);
                                const xIsMain = Number.isFinite(xNumber);
                                const yIsMain = Number.isFinite(yNumber);

                                if (xIsMain && yIsMain) return xNumber - yNumber;
                                if (xIsMain) return -1;
                                if (yIsMain) return 1;
                                return String(x.episodeNumber || '').localeCompare(
                                    String(y.episodeNumber || ''),
                                    undefined,
                                    { numeric: true },
                                );
                            });
                        list.innerHTML = '';
                        if (!eps.length) {
                            list.innerHTML = '<div style="color:#999;padding:20px;text-align:center;">暂无剧集</div>';
                            return;
                        }
                        for (const ep of eps) {
                            const season = typeof ep.seasonId === 'string'
                                ? ep.seasonId.split('-').pop()
                                : '';
                            const lb = `${season ? `S${season} ` : ''}E${ep.episodeNumber || '?'}`;
                            const epTitle = String(ep.episodeTitle || '').trim();
                            const display = epTitle ? `${lb} · ${epTitle}` : lb;
                            const ed = $('div', null,
                                'background:#252525;border-radius:10px;margin-bottom:8px;padding:12px;cursor:pointer;color:#fff;font-size:14px;');
                            ed.textContent = display;

                            ed.onclick = async () => {
                                ed.textContent = '加载中...';
                                ed.style.color = '#4f8cff';
                                const desc = `${a.animeTitle || a.title} ${lb}`;
                                flash('正在加载弹幕…', false, desc);
                                try {
                                    await loadCommentsFromEpisode(ep.episodeId, desc);
                                } catch (e) {
                                    flash('加载失败：' + e.message, true, desc);
                                } finally {
                                    ed.textContent = display;
                                    ed.style.color = '#fff';
                                }
                            };
                            list.appendChild(ed);
                        }
                    };
                    list.appendChild(it);
                }
            } catch (e) {
                console.error('[搜索失败]', e.message);
                list.innerHTML = '<div style="color:#ff6666;padding:20px;text-align:center;">搜索失败</div>';
            }
        }

        go.onclick = () => doSearch(inp.value.trim());
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(inp.value.trim()); });
    }


    /* ══════════════════════════════════════════════════════════════════
     *  设置面板
     * ══════════════════════════════════════════════════════════════════ */

    function buildSettings(root) {
        function row(l, el) {
            const r = $('div', null,
                'display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;');
            r.append($('span', l, 'color:#ccc;font-size:13px;min-width:70px;'), el);
            return r;
        }

        function sld(min, max, step, val, fmt, cb) {
            const s = document.createElement('input');
            s.type = 'range'; s.min = min; s.max = max; s.step = step; s.value = val;
            s.style.cssText = 'flex:1;margin:0 10px;accent-color:#4f8cff;height:6px;';
            const v = $('span', fmt(val), 'color:#fff;font-size:13px;min-width:52px;text-align:right;');
            s.oninput = () => { v.textContent = fmt(+s.value); cb(+s.value); };
            const w = $('div', null, 'display:flex;align-items:center;flex:1;');
            w.append(s, v);
            return w;
        }

        function tgl(get, flip) {
            const t = $('div', null,
                'width:42px;height:24px;border-radius:12px;cursor:pointer;transition:background .3s;position:relative;flex-shrink:0;');
            const d = $('div', null,
                'width:18px;height:18px;border-radius:50%;background:#fff;position:absolute;top:3px;transition:left .3s;');
            t.appendChild(d);
            const u = () => {
                t.style.background = get() ? '#4f8cff' : '#444';
                d.style.left = get() ? '21px' : '3px';
            };
            t.onclick = () => { flip(); u(); };
            u();
            return t;
        }

        function mkCheck(label, checked, cb) {
            const w = $('div', null, 'display:flex;align-items:center;gap:6px;margin-bottom:6px;');
            const c = document.createElement('input');
            c.type = 'checkbox'; c.checked = checked;
            c.style.cssText = 'accent-color:#4f8cff;width:16px;height:16px;cursor:pointer;';
            c.onchange = () => cb(c.checked);
            w.append(c, $('span', label, 'color:#ccc;font-size:13px;'));
            return w;
        }

        function mkSelect(label, opts, val, cb) {
            const w = $('div', null, 'display:flex;align-items:center;gap:8px;margin-bottom:6px;');
            const sel = document.createElement('select');
            sel.style.cssText = 'background:#333;color:#fff;border:none;border-radius:6px;padding:4px 8px;font-size:13px;';
            opts.forEach(o => {
                const opt = document.createElement('option');
                opt.value = o.v; opt.textContent = o.l;
                if (o.v === val) opt.selected = true;
                sel.appendChild(opt);
            });
            sel.onchange = () => cb(sel.value);
            w.append($('span', label, 'color:#ccc;font-size:13px;min-width:70px;'), sel);
            return w;
        }

        // ─── 显示设置 ───
        const sec1 = $('div', '显示', 'color:#666;font-size:11px;margin-bottom:10px;text-transform:uppercase;letter-spacing:1px;');

        // ─── 密度过滤 & 防重叠 ───
        const sec2 = $('div', '弹幕过滤', 'color:#666;font-size:11px;margin:6px 0 10px;text-transform:uppercase;letter-spacing:1px;');

        // ─── 来源过滤 ───
        const sec3 = $('div', '来源过滤', 'color:#666;font-size:11px;margin:6px 0 10px;text-transform:uppercase;letter-spacing:1px;');

        // ─── CORS 代理配置 ───
        const sec4 = $('div', '弹幕源配置', 'color:#666;font-size:11px;margin:6px 0 10px;text-transform:uppercase;letter-spacing:1px;');

        const corsInput = document.createElement('input');
        corsInput.placeholder = '默认: ' + DEFAULT_CORS;
        corsInput.value = cfg.customCors || '';
        corsInput.style.cssText = 'width:100%;background:#2b2b2b;border:none;color:#fff;border-radius:8px;padding:8px;font-size:12px;margin-bottom:8px;box-sizing:border-box;';

        const apiInput = document.createElement('input');
        apiInput.placeholder = '默认: CORS代理 + ' + DEFAULT_API;
        apiInput.value = cfg.customApi || '';
        apiInput.style.cssText = 'width:100%;background:#2b2b2b;border:none;color:#fff;border-radius:8px;padding:8px;font-size:12px;margin-bottom:8px;box-sizing:border-box;';

        const saveCors = $('button', '保存并重载',
            'width:100%;background:#4f8cff;border:none;color:#fff;border-radius:8px;padding:8px;cursor:pointer;font-size:13px;margin-bottom:16px;');
        saveCors.onclick = async () => {
            cfg.customCors = corsInput.value.trim();
            cfg.customApi = apiInput.value.trim();
            save();
            flash('已保存，重新加载弹幕');
            lastVideoKey = '';
            if (vid) {
                await fetchAndLoadDanmaku(await fetchVideoInfo());
            }
        };

        // ─── 时间偏移 ───
        const sec5 = $('div', '时间', 'color:#666;font-size:11px;margin:6px 0 10px;text-transform:uppercase;letter-spacing:1px;');

        // ─── 操作 ───
        const clr = $('button', '清除当前弹幕',
            'width:100%;background:#333;border:none;color:#ccc;border-radius:8px;padding:10px;cursor:pointer;font-size:13px;margin-top:8px;');
        clr.onmouseenter = () => clr.style.background = '#444';
        clr.onmouseleave = () => clr.style.background = '#333';
        clr.onclick = () => { clearDm(); flash('弹幕已清除'); };

        const reload = $('button', '重新匹配弹幕',
            'width:100%;background:#333;border:none;color:#ccc;border-radius:8px;padding:10px;cursor:pointer;font-size:13px;margin-top:8px;');
        reload.onmouseenter = () => reload.style.background = '#444';
        reload.onmouseleave = () => reload.style.background = '#333';
        reload.onclick = async () => {
            lastVideoKey = '';
            await fetchAndLoadDanmaku(await fetchVideoInfo());
        };

        root.append(
            sec1,
            row('弹幕开关', tgl(() => cfg.on, () => { cfg.on = !cfg.on; save(); ensureLoop(); })),
            row('透明度',   sld(0, 1, 0.05, cfg.opacity, v => v.toFixed(2), v => { cfg.opacity = v; save(); ensureLoop(); })),
            row('显示区域', sld(10, 80, 5, cfg.area, v => v + '%', v => { cfg.area = v; save(); ensureLoop(); })),
            row('文字描边', tgl(() => cfg.outline, () => { cfg.outline = !cfg.outline; save(); texCache.clear(); ensureLoop(); })),
            sec2,
            row('字号',     sld(14, 40, 1, cfg.fontSize, v => v + 'px', v => { cfg.fontSize = v; save(); texCache.clear(); measureAll(); ensureLoop(); })),
            row('行间距',   sld(1.2, 3.0, 0.1, cfg.lineHeight, v => v.toFixed(1) + 'x', v => { cfg.lineHeight = v; save(); })),
            row('滚动速度', sld(0.5, 2.5, 0.1, cfg.speed, v => v.toFixed(1) + 'x', v => { cfg.speed = v; save(); })),
            row('弹幕密度', sld(10, 100, 5, cfg.density, v => v + '%', v => { cfg.density = v; save(); })),
            row('同屏上限', sld(10, 80, 5, cfg.maxActive, v => v + '条', v => { cfg.maxActive = v; save(); })),
            mkCheck('弹幕防重叠', cfg.useAnitOverlap === 1, v => { cfg.useAnitOverlap = v ? 1 : 0; save(); }),
            mkCheck('简体', cfg.chConvert === 1, v => { cfg.chConvert = v ? 1 : 0; save(); }),
            mkCheck('繁体', cfg.chConvert === 2, v => { cfg.chConvert = v ? 2 : 0; save(); }),
            row('密度限制', sld(0, 3, 1, cfg.danmakuDensityLimit, v => ['不限制', '低', '中', '高'][v], v => { cfg.danmakuDensityLimit = v; save(); })),
            sec3,
            mkCheck('屏蔽 B站', (cfg.danmakuFilter & 1) === 1, v => { cfg.danmakuFilter = v ? (cfg.danmakuFilter | 1) : (cfg.danmakuFilter & ~1); save(); }),
            mkCheck('屏蔽 巴哈', (cfg.danmakuFilter & 2) === 2, v => { cfg.danmakuFilter = v ? (cfg.danmakuFilter | 2) : (cfg.danmakuFilter & ~2); save(); }),
            mkCheck('屏蔽 弹弹', (cfg.danmakuFilter & 4) === 4, v => { cfg.danmakuFilter = v ? (cfg.danmakuFilter | 4) : (cfg.danmakuFilter & ~4); save(); }),
            mkCheck('屏蔽 其他', (cfg.danmakuFilter & 8) === 8, v => { cfg.danmakuFilter = v ? (cfg.danmakuFilter | 8) : (cfg.danmakuFilter & ~8); save(); }),
            mkCheck('屏蔽 底部弹幕', (cfg.danmakuModeFilter & 1) === 1, v => { cfg.danmakuModeFilter = v ? (cfg.danmakuModeFilter | 1) : (cfg.danmakuModeFilter & ~1); save(); }),
            mkCheck('屏蔽 顶部弹幕', (cfg.danmakuModeFilter & 2) === 2, v => { cfg.danmakuModeFilter = v ? (cfg.danmakuModeFilter | 2) : (cfg.danmakuModeFilter & ~2); save(); }),
            mkCheck('屏蔽 滚动弹幕', (cfg.danmakuModeFilter & 4) === 4, v => { cfg.danmakuModeFilter = v ? (cfg.danmakuModeFilter | 4) : (cfg.danmakuModeFilter & ~4); save(); }),
            sec4,
            $('div', 'CORS 代理', 'color:#aaa;font-size:12px;margin-bottom:4px;'),
            corsInput,
            $('div', 'API 地址（留空则使用 CORS 代理 + 默认 API）', 'color:#aaa;font-size:12px;margin-bottom:4px;'),
            apiInput,
            saveCors,
            sec5,
            row('偏移量', sld(-30, 30, 0.5, cfg.offset,
                v => (v > 0 ? '+' : '') + v.toFixed(1) + 's', v => { cfg.offset = v; save(); })),
            $('div', '正数=延后  负数=提前', 'color:#555;font-size:11px;margin:-8px 0 14px;padding-left:70px;'),
            reload,
            clr,
        );
    }


    /* ══════════════════════════════════════════════════════════════════
     *  注入主逻辑
     * ══════════════════════════════════════════════════════════════════ */

    async function inject() {
        if (injected) return;
        const container = document.querySelector(PSEL);
        if (!container) return;
        const video = container.querySelector('video');
        if (!video) { setTimeout(inject, 500); return; }

        injected = true;
        console.log('[fn-danmaku-dd] 开始注入弹幕系统');
        initCvs(container, video);
        mkStatus(container);
        mkPanel(container);
        setupAutoHide(container);
        setupDanmakuTouch(container);

        // 读取 play/info 缓存，失败时再由 fetchVideoInfo 请求飞牛 API。
        const injectedPath = location.pathname;
        const info = await fetchVideoInfo();
        if (injected && location.pathname === injectedPath && info?.title) {
            setTimeout(() => fetchAndLoadDanmaku(info), 500);
        }

        console.log('[fn-danmaku-dd] 注入完成');
    }


    /* ══════════════════════════════════════════════════════════════════
     *  SPA 导航监听 & 启动
     * ══════════════════════════════════════════════════════════════════ */

    let lastPath = location.pathname;

    function checkUrlChange() {
        if (location.pathname !== lastPath) {
            const oldPath = lastPath;
            lastPath = location.pathname;
            console.log('[URL变化]', oldPath, '→', lastPath);

            injected = false;
            uiEls.forEach(el => el.remove());
            uiEls = [];
            if (tooltipEl) { tooltipEl.remove(); tooltipEl = null; }
            if (sBar) { sBar.remove(); sBar = null; sTxt = null; sSub = null; }
            if (cvs) { cvs.remove(); cvs = null; }
            if (raf) { cancelAnimationFrame(raf); raf = null; }
            clearDm();
            playTime = 0; lastFrame = 0;
            tipEl = null; searchInp = null;
            lastVideoKey = '';

            setTimeout(inject, 100);
        }
    }

    function startWatch() {
        const target = document.body || document.documentElement;

        new MutationObserver(() => {
            if (document.querySelector(PSEL) && !injected) inject();
        }).observe(target, { childList: true, subtree: true });

        const origPush = history.pushState;
        const origReplace = history.replaceState;

        history.pushState = function () {
            origPush.apply(this, arguments);
            setTimeout(checkUrlChange, 100);
        };
        history.replaceState = function () {
            origReplace.apply(this, arguments);
            setTimeout(checkUrlChange, 100);
        };
        window.addEventListener('popstate', () => setTimeout(checkUrlChange, 100));

        setInterval(checkUrlChange, 2000);

        inject();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startWatch);
    } else {
        startWatch();
    }
})();
