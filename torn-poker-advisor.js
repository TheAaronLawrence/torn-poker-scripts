// ==UserScript==
// @name         Torn Poker Advisor
// @namespace    torn-poker
// @version      1.0.0
// @match        https://www.torn.com/page.php?sid=holdem*
// @run-at       document-start
// @sandbox      JavaScript
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        unsafeWindow
// ==/UserScript==

"use strict";
(() => {
  // src/table/page-source.ts
  var isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
  var isStore = (v) => isObj(v) && typeof v.getState === "function" && typeof v.subscribe === "function";
  function findStore(doc) {
    const root = doc.querySelector('[class*="holdemWrapper"]');
    if (!root) return null;
    const key = Object.keys(root).find((k) => k.startsWith("__reactFiber"));
    let fiber = key ? root[key] : null;
    for (let depth = 0; isObj(fiber) && depth < 50; depth++) {
      const props = fiber.memoizedProps;
      if (isObj(props)) {
        if (isStore(props.store)) return props.store;
        if (isObj(props.value) && isStore(props.value.store)) return props.value.store;
      }
      fiber = fiber.return;
    }
    return null;
  }
  var NOISE = /* @__PURE__ */ new Set(["timeleft", "timebank"]);
  function createPageReader() {
    let tableToken = null;
    let last = "";
    let lastToken = null;
    let lastTable = "";
    return {
      read(state) {
        if (!isObj(state) || !isObj(state.table) || !isObj(state.players) || !isObj(state.self)) return null;
        const { table, players, self } = state;
        if (table.tableDataLoaded === false) return null;
        const ids = isObj(self.handIDs) ? self.handIDs : {};
        const current = typeof ids.currentHandID === "string" && ids.currentHandID !== "" ? ids.currentHandID : null;
        if (current === null) return null;
        if (tableToken === null || table.phase !== "ended") tableToken = current;
        const fields = Object.fromEntries(Object.entries(table).filter(([k]) => !NOISE.has(k)));
        const seated = Object.fromEntries(Object.entries(players).filter(([, p]) => isObj(p) && p.userID !== void 0));
        const body = { ...fields, table: table.tableID, token: tableToken, players: seated, hand: self.hand, holeToken: current };
        const key = JSON.stringify(body);
        if (key === last) return null;
        const tableKey = JSON.stringify(fields);
        const moved = tableToken === lastToken && tableKey !== lastTable;
        last = key;
        lastToken = tableToken;
        lastTable = tableKey;
        const eventType = moved && typeof table.userAction === "string" && table.userAction !== "" ? "playerMakeMove" : "getState";
        return { src: "page", url: "store", data: JSON.stringify({ eventType, ...body }) };
      }
    };
  }
  function watchStore(store2, onFrame) {
    const reader = createPageReader();
    const pump = () => {
      try {
        const f = reader.read(store2.getState());
        if (f) onFrame(f);
      } catch (e) {
        console.warn("[torn-poker] page read failed", e);
      }
    };
    pump();
    return store2.subscribe(pump);
  }
  function watchPage(doc, onFrame, everyMs = 500) {
    const attempt = () => {
      const store2 = findStore(doc);
      if (store2) watchStore(store2, onFrame);
      else setTimeout(attempt, everyMs);
    };
    attempt();
  }

  // src/results/insights.ts
  var SESSION_GAP_MS = 18e5;
  var MIN_RATE_MS = 6e5;
  var PAST_SESSIONS = 8;
  function tally(hands) {
    let bb = 0;
    for (const h of hands) {
      if (h.bigBlind === void 0) {
        bb = null;
        break;
      }
      bb += h.net / h.bigBlind;
    }
    return { hands: hands.length, net: hands.reduce((n, h) => n + h.net, 0), bb };
  }
  var isAggressive = (a) => a === "bet" || a === "raise" || a === "allin";
  function leakSpots(h) {
    const spots = { passedUp: 0, calledFold: 0 };
    const seen = /* @__PURE__ */ new Map();
    for (const a of h.advice) {
      const i = seen.get(a.street) ?? 0;
      seen.set(a.street, i + 1);
      const t = h.taken.filter((x) => x.street === a.street)[i];
      if (!t) continue;
      if (isAggressive(a.action) && (t.action === "check" || t.action === "call")) spots.passedUp++;
      if (a.action === "fold" && t.action === "call") spots.calledFold++;
    }
    return spots;
  }
  function leakReport(hands) {
    const group = (kind) => {
      const mine = hands.filter((h) => leakSpots(h)[kind] > 0);
      return { spots: mine.reduce((n, h) => n + leakSpots(h)[kind], 0), hands: tally(mine) };
    };
    return {
      passedUp: group("passedUp"),
      calledFold: group("calledFold"),
      followed: tally(hands.filter((h) => h.followed === true))
    };
  }
  function splitSessions(hands) {
    const out = [];
    for (const h of hands) {
      const cur = out[out.length - 1];
      if (cur && h.at - cur[cur.length - 1].at < SESSION_GAP_MS) cur.push(h);
      else out.push([h]);
    }
    return out;
  }
  function sessionStats(hands) {
    const t = tally(hands);
    const start = hands[0].at;
    const end = hands[hands.length - 1].at;
    const durationMs = end - start;
    const hours = durationMs / 36e5;
    const perHour = durationMs < MIN_RATE_MS ? null : t.bb !== null ? { value: t.bb / hours, unit: "bb" } : { value: t.net / hours, unit: "money" };
    return {
      start,
      end,
      hands: t.hands,
      net: t.net,
      bb: t.bb,
      bbPer100: t.bb === null ? null : t.bb / t.hands * 100,
      durationMs,
      perHour,
      biggestWin: hands.reduce((m, h) => h.net > 0 ? Math.max(m, h.won) : m, 0),
      biggestWinBb: t.bb === null ? null : hands.reduce((m, h) => h.net > 0 ? Math.max(m ?? 0, h.won / h.bigBlind) : m, null)
    };
  }
  function computeInsights(hands, now) {
    const sessions = splitSessions(hands);
    const last = sessions[sessions.length - 1];
    const live = last && now - last[last.length - 1].at < SESSION_GAP_MS ? last : [];
    const unit = tally(live).bb !== null ? "bb" : "money";
    const points = live.length === 0 ? [] : [0];
    let run = 0;
    for (const h of live) {
      run += unit === "bb" ? h.net / h.bigBlind : h.net;
      points.push(run);
    }
    const finished = live.length > 0 ? sessions.slice(0, -1) : sessions;
    return {
      leaks: { session: leakReport(live), allTime: leakReport(hands) },
      curve: { points, unit },
      past: finished.slice(-PAST_SESSIONS).reverse().map(sessionStats)
    };
  }
  function checkLimits(state, sessionBB, limits) {
    if (sessionBB === null) return { state, fired: null };
    const lossNow = limits.stopLoss !== null && sessionBB <= -limits.stopLoss;
    const winNow = limits.winTarget !== null && sessionBB >= limits.winTarget;
    const fired = lossNow && !state.loss ? "stop-loss" : winNow && !state.win ? "target" : null;
    return { state: { loss: lossNow, win: winNow }, fired };
  }

  // src/ui/glossary.ts
  var STATS = {
    vpip: {
      label: "Hands played",
      abbr: "VPIP",
      help: "How often you put money in before the flop by choice (blinds don\u2019t count).",
      good: [18, 28],
      low: "Very tight: you can open up a little.",
      high: "Playing too many hands."
    },
    pfr: {
      label: "Raised before the flop",
      abbr: "PFR",
      help: "How often you raise before the flop.",
      good: [14, 22],
      low: "Raise more of the hands you play instead of calling.",
      high: "Raising a lot: make sure the hands back it up."
    },
    threeBet: {
      label: "Re-raised a raise",
      abbr: "3-bet",
      help: "When someone raised before you, how often you raised again.",
      good: [5, 10],
      low: "Re-raise your best hands rather than calling.",
      high: "Re-raising a lot: good players will push back."
    },
    af: {
      label: "Aggression",
      abbr: "AF",
      ratio: true,
      help: "After the flop: bets and raises for every call. Below 1.5 is passive.",
      good: [2, 4],
      low: "Passive: bet and raise more, call less.",
      high: "Very aggressive: pick your bluffs."
    },
    foldToRaise: {
      label: "Folded when raised",
      abbr: "Fold to raise",
      help: "When someone raised you, how often you folded.",
      good: [35, 60],
      low: "Hard to push off a hand: fold more weak hands to raises.",
      high: "Easy to push around: players can bluff you off hands."
    },
    cbet: {
      label: "Bets flop after raising",
      abbr: "Continuation bet",
      help: "After you raised before the flop, how often you bet the flop when nobody bet before you.",
      good: [50, 70],
      low: "Giving up too often after raising: bet the flop more when checked to.",
      high: "Betting the flop every time: check your weak hands sometimes."
    },
    foldToCbet: {
      label: "Folds to follow-up bet",
      abbr: "Fold to continuation bet",
      help: "When the player who raised before the flop bets the flop, how often you fold.",
      good: [35, 55],
      low: "Hard to push off a hand: fold more weak hands to a flop bet.",
      high: "Easy to bluff: players bet the flop knowing you will fold."
    },
    wtsd: {
      label: "Went to showdown",
      abbr: "WTSD",
      help: "Of the hands where you saw the flop, how often you got to the end.",
      good: [24, 33],
      low: "Giving up often after the flop.",
      high: "Calling down too much: fold more by the river."
    }
  };
  function verdict(key, value) {
    const g = STATS[key].good;
    if (value === null || !g) return "unknown";
    return value < g[0] ? "low" : value > g[1] ? "high" : "good";
  }
  function formatStat(key, value) {
    if (value === null) return "\u2013";
    return STATS[key].ratio ? value.toFixed(1) : `${Math.round(value)}%`;
  }
  function goodRange(key) {
    const g = STATS[key].good;
    if (!g) return "";
    return STATS[key].ratio ? `${g[0]}\u2013${g[1]}` : `${g[0]}\u2013${g[1]}%`;
  }
  var STYLES = {
    "Tight-Aggressive": { short: "Solid", about: "Plays few hands and bets them hard. The style that wins." },
    Aggro: { short: "Aggro", about: "Plays lots of hands and raises often." },
    Maniac: { short: "Maniac", about: "Bets and raises with almost anything." },
    "Calling station": { short: "Caller", about: "Plays lots of hands and calls rather than raises." },
    Rock: { short: "Rock", about: "Plays very few hands and rarely raises without a big one." },
    Unknown: { short: "Learning", about: "Not enough hands seen to judge yet." }
  };

  // src/results/progress.ts
  var MIN_SESSION_HANDS = 20;
  var SPARK_SESSIONS = 10;
  var ROLLING_SESSIONS = 5;
  var PROGRESS_KEYS = ["vpip", "pfr", "af", "followed"];
  var isRaise = (a) => a === "bet" || a === "raise" || a === "allin";
  function handCounts(h) {
    const pre = h.taken.filter((t) => t.street === "preflop");
    const post = h.taken.filter((t) => t.street !== "preflop");
    return {
      preflopHands: pre.length > 0 ? 1 : 0,
      played: pre.some((t) => t.action === "call" || isRaise(t.action)) ? 1 : 0,
      raised: pre.some((t) => isRaise(t.action)) ? 1 : 0,
      aggressive: post.filter((t) => isRaise(t.action)).length,
      calls: post.filter((t) => t.action === "call").length,
      advisedHands: h.followed === null ? 0 : 1,
      followedHands: h.followed === true ? 1 : 0
    };
  }
  function sum(hands) {
    const c = { preflopHands: 0, played: 0, raised: 0, aggressive: 0, calls: 0, advisedHands: 0, followedHands: 0 };
    for (const h of hands) {
      const k = handCounts(h);
      for (const key of Object.keys(c)) c[key] += k[key];
    }
    return c;
  }
  function playStats(hands) {
    const c = sum(hands);
    const pct5 = (n, d) => d === 0 ? null : n / d * 100;
    return {
      vpip: pct5(c.played, c.preflopHands),
      pfr: pct5(c.raised, c.preflopHands),
      af: c.calls === 0 ? null : c.aggressive / c.calls,
      followed: pct5(c.followedHands, c.advisedHands)
    };
  }
  var LABELS = {
    vpip: STATS.vpip.label,
    pfr: STATS.pfr.label,
    af: STATS.af.label,
    followed: "Following the advice"
  };
  function formatProgress(key, v) {
    if (key !== "followed") return formatStat(key, v);
    return v === null ? "\u2013" : `${Math.round(v)}%`;
  }
  function trendText(key, values) {
    if (values.length < 3) return `Needs at least 3 sessions of ${MIN_SESSION_HANDS}+ hands to show a trend.`;
    const window2 = values.slice(-ROLLING_SESSIONS);
    const from = window2[0];
    const to = window2[window2.length - 1];
    const step = key === "af" ? 0.2 : 3;
    const move = Math.abs(to - from) < step ? `${LABELS[key]} is steady at ${formatProgress(key, to)}` : `${LABELS[key]} is ${to > from ? "up" : "down"} from ${formatProgress(key, from)} to ${formatProgress(key, to)}`;
    const good = key === "followed" ? null : STATS[key].good;
    const range = good && key !== "followed" ? `, ${to < good[0] ? "still below" : to > good[1] ? "above" : "inside"} the ${goodRange(key)} target` : "";
    return `${move} over your last ${window2.length} sessions${range}.`;
  }
  function computeProgress(hands) {
    const all = splitSessions(hands);
    const long = all.filter((s) => s.length >= MIN_SESSION_HANDS);
    const sessions = long.slice(-SPARK_SESSIONS).map((s) => ({ start: s[0].at, hands: s.length, stats: playStats(s) }));
    const pooled = playStats(long.slice(-ROLLING_SESSIONS).flat());
    const stats = PROGRESS_KEYS.map((key) => {
      const values = sessions.map((s) => s.stats[key]).filter((v) => v !== null);
      return {
        key,
        label: LABELS[key],
        values,
        latest: values.length > 0 ? values[values.length - 1] : null,
        rolling: pooled[key],
        good: key === "followed" ? null : STATS[key].good,
        trend: trendText(key, values)
      };
    });
    return { sessions, skipped: all.length - long.length, stats };
  }

  // src/profiles/stats.ts
  var HALF_LIFE_HANDS = 300;
  var MIN_HANDS_FOR_STYLE = 15;
  var LOW_SAMPLE = 30;
  var PRIOR_WEIGHT = 10;
  var PRIOR = { vpip: 24, pfr: 14, threeBet: 5, foldToRaise: 50, wtsd: 28, af: 1.5, cbet: 55, foldToCbet: 45 };
  var MIN_CBET_OPPS = 8;
  var AF_PRIOR_ACTIONS = 4;
  var DECAY = 0.5 ** (1 / HALF_LIFE_HANDS);
  var EPS = 1e-9;
  var zero = () => ({ n: 0, d: 0 });
  function freshStats(userID, name) {
    return {
      userID,
      name,
      hands: 0,
      vpip: zero(),
      pfr: zero(),
      threeBet: zero(),
      foldToRaise: zero(),
      wtsd: zero(),
      postAggr: 0,
      postCalls: 0,
      lastSeen: 0
    };
  }
  function decayed(c) {
    return { n: c.n * DECAY, d: c.d * DECAY };
  }
  function add(c, opportunity, hit) {
    if (!opportunity) return;
    c.d += 1;
    if (hit) c.n += 1;
  }
  function updateStats(prev, hand, userID) {
    const dealt = hand.dealtIn.find((p) => p.userID === userID);
    if (!dealt) return prev;
    const base = prev ?? freshStats(userID, dealt.name);
    const s = {
      ...base,
      name: dealt.name,
      hands: base.hands + 1,
      lastSeen: hand.endedAt,
      vpip: decayed(base.vpip),
      pfr: decayed(base.pfr),
      threeBet: decayed(base.threeBet),
      foldToRaise: decayed(base.foldToRaise),
      wtsd: decayed(base.wtsd),
      cbet: decayed(base.cbet ?? zero()),
      foldToCbet: decayed(base.foldToCbet ?? zero()),
      postAggr: base.postAggr * DECAY,
      postCalls: base.postCalls * DECAY
    };
    let maxBet = hand.bigBlind;
    let street = "preflop";
    let lastAggressor = null;
    let preflopRaises = 0;
    let lastPreflopAggressor = null;
    let vpip = false;
    let pfr = false;
    let folded = false;
    let foldedPreflop = false;
    let threeBetOpp = false;
    let threeBetHit = false;
    let acted = false;
    let cbetDone = false;
    let foldToCbetDone = false;
    let flopFirstAggressor = null;
    const foldOpps = /* @__PURE__ */ new Map();
    for (const a of hand.actions) {
      if (a.street !== street) {
        street = a.street;
        lastAggressor = null;
      }
      const aggressive = a.action === "raise" || a.action === "bet" || a.action === "allin" && a.handBetAfter > maxBet;
      const mine = a.userID === userID;
      if (mine) {
        acted = true;
        const facingRaise = lastAggressor !== null && lastAggressor !== userID;
        if (a.street === "preflop") {
          if (a.action !== "fold" && a.action !== "check") vpip = true;
          if (aggressive) pfr = true;
          if (preflopRaises === 1 && facingRaise) {
            threeBetOpp = true;
            if (aggressive) threeBetHit = true;
          }
        } else {
          if (aggressive) s.postAggr += 1;
          else if (a.action === "call" || a.action === "allin") s.postCalls += 1;
        }
        if (a.street === "flop") {
          if (!cbetDone && lastAggressor === null && lastPreflopAggressor === userID) {
            cbetDone = true;
            add(s.cbet, true, aggressive);
          }
          const facingCbet = flopFirstAggressor !== null && flopFirstAggressor === lastPreflopAggressor && lastAggressor === flopFirstAggressor;
          if (!foldToCbetDone && facingCbet && flopFirstAggressor !== userID) {
            foldToCbetDone = true;
            add(s.foldToCbet, true, a.action === "fold");
          }
        }
        if (facingRaise && !foldOpps.has(a.street)) foldOpps.set(a.street, a.action === "fold");
        if (a.action === "fold") {
          folded = true;
          if (a.street === "preflop") foldedPreflop = true;
        }
      }
      if (aggressive) {
        lastAggressor = a.userID;
        if (a.street === "preflop") {
          preflopRaises += 1;
          lastPreflopAggressor = a.userID;
        }
        if (a.street === "flop" && flopFirstAggressor === null) flopFirstAggressor = a.userID;
      }
      if (a.handBetAfter > maxBet) maxBet = a.handBetAfter;
    }
    for (const [st, hit] of foldOpps) {
      if (st !== "preflop" || hand.complete) add(s.foldToRaise, true, hit);
    }
    if (hand.complete) {
      add(s.vpip, true, vpip);
      add(s.pfr, true, pfr);
      add(s.threeBet, threeBetOpp, threeBetHit);
      const sawFlop = !foldedPreflop && (hand.board.length >= 3 || hand.actions.some((a) => a.street !== "preflop"));
      if (sawFlop && acted) {
        const foldedIds = new Set(hand.actions.filter((a) => a.action === "fold").map((a) => a.userID));
        const actedIds = new Set(hand.actions.map((a) => a.userID));
        const live = hand.dealtIn.filter((p) => actedIds.has(p.userID) && !foldedIds.has(p.userID)).length;
        add(s.wtsd, true, !folded && hand.board.length >= 5 && live >= 2);
      }
    }
    return s;
  }
  function pct(c) {
    return c.d < EPS ? null : c.n / c.d * 100;
  }
  function rates(s) {
    let af;
    if (s.postCalls < EPS && s.postAggr < EPS) af = null;
    else if (s.postCalls < EPS) af = s.postAggr;
    else af = s.postAggr / s.postCalls;
    return {
      vpip: pct(s.vpip),
      pfr: pct(s.pfr),
      threeBet: pct(s.threeBet),
      foldToRaise: pct(s.foldToRaise),
      wtsd: pct(s.wtsd),
      af,
      cbet: pct(s.cbet ?? zero()),
      foldToCbet: pct(s.foldToCbet ?? zero())
    };
  }
  function blendedRates(s) {
    const blend = (c, prior) => (c.n + PRIOR_WEIGHT * prior / 100) / (c.d + PRIOR_WEIGHT) * 100;
    return {
      vpip: blend(s.vpip, PRIOR.vpip),
      pfr: blend(s.pfr, PRIOR.pfr),
      threeBet: blend(s.threeBet, PRIOR.threeBet),
      foldToRaise: blend(s.foldToRaise, PRIOR.foldToRaise),
      wtsd: blend(s.wtsd, PRIOR.wtsd),
      cbet: blend(s.cbet ?? zero(), PRIOR.cbet),
      foldToCbet: blend(s.foldToCbet ?? zero(), PRIOR.foldToCbet),
      af: (s.postAggr + AF_PRIOR_ACTIONS * PRIOR.af) / (s.postCalls + AF_PRIOR_ACTIONS)
    };
  }
  var isEarlyRead = (s) => s.hands < LOW_SAMPLE;
  function readStyle(s) {
    return s.hands < 1 ? "Unknown" : styleOf(blendedRates(s));
  }
  function classify(s) {
    if (s.hands < MIN_HANDS_FOR_STYLE) return "Unknown";
    return styleOf(rates(s));
  }
  function styleOf(r) {
    if (r.vpip === null) return "Unknown";
    const vpip = r.vpip;
    const pfr = r.pfr ?? 0;
    const af = r.af ?? 0;
    if (vpip >= 50 && af >= 3) return "Maniac";
    if (vpip >= 35 && pfr < 12 || vpip >= 25 && pfr < 0.5 * vpip) return "Calling station";
    if (vpip >= 28 && pfr >= 18) return "Aggro";
    if (vpip < 15 || vpip < 25 && pfr < 0.5 * vpip) return "Rock";
    return "Tight-Aggressive";
  }
  function tipFor(style, r) {
    switch (style) {
      case "Maniac":
        return "Bets and raises with almost anything. Call down lighter and let them bluff.";
      case "Calling station":
        return "Calls too much. Value bet big, never bluff.";
      case "Aggro":
        return (r.af ?? 0) >= 2 ? "Raises a lot and keeps firing. Trap with strong hands; don't fold top pair cheaply." : "Raises preflop, then often gives up. Float the flop and bet when they check.";
      case "Rock":
        return "Only plays strong hands. Steal their blinds; fold to their raises without a big hand.";
      case "Tight-Aggressive":
        return "Solid player. Avoid marginal spots; pick on weaker players instead.";
      case "Unknown":
        return "Not enough hands yet.";
    }
  }

  // src/ui/theme.ts
  var THEME = {
    bg: "#1b1b1b",
    text: "#eee",
    muted: "#999",
    good: "#5fd35f",
    warning: "#f0a030",
    bad: "#e05050",
    draw: "#5aa9e6",
    line: "#333",
    /** greys on the dark panel: 6:1 or better */
    subtle: "#aaa",
    focus: "#fff",
    /** reminders and tips on the dark panel */
    note: "#f0c060",
    link: "#5aa0e0",
    zIndex: "2147483000"
  };
  var MIN_TARGET = 24;
  var BADGE = {
    Aggro: "#b03226",
    Maniac: "#a04000",
    "Calling station": "#8e44ad",
    Rock: "#566061",
    "Tight-Aggressive": "#1f6f9f",
    Unknown: "#555555"
  };
  var STYLE_TEXT = {
    Aggro: "#ef6a5c",
    Maniac: "#f0963c",
    "Calling station": "#c48be0",
    Rock: "#a3b0b1",
    "Tight-Aggressive": "#5aa9e6",
    Unknown: "inherit"
  };
  var FOCUSABLE = ":is(button,input,textarea,select,summary,[tabindex])";
  var FOCUS_CSS = `
:is(#tp-advisor,#tp-cards,#tp-hud-row) ${FOCUSABLE}:focus-visible,#tp-hud-toggle button:focus-visible{outline:2px solid ${THEME.focus}!important;outline-offset:2px!important}
`;
  var SHARED_CSS = `
:is(#tp-advisor,#tp-cards,#tp-hud-row) .tp-help{margin:6px 0}
:is(#tp-advisor,#tp-cards,#tp-hud-row) .tp-help summary{cursor:pointer;min-height:${MIN_TARGET}px;display:flex;align-items:center;color:${THEME.subtle};font-size:12px}
:is(#tp-advisor,#tp-cards,#tp-hud-row) .tp-help p{margin:3px 0 6px;font-size:12px;line-height:1.35;color:#ccc}
:is(#tp-advisor,#tp-cards,#tp-hud-row) .tp-help p b{color:${THEME.text}}
`;
  var PANEL_WIDTH = 280;
  var PANEL_CSS = `
#tp-advisor{position:fixed;right:16px;top:120px;width:${PANEL_WIDTH}px;z-index:${THEME.zIndex};background:${THEME.bg};color:${THEME.text};font:13px/1.45 sans-serif;border:1px solid #333;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.55);box-sizing:border-box}
#tp-advisor *{box-sizing:border-box}
#tp-advisor{text-align:left;color-scheme:dark}
#tp-advisor.tp-docked{position:relative;left:auto;top:auto;right:auto;width:100%;margin:0;z-index:auto;box-shadow:none;border:0;border-top:1px solid rgba(255,255,255,.08);border-radius:0;background:rgba(0,0,0,.45);font-size:12px}
#tp-advisor.tp-docked .tp-head{cursor:default;padding:5px 10px;font:14px 'Fjalla One',sans-serif;letter-spacing:.4px;text-transform:uppercase;border-bottom-color:rgba(255,255,255,.08)}
#tp-advisor.tp-docked .tp-grip{display:none}
#tp-advisor.tp-docked .tp-tabs{border-bottom-color:rgba(255,255,255,.08)}
#tp-advisor.tp-docked .tp-tab{padding:5px 0;font:13px 'Fjalla One',sans-serif;letter-spacing:.4px;text-transform:uppercase}
#tp-advisor.tp-docked .tp-body{padding:8px 10px}
#tp-advisor.tp-docked .tp-kv{border-bottom-color:rgba(255,255,255,.06)}
/* the advice line above Torn's buttons already shows the action and equity */
#tp-advisor.tp-docked .tp-big,#tp-advisor.tp-docked .tp-preview-label,#tp-advisor.tp-docked .tp-turn-label,#tp-advisor.tp-docked .tp-eq-line,#tp-advisor.tp-docked .tp-eq,#tp-advisor.tp-docked .tp-meters{display:none}
#tp-advisor .tp-head{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:7px 10px;cursor:move;user-select:none;border-bottom:1px solid ${THEME.line};font-weight:600}
#tp-advisor .tp-title{flex:1;white-space:nowrap}
#tp-advisor .tp-head-net{font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
#tp-advisor .tp-min{background:none;border:0;color:${THEME.text};cursor:pointer;font:14px sans-serif;min-width:${MIN_TARGET}px;min-height:${MIN_TARGET}px;padding:0 6px;border-radius:4px}
#tp-advisor .tp-min:hover,#tp-advisor .tp-alert-close:hover{background:rgba(255,255,255,.12)}
#tp-advisor .tp-tabs{display:flex;border-bottom:1px solid ${THEME.line}}
#tp-advisor .tp-tab{flex:1;background:none;border:0;color:${THEME.muted};cursor:pointer;padding:7px 0;font:13px sans-serif}
#tp-advisor .tp-tab:hover{color:${THEME.text};background:rgba(255,255,255,.06)}
#tp-advisor .tp-tab[aria-selected="true"]{color:${THEME.text};border-bottom:2px solid ${THEME.text}}
#tp-advisor .tp-body{padding:10px}
#tp-advisor .tp-big{font:800 22px sans-serif;margin:0 0 8px;padding:8px 10px;border-radius:6px;border-left:4px solid currentColor;background:rgba(255,255,255,.04);letter-spacing:.3px}
#tp-advisor .tp-preview-label,#tp-advisor .tp-turn-label{font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
#tp-advisor .tp-preview-label{color:${THEME.muted}}
#tp-advisor .tp-turn-label{color:${THEME.warning};font-weight:700}
#tp-advisor .tp-big-preview{opacity:.75;border-left-style:dashed;font-size:18px}
:is(#tp-advisor,#tp-hud-row) .tp-bet{margin:0 0 10px;padding:8px 10px;border:1px solid #333;border-radius:6px;background:#202020}
:is(#tp-advisor,#tp-hud-row) .tp-bet-head{display:flex;justify-content:space-between;align-items:baseline}
:is(#tp-advisor,#tp-hud-row) .tp-bet-title{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:${THEME.muted}}
:is(#tp-advisor,#tp-hud-row) .tp-bet-value{font:800 18px sans-serif;font-variant-numeric:tabular-nums}
:is(#tp-advisor,#tp-hud-row) .tp-bet-sub{font-size:11px;color:${THEME.muted};text-align:right;margin-bottom:4px;font-variant-numeric:tabular-nums}
:is(#tp-advisor,#tp-hud-row) .tp-bet-track{position:relative;margin:4px 0 8px}
:is(#tp-advisor,#tp-hud-row) .tp-bet-range{width:100%;margin:0;accent-color:${THEME.good};cursor:pointer}
:is(#tp-advisor,#tp-hud-row) .tp-bet-tick{position:absolute;top:-4px;width:2px;height:6px;margin-left:-1px;background:${THEME.warning};pointer-events:none}
:is(#tp-advisor,#tp-hud-row) .tp-bet-quick{display:flex;flex-wrap:wrap}
:is(#tp-advisor,#tp-hud-row) .tp-bet-quick button.tp-btn{min-height:${MIN_TARGET}px;padding:4px 8px;margin:0 4px 4px 0;font-size:12px}
:is(#tp-advisor,#tp-hud-row) .tp-bet-quick button.tp-btn[aria-pressed="true"]{background:#4a4a4a!important;border-color:${THEME.focus}!important}
:is(#tp-advisor,#tp-hud-row) .tp-bet-quick button.tp-btn.tp-bet-advised{color:${THEME.warning}!important;border-color:rgba(240,160,48,.5)!important}
:is(#tp-advisor,#tp-hud-row) .tp-bet-note{font-size:12px;color:${THEME.muted}}
:is(#tp-advisor,#tp-hud-row) .tp-meters{display:grid;gap:4px;margin:6px 0}
:is(#tp-advisor,#tp-hud-row) .tp-meter{display:grid;grid-template-columns:44px 80px minmax(0,1fr);align-items:center;gap:8px}
:is(#tp-advisor,#tp-hud-row) .tp-meter-label{font:13px 'Fjalla One',sans-serif;letter-spacing:.4px;text-transform:uppercase;color:#aaa}
:is(#tp-advisor,#tp-hud-row) .tp-meter-bar{position:relative;height:8px;border-radius:4px;background:#1a1a1a;border:1px solid #111;box-shadow:inset 0 1px 3px rgba(0,0,0,.9);overflow:visible}
:is(#tp-advisor,#tp-hud-row) .tp-meter-fill{height:100%;border-radius:4px}
:is(#tp-advisor,#tp-hud-row) .tp-meter-mark{position:absolute;top:-3px;width:2px;height:12px;margin-left:-1px;background:#fff;opacity:.7}
:is(#tp-advisor,#tp-hud-row) .tp-meter-text{font-size:12px;color:#ddd;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
#tp-advisor .tp-eq{height:8px;background:${THEME.line};border-radius:3px;margin:3px 0 6px}
#tp-advisor .tp-eq>div{height:100%;background:${THEME.good};border-radius:3px}
#tp-advisor .tp-kv{display:flex;justify-content:space-between;gap:8px;padding:2px 0;border-bottom:1px solid #252525}
#tp-advisor .tp-kv>span:last-child{text-align:right;font-variant-numeric:tabular-nums}
#tp-advisor .tp-muted{color:${THEME.muted}}
#tp-advisor .tp-chip{display:inline-block;margin-top:6px;padding:1px 8px;border-radius:9px;border:1px solid currentColor;font-size:12px}
:is(#tp-advisor,#tp-hud-row) button.tp-btn{margin:0 6px 6px 0;padding:5px 10px;cursor:pointer;font:600 12px sans-serif;color:${THEME.text}!important;background:#2c2c2c!important;border:1px solid #4a4a4a!important;border-radius:5px;text-shadow:none;box-shadow:none;height:auto;line-height:1.2}
:is(#tp-advisor,#tp-hud-row) button.tp-btn:hover{background:#383838!important;border-color:#666!important}
:is(#tp-advisor,#tp-hud-row) button.tp-btn:active{background:#444!important;border-color:#888!important}
:is(#tp-advisor,#tp-hud-row) button.tp-btn.tp-danger{color:${THEME.bad}!important;border-color:rgba(224,80,80,.5)!important}
:is(#tp-advisor,#tp-hud-row) button.tp-btn.tp-danger:hover{background:rgba(224,80,80,.12)!important}
#tp-advisor .tp-style-about{font-size:12px;margin:2px 0 8px}
#tp-advisor .tp-stats{margin:4px 0 10px}
#tp-advisor .tp-stat-row{padding:4px 0;border-bottom:1px solid #252525}
#tp-advisor .tp-stat-row .tp-kv{border:0;padding:0}
#tp-advisor .tp-abbr{color:${THEME.muted};font-size:11px}
#tp-advisor .tp-stat-note{font-size:12px;color:${THEME.muted};line-height:1.3}
#tp-advisor .tp-section{margin-bottom:12px}
#tp-advisor .tp-section:last-child{margin-bottom:0}
#tp-advisor .tp-section-title,#tp-advisor .tp-subhead,#tp-advisor .tp-heading{margin:0;font-family:inherit;line-height:inherit}
#tp-advisor .tp-section-title{font-size:11px;font-weight:400;text-transform:uppercase;letter-spacing:.5px;color:${THEME.muted};margin-bottom:6px}
#tp-advisor .tp-subhead{font-size:inherit;font-weight:400}
#tp-advisor .tp-heading{font-size:inherit;font-weight:700}
#tp-advisor .tp-you{display:block;width:100%;margin:8px 0 0;padding:2px 0;min-height:${MIN_TARGET}px;background:none;border:0;font:inherit;font-size:12px;text-align:left;cursor:pointer}
#tp-advisor .tp-you:hover{color:${THEME.text}}
#tp-advisor .tp-reminder{margin-top:6px;font-size:12px;color:${THEME.note}}
#tp-advisor .tp-style-badge{padding:0 5px;margin-left:6px;border-radius:3px;font-size:11px;color:#fff}
#tp-advisor .tp-field-error{margin:-2px 0 6px;font-size:12px;color:${THEME.bad}}
#tp-advisor .tp-legend{font-size:12px;color:${THEME.muted};margin:2px 0 4px}
#tp-advisor .tp-hint{font-size:12px;color:${THEME.muted};margin:-2px 0 6px}
#tp-advisor label{display:flex;align-items:center;gap:6px;cursor:pointer;margin-bottom:6px}
#tp-advisor .tp-alert{display:flex;justify-content:space-between;align-items:flex-start;gap:8px;padding:7px 10px;font-size:12px;color:${THEME.warning};background:rgba(240,160,48,.1);border-bottom:1px solid rgba(240,160,48,.35)}
#tp-advisor .tp-alert-close{background:none;border:0;color:inherit;cursor:pointer;font:16px/1 sans-serif;min-width:${MIN_TARGET}px;min-height:${MIN_TARGET}px;padding:0 4px;border-radius:4px}
#tp-advisor .tp-leaks{margin:4px 0 8px}
#tp-advisor .tp-leak-line{font-size:12px;margin-bottom:3px}
#tp-advisor .tp-chart-wrap{margin:8px 0}
#tp-advisor .tp-chart{display:block;width:100%;height:auto;margin-top:2px;background:rgba(255,255,255,.03);border-radius:4px}
#tp-advisor .tp-progress{margin:8px 0}
#tp-advisor .tp-progress-item{padding:4px 0;border-bottom:1px solid #252525}
#tp-advisor .tp-progress-item .tp-kv{border:0;padding:0}
#tp-advisor .tp-progress-item .tp-hint{margin:2px 0 0}
#tp-advisor .tp-num{font-variant-numeric:tabular-nums}
#tp-advisor .tp-past{margin:8px 0}
#tp-advisor .tp-past-item{padding:3px 0;border-bottom:1px solid #252525}
#tp-advisor .tp-past-item .tp-kv{border:0;padding:0}
#tp-advisor .tp-past-item .tp-hint{margin:0}
#tp-advisor ul{margin:4px 0 0;padding-left:16px}
${SHARED_CSS}${FOCUS_CSS}`;

  // src/ui/bet-slider.ts
  function potSized(r, fraction) {
    const top = r.streetBet + r.toCall;
    return top + fraction * (r.pot + r.toCall);
  }
  var el = (doc, tag2, cls, text) => {
    const e = doc.createElement(tag2);
    if (cls) e.className = cls;
    if (text !== void 0) e.textContent = text;
    return e;
  };
  var guard = (what, fn) => (...args) => {
    try {
      fn(...args);
    } catch (e) {
      console.warn(`[torn-poker] ${what} failed`, e);
    }
  };
  var SET_AMOUNT = "tp-set-amount";
  var FILL_FAILED = "tp-fill-failed";
  var NUDGE = "tp-nudge";
  var MISSING_BOX = "Couldn\u2019t find Torn\u2019s bet box. Wait for your turn, then try again.";
  function buildBetSlider(doc, a, r, opts = {}) {
    const wrap = el(doc, "div", "tp-bet");
    const bb = r.bigBlind > 0 ? r.bigBlind : 1;
    const step = [bb / 4, bb / 2, bb].find((x) => Number.isInteger(x) && x >= 1) ?? 1;
    const bound = (x) => Math.min(r.max, Math.max(r.min, x));
    const snap = (x) => bound(Math.round(x / step) * step);
    const advised = (a.action === "bet" || a.action === "raise" || a.action === "allin") && a.amount !== null ? bound(a.amount) : null;
    const head = el(doc, "div", "tp-bet-head");
    head.append(el(doc, "span", "tp-bet-title", r.kind === "raise" ? "Raise to" : "Bet"));
    const readout = el(doc, "span", "tp-bet-value");
    head.append(readout);
    const sub = el(doc, "div", "tp-bet-sub");
    const range = el(doc, "input");
    range.type = "range";
    range.className = "tp-bet-range";
    range.min = String(r.min);
    range.max = String(r.max);
    range.step = "any";
    range.setAttribute("aria-label", r.kind === "raise" ? "Raise to" : "Bet amount");
    range.title = "Fills Torn\u2019s bet box. You press Torn\u2019s button.";
    const track = el(doc, "div", "tp-bet-track");
    track.append(range);
    if (advised !== null && r.max > r.min) {
      const tick = el(doc, "div", "tp-bet-tick");
      tick.setAttribute("aria-hidden", "true");
      tick.style.left = `${(advised - r.min) / (r.max - r.min) * 100}%`;
      track.append(tick);
    }
    const chips = [];
    const note = el(doc, "div", "tp-bet-note", "Fills Torn\u2019s bet box. You press Torn\u2019s button.");
    note.setAttribute("aria-live", "polite");
    const show = (amount) => {
      const along = r.max > r.min ? (amount - r.min) / (r.max - r.min) * 100 : 100;
      range.style.setProperty("--tp-fill", `${Math.min(100, Math.max(0, along))}%`);
      readout.textContent = `${Number((amount / bb).toFixed(2))} BB`;
      const potPct = r.pot > 0 ? Math.round((amount - r.streetBet - r.toCall) / (r.pot + r.toCall) * 100) : null;
      sub.textContent = [
        `$${Math.round(amount).toLocaleString("en-US")}`,
        amount >= r.max ? "all-in" : potPct !== null ? `${Math.max(0, potPct)}% pot` : "",
        advised !== null && amount === advised ? "advised" : ""
      ].filter(Boolean).join(" \xB7 ");
      range.setAttribute("aria-valuetext", `${readout.textContent}, ${sub.textContent.split(" \xB7 ").join(", ")}`);
      for (const c of chips) c.button.setAttribute("aria-pressed", String(Math.abs(c.at() - amount) < 0.5));
    };
    const showFailure = () => {
      note.textContent = MISSING_BOX;
      note.style.color = THEME.bad;
      note.classList.add("tp-bet-error");
    };
    const pick = (amount, exact = false) => {
      const v = exact ? bound(amount) : snap(amount);
      range.value = String(v);
      show(v);
      if (r.onChange(v)) {
        note.textContent = "Filled in Torn\u2019s bet box. Press Torn\u2019s button to bet.";
        note.style.color = "";
        note.classList.remove("tp-bet-error");
      } else showFailure();
    };
    const stepFrom = (n) => {
      let v = Number(range.value);
      for (let i = 0; i < Math.abs(n); i++) {
        v = bound(n > 0 ? (Math.floor(v / step + 1e-9) + 1) * step : (Math.ceil(v / step - 1e-9) - 1) * step);
      }
      return v;
    };
    wrap.addEventListener(SET_AMOUNT, (e) => {
      const amount = Number(e.detail);
      if (!Number.isFinite(amount)) return;
      range.value = String(bound(amount));
      show(bound(amount));
    });
    wrap.addEventListener(FILL_FAILED, showFailure);
    wrap.addEventListener(NUDGE, guard("bet nudge", (e) => {
      pick(stepFrom(Number(e.detail) < 0 ? -1 : 1));
    }));
    range.addEventListener("input", guard("bet slider", () => pick(Number(range.value))));
    range.addEventListener("keydown", guard("bet slider key", (e) => {
      const jump = {
        ArrowRight: () => stepFrom(1),
        ArrowUp: () => stepFrom(1),
        ArrowLeft: () => stepFrom(-1),
        ArrowDown: () => stepFrom(-1),
        PageUp: () => stepFrom(10),
        PageDown: () => stepFrom(-10),
        Home: () => r.min,
        End: () => r.max
      };
      const to = jump[e.key];
      if (!to) return;
      e.preventDefault();
      pick(to(), e.key === "Home" || e.key === "End");
    }));
    const quick = el(doc, "div", "tp-bet-quick");
    const chip = (label, amount, exact = false) => {
      const b = el(doc, "button", "tp-btn", label);
      b.type = "button";
      chips.push({ button: b, at: () => exact ? bound(amount) : snap(amount) });
      b.addEventListener("click", guard(`bet ${label}`, () => pick(amount, exact)));
      quick.append(b);
      return b;
    };
    chip("Min", r.min, true);
    chip("\xBD pot", potSized(r, 0.5));
    chip("\u2154 pot", potSized(r, 2 / 3));
    chip("Pot", potSized(r, 1));
    chip("All-in", r.max, true);
    if (advised !== null) chip("Advised", advised, true).classList.add("tp-bet-advised");
    const start = advised ?? r.min;
    range.value = String(start);
    show(start);
    wrap.append(head, sub, track);
    if (opts.chips !== false) wrap.append(quick);
    wrap.append(note);
    return wrap;
  }

  // src/ui/help-list.ts
  function helpList(doc, summary, items) {
    const box = doc.createElement("details");
    box.className = "tp-help";
    const head = doc.createElement("summary");
    head.textContent = summary;
    box.append(head);
    for (const [name, text] of items) {
      const p = doc.createElement("p");
      const b = doc.createElement("b");
      b.textContent = name;
      p.append(b, ` ${text}`);
      box.append(p);
    }
    return box;
  }

  // src/ui/meters.ts
  var pct2 = (x) => `${Math.round(x * 100)}%`;
  var clamp01 = (x) => Math.min(1, Math.max(0, x));
  function strengthColor(value) {
    return value >= 0.66 ? THEME.good : value >= 0.33 ? THEME.warning : THEME.bad;
  }
  function winColor(equity, potOdds) {
    if (potOdds !== null) return equity >= potOdds ? THEME.good : THEME.bad;
    return strengthColor(equity);
  }
  function winText(a) {
    const n = a.opponents;
    const vs = n === void 0 ? "" : ` vs ${n} ${n === 1 ? "player" : "players"}`;
    return `${pct2(a.equity)}${vs}${a.potOdds !== null ? ` \xB7 need ${pct2(a.potOdds)}` : ""}`;
  }
  function drawText(d) {
    return `${d.name} \xB7 ${d.outs} ${d.outs === 1 ? "out" : "outs"} \xB7 ${pct2(d.hitChance)} by the river`;
  }
  function buildMeters(doc, a) {
    const el2 = (tag2, cls, text) => {
      const e = doc.createElement(tag2);
      if (cls) e.className = cls;
      if (text !== void 0) e.textContent = text;
      return e;
    };
    const meter = (label, value, color, text, help, mark) => {
      const row = el2("div", "tp-meter");
      row.title = help;
      const bar = el2("div", "tp-meter-bar");
      bar.setAttribute("aria-hidden", "true");
      const fill = el2("div", "tp-meter-fill");
      fill.style.width = pct2(clamp01(value));
      fill.style.background = color;
      bar.append(fill);
      if (mark !== void 0) {
        const tick = el2("div", "tp-meter-mark");
        tick.style.left = pct2(clamp01(mark));
        bar.append(tick);
      }
      row.append(el2("span", "tp-meter-label", label), bar, el2("span", "tp-meter-text", text));
      return row;
    };
    const box = el2("div", "tp-meters");
    const helps = [];
    const add2 = (label, value, color, text, help, mark) => {
      box.append(meter(label, value, color, text, help, mark));
      helps.push([label, help]);
    };
    if (a.strength) {
      add2(
        "Hand",
        a.strength.value,
        strengthColor(a.strength.value),
        `${a.hand} \xB7 ${a.strength.note.toLowerCase()}`,
        "Hand strength on its own: before the flop, how your two cards rank among all starting hands; after it, how many possible hands you beat right now."
      );
    }
    if (a.draw) {
      add2(
        "Draw",
        a.draw.hitChance,
        THEME.draw,
        drawText(a.draw),
        "Cards that would complete your draw, and the chance one arrives by the river. On the flop you may have to pay again on the turn, so the Win line is the better guide to calling."
      );
    }
    add2(
      "Win",
      a.equity,
      winColor(a.equity, a.potOdds),
      winText(a),
      "Chance of winning the pot against the players still in, given how they play. \u201CNeed\u201D is what a call has to win to break even.",
      a.potOdds ?? void 0
    );
    box.append(helpList(doc, "What these mean", helps));
    return box;
  }

  // src/ui/format.ts
  function formatMoney(n) {
    const body = Math.abs(n).toLocaleString("en-US");
    return n > 0 ? `+${body}` : n < 0 ? `\u2212${body}` : body;
  }
  function formatBB(n) {
    const r = Number(n.toFixed(2));
    const body = Math.abs(r).toString();
    return `${r > 0 ? "+" : r < 0 ? "\u2212" : ""}${body} BB`;
  }

  // src/core/cards.ts
  var SUIT_NAMES = ["clubs", "diamonds", "hearts", "spades"];
  var SUIT_SYMBOLS = ["\u2663", "\u2666", "\u2665", "\u2660"];
  var RANK_NAMES = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
  function parseCard(s) {
    const dash = s.indexOf("-");
    if (dash < 0) return null;
    const suit = SUIT_NAMES.indexOf(s.slice(0, dash));
    const rank = RANK_NAMES.indexOf(s.slice(dash + 1));
    if (suit < 0 || rank < 0) return null;
    return rank * 4 + suit;
  }
  function formatCard(c) {
    return RANK_NAMES[rankOf(c)] + SUIT_SYMBOLS[suitOf(c)];
  }
  function rankOf(c) {
    return c >> 2;
  }
  function suitOf(c) {
    return c & 3;
  }

  // src/results/results.ts
  var KEY = "results";
  var SAVE_DELAY_MS = 3e4;
  var MAX_PENDING = 20;
  var RECENT = 20;
  var MAX_HANDS = 5e3;
  var family = (a) => a === "bet" || a === "raise" || a === "allin" ? "aggressive" : a;
  var num = (v) => typeof v === "number" && Number.isFinite(v);
  var STREETS = /* @__PURE__ */ new Set(["preflop", "flop", "turn", "river"]);
  var ACTIONS = /* @__PURE__ */ new Set(["fold", "check", "call", "bet", "raise", "allin"]);
  function isHeroHand(v) {
    if (v === null || typeof v !== "object") return false;
    const h = v;
    const step = (x) => {
      if (x === null || typeof x !== "object") return false;
      const s = x;
      return STREETS.has(s.street) && ACTIONS.has(s.action);
    };
    return typeof h.handId === "string" && (h.tableId === null || num(h.tableId)) && (h.bigBlind === void 0 || num(h.bigBlind) && h.bigBlind > 0) && (h.board === void 0 || Array.isArray(h.board) && h.board.length <= 5 && h.board.every(num)) && num(h.at) && (h.cards === null || Array.isArray(h.cards) && h.cards.length === 2 && h.cards.every(num)) && num(h.invested) && num(h.won) && num(h.net) && (h.followed === null || typeof h.followed === "boolean") && Array.isArray(h.taken) && h.taken.every(step) && Array.isArray(h.advice) && h.advice.every((a) => step(a) && (a.amount === null || num(a.amount)));
  }
  function validHands(v) {
    if (v === null || typeof v !== "object") return null;
    const o = v;
    if (o.version !== 1 || !Array.isArray(o.hands)) return null;
    return o.hands.filter(isHeroHand);
  }
  var Results = class {
    constructor(store2) {
      this.store = store2;
      let stored;
      try {
        stored = store2.get(KEY);
      } catch (err) {
        console.warn("[torn-poker] failed to read results", err);
      }
      this.hands = (validHands(stored) ?? []).slice(-MAX_HANDS);
    }
    store;
    hands = [];
    /** advice per hand, in the order it was given */
    pending = /* @__PURE__ */ new Map();
    timer = null;
    recordAdvice(handId, street, a) {
      let advice = this.pending.get(handId);
      if (!advice) {
        advice = [];
        this.pending.set(handId, advice);
        while (this.pending.size > MAX_PENDING) {
          const oldest = this.pending.keys().next().value;
          this.pending.delete(oldest);
        }
      }
      advice.push({ street, action: a.action, amount: a.amount });
    }
    /** the stored hand, or null when nothing was stored (hero not dealt in, no result, or a repeat) */
    recordHand(hand) {
      const pending = this.pending.get(hand.handId);
      this.pending.delete(hand.handId);
      if (!hand.dealtIn.some((p) => p.userID === hand.heroId)) return null;
      if (Object.keys(hand.winnings).length === 0) return null;
      if (this.hands.some((h) => h.handId === hand.handId)) return null;
      const advice = pending ?? [];
      const taken = hand.actions.filter((a) => a.userID === hand.heroId).map((a) => ({ street: a.street, action: a.action }));
      const seen = /* @__PURE__ */ new Map();
      const followed = advice.length === 0 ? null : advice.every((a) => {
        const i = seen.get(a.street) ?? 0;
        seen.set(a.street, i + 1);
        const t = taken.filter((x) => x.street === a.street)[i];
        return t !== void 0 && family(t.action) === family(a.action);
      });
      const invested = hand.invested[hand.heroId] ?? 0;
      const won = hand.winnings[hand.heroId] ?? 0;
      const stored = {
        handId: hand.handId,
        tableId: hand.tableId,
        ...hand.bigBlind > 0 ? { bigBlind: hand.bigBlind } : {},
        at: hand.endedAt,
        cards: hand.heroCards,
        ...hand.board.length > 0 ? { board: [...hand.board] } : {},
        invested,
        won,
        net: won - invested,
        advice,
        taken,
        followed
      };
      this.hands.push(stored);
      if (this.hands.length > MAX_HANDS) this.hands.splice(0, this.hands.length - MAX_HANDS);
      if (this.timer === null) this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
      return stored;
    }
    summary(now) {
      const hs = this.hands;
      let session = [];
      const last = hs[hs.length - 1];
      if (last && now - last.at < SESSION_GAP_MS) {
        let start = hs.length - 1;
        while (start > 0 && hs[start].at - hs[start - 1].at < SESSION_GAP_MS) start--;
        session = hs.slice(start);
      }
      return {
        session: tally(session),
        allTime: tally(hs),
        followed: tally(hs.filter((h) => h.followed === true)),
        ignored: tally(hs.filter((h) => h.followed === false)),
        recent: hs.slice(-RECENT).reverse(),
        insights: computeInsights(hs, now),
        progress: computeProgress(hs)
      };
    }
    flush() {
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      try {
        this.store.set(KEY, this.snapshot());
      } catch (err) {
        console.warn("[torn-poker] failed to save results", err);
      }
    }
    exportJSON() {
      return JSON.stringify(this.snapshot(), null, 2);
    }
    importJSON(text) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("Not a results export");
      }
      const incoming = validHands(parsed);
      if (!incoming) throw new Error("Not a results export");
      const known = new Set(this.hands.map((h) => h.handId));
      const fresh = incoming.filter((h) => !known.has(h.handId));
      this.hands = [...this.hands, ...fresh].sort((a, b) => a.at - b.at).slice(-MAX_HANDS);
      this.flush();
      return fresh.length;
    }
    snapshot() {
      return { version: 1, hands: this.hands };
    }
  };

  // src/results/review.ts
  var STREETS2 = ["preflop", "flop", "turn", "river"];
  var BOARD_LEN = { preflop: 0, flop: 3, turn: 4, river: 5 };
  var STREET_NAME = { preflop: "Preflop", flop: "Flop", turn: "Turn", river: "River" };
  var WHERE = { preflop: "before the flop", flop: "on the flop", turn: "on the turn", river: "on the river" };
  var DID = { fold: "Folded", check: "Checked", call: "Called", bet: "Bet", raise: "Raised", allin: "Went all in" };
  var ADVISED = { fold: "Fold", check: "Check", call: "Call", bet: "Bet", raise: "Raise to", allin: "All in" };
  var TO = { fold: "fold", check: "check", call: "call", bet: "bet", raise: "raise", allin: "go all in" };
  var NOUN = { fold: "a fold", check: "a check", call: "a call", bet: "a bet", raise: "a raise", allin: "an all-in" };
  var streetName = (s) => STREET_NAME[s];
  var dollars = (n) => `$${Math.abs(n).toLocaleString("en-US")}`;
  function adviceText(action, amount, bigBlind) {
    if (amount === null) return ADVISED[action];
    const money = dollars(amount);
    return bigBlind ? `${ADVISED[action]} ${Number((amount / bigBlind).toFixed(2))} BB (${money})` : `${ADVISED[action]} ${money}`;
  }
  function resultPhrase(net, bigBlind) {
    if (net === 0) return "you broke even";
    const size = bigBlind ? `${Number((Math.abs(net) / bigBlind).toFixed(2))} BB` : dollars(net);
    return `you ${net > 0 ? "won" : "lost"} ${size}`;
  }
  function takeawayFor(row, net, bigBlind) {
    const adv = row.advised;
    const did = row.did;
    const result = resultPhrase(net, bigBlind);
    const lead = `You ${DID[did.action].toLowerCase()} ${WHERE[row.street]} when the advice was to ${TO[adv.action]}`;
    const advFam = family(adv.action);
    const didFam = family(did.action);
    if (advFam === "fold") {
      if (net < 0) return `${lead} \u2014 ${result}; folding might have saved some of that.`;
      if (net > 0) return `${lead} \u2014 ${result}. It worked out this time, but one win does not make it the better choice.`;
      return `${lead} \u2014 ${result}.`;
    }
    if (didFam === "fold") return `${lead} \u2014 ${result}; staying in might have turned out differently.`;
    if (advFam === "aggressive") {
      return net > 0 ? `${lead} \u2014 ${result}; ${NOUN[adv.action]} might have won more.` : `${lead} \u2014 ${result}; ${NOUN[adv.action]} might have turned out differently.`;
    }
    if (didFam === "aggressive") {
      if (net > 0) return `${lead} \u2014 ${result}. It worked out, but it risked more than the advice did.`;
      if (net < 0) return `${lead} \u2014 ${result}; ${NOUN[adv.action]} would have risked less.`;
      return `${lead} \u2014 ${result}.`;
    }
    return `${lead} \u2014 ${result}.`;
  }
  function buildReview(hand) {
    const board = hand.board ?? [];
    const bb = hand.bigBlind;
    const rows = [];
    for (const street of STREETS2) {
      const advice = hand.advice.filter((a) => a.street === street);
      const taken = hand.taken.filter((t) => t.street === street);
      for (let i = 0; i < Math.max(advice.length, taken.length); i++) {
        const a = advice[i];
        const t = taken[i];
        rows.push({
          street,
          again: i > 0,
          board: board.slice(0, BOARD_LEN[street]),
          advised: a ? { action: a.action, amount: a.amount, text: adviceText(a.action, a.amount, bb) } : null,
          did: t ? { action: t.action, text: DID[t.action] } : null,
          matched: a && t ? family(a.action) === family(t.action) : null
        });
      }
    }
    const deepest = rows.reduce((n, r) => Math.max(n, r.board.length), 0);
    const first = rows.find((r) => r.matched === false);
    return {
      cards: hand.cards,
      net: hand.net,
      netBB: bb ? hand.net / bb : null,
      resultText: bb ? `${formatBB(hand.net / bb)} (${formatMoney(hand.net)})` : formatMoney(hand.net),
      rows,
      runout: board.length > deepest ? board : null,
      takeaway: first ? takeawayFor(first, hand.net, bb) : null
    };
  }

  // src/ui/hand-review.ts
  var REVIEW_CSS = `
#tp-advisor .tp-cards{display:inline-flex;flex-wrap:wrap;gap:5px;vertical-align:baseline}
#tp-advisor .tp-card{font-weight:700;white-space:nowrap}
#tp-advisor .tp-card-red{color:${THEME.bad}}
#tp-advisor .tp-hand-item{border-bottom:1px solid #252525}
#tp-advisor button.tp-hand-row{display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%;min-height:28px;margin:0;padding:2px 0;text-align:left;font:inherit;line-height:1.3;cursor:pointer;color:inherit!important;background:none!important;border:0!important;border-radius:3px;text-shadow:none;box-shadow:none;height:auto;font-variant-numeric:tabular-nums}
#tp-advisor button.tp-hand-row:hover{background:rgba(255,255,255,.05)!important}
#tp-advisor .tp-hand-main{display:flex;align-items:center;gap:6px}
#tp-advisor .tp-hand-chevron{display:inline-block;width:10px;color:${THEME.muted};font-size:11px}
#tp-advisor .tp-hand-side{display:flex;align-items:center;gap:8px;text-align:right}
#tp-advisor .tp-review{margin:8px 0;padding:8px 10px;border:1px solid #333;border-radius:6px;background:#202020;font-variant-numeric:tabular-nums}
#tp-advisor .tp-hand-item>.tp-review{margin:4px 0 8px}
#tp-advisor .tp-review-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px;flex-wrap:wrap}
#tp-advisor .tp-review-title{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:${THEME.muted};margin-bottom:4px}
#tp-advisor .tp-review-result{font-weight:700}
#tp-advisor .tp-review-rows{list-style:none;margin:6px 0 0;padding:0}
#tp-advisor .tp-review-row{padding:5px 0;border-top:1px solid #252525}
#tp-advisor .tp-review-street{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px;font-weight:600}
#tp-advisor .tp-review-line{display:flex;gap:8px;align-items:baseline}
#tp-advisor .tp-review-label{flex:0 0 52px;font-size:11px;color:${THEME.muted}}
#tp-advisor .tp-review-match{margin-left:auto;font-size:11px;font-weight:700;white-space:nowrap}
#tp-advisor .tp-review-take{margin:8px 0 0;font-size:12px}
#tp-advisor .tp-review-none{margin:6px 0 0;font-size:12px;color:${THEME.muted}}
`;
  var make = (doc, tag2, cls, text) => {
    const e = doc.createElement(tag2);
    if (cls) e.className = cls;
    if (text !== void 0) e.textContent = text;
    return e;
  };
  function cardsEl(doc, cards) {
    const wrap = make(doc, "span", "tp-cards");
    if (cards === null || cards.length === 0) {
      wrap.textContent = "Cards not seen";
      wrap.classList.add("tp-muted");
      return wrap;
    }
    for (const c of cards) {
      const red = suitOf(c) === 1 || suitOf(c) === 2;
      wrap.append(make(doc, "span", red ? "tp-card tp-card-red" : "tp-card", formatCard(c)));
    }
    return wrap;
  }
  function buildReviewCard(doc, r, heading) {
    const card = make(doc, "section", "tp-review");
    card.setAttribute("aria-label", "Hand review");
    if (heading) card.append(make(doc, "div", "tp-review-title", heading));
    const head = make(doc, "div", "tp-review-head");
    const mine = make(doc, "span");
    mine.append("Your cards ", cardsEl(doc, r.cards));
    const result = make(doc, "span", "tp-review-result", r.resultText);
    result.style.color = r.net > 0 ? THEME.good : r.net < 0 ? THEME.bad : THEME.muted;
    head.append(mine, result);
    card.append(head);
    if (r.rows.length === 0) {
      card.append(make(doc, "div", "tp-review-none", "No advice or actions were recorded for this hand."));
    } else {
      const list = make(doc, "ol", "tp-review-rows");
      for (const row of r.rows) {
        const li = make(doc, "li", "tp-review-row");
        const street = make(doc, "div", "tp-review-street");
        street.append(make(doc, "span", void 0, row.again ? `${streetName(row.street)}, again` : streetName(row.street)));
        if (row.board.length > 0) street.append(cardsEl(doc, row.board));
        const advice = make(doc, "div", "tp-review-line");
        advice.append(make(doc, "span", "tp-review-label", "Advice"), make(doc, "span", void 0, row.advised?.text ?? "None recorded"));
        const did = make(doc, "div", "tp-review-line");
        did.append(make(doc, "span", "tp-review-label", "You"), make(doc, "span", void 0, row.did?.text ?? "No action"));
        if (row.matched !== null) {
          const m = make(doc, "span", "tp-review-match", row.matched ? "Matched" : "Differed");
          m.style.color = row.matched ? THEME.good : THEME.warning;
          did.append(m);
        }
        li.append(street, advice, did);
        list.append(li);
      }
      card.append(list);
    }
    if (r.runout) {
      const line = make(doc, "div", "tp-review-line");
      line.style.marginTop = "4px";
      line.append(make(doc, "span", "tp-review-label", "Board"), cardsEl(doc, r.runout));
      card.append(line);
    }
    if (r.takeaway) card.append(make(doc, "p", "tp-review-take", r.takeaway));
    return card;
  }

  // src/ui/panel.ts
  var STATUS_TEXT = {
    "not-seated": "Not seated",
    waiting: "Waiting for your turn",
    "no-cards": "No hole cards seen this hand",
    thinking: "Thinking\u2026",
    unreadable: "Can\u2019t read the table \u2014 advice paused",
    tournament: "Tournament table \u2014 advice off"
  };
  var UI_KEY = "tp-advisor-ui";
  var FALLBACK_HEIGHT = 40;
  var DEFAULT_TOP = 120;
  var CARDS_HIDDEN = "tp-cards-hidden";
  function warn(what, e) {
    console.warn(`[torn-poker] ${what}`, e);
  }
  function loadUi() {
    const s = { left: null, top: null, minimised: false, showCards: true, hidden: false, stopLoss: null, winTarget: null };
    try {
      const p = JSON.parse(localStorage.getItem(UI_KEY) ?? "null");
      if (p && Number.isFinite(p.left) && Number.isFinite(p.top)) {
        s.left = p.left;
        s.top = p.top;
      }
      if (p && p.minimised === true) s.minimised = true;
      if (p && p.showCards === false) s.showCards = false;
      if (p && p.hidden === true) s.hidden = true;
      if (p && Number.isFinite(p.stopLoss) && p.stopLoss > 0) s.stopLoss = p.stopLoss;
      if (p && Number.isFinite(p.winTarget) && p.winTarget > 0) s.winTarget = p.winTarget;
    } catch {
    }
    return s;
  }
  function saveUi(s) {
    try {
      localStorage.setItem(UI_KEY, JSON.stringify(s));
    } catch {
    }
  }
  function netColor(n) {
    return n > 0 ? THEME.good : n < 0 ? THEME.bad : THEME.muted;
  }
  function actionColor(action) {
    switch (action) {
      case "raise":
      case "bet":
      case "allin":
        return THEME.good;
      case "call":
      case "check":
        return "#5aa0e0";
      default:
        return THEME.bad;
    }
  }
  function actionLine(a) {
    const dollars2 = a.amount === null ? "" : a.amount.toLocaleString("en-US");
    const amt = a.amount !== null && a.bigBlind > 0 ? `${Number((a.amount / a.bigBlind).toFixed(2))} BB ($${dollars2})` : dollars2;
    switch (a.action) {
      case "raise":
        return amt ? `RAISE to ${amt}` : "RAISE";
      case "bet":
        return amt ? `BET ${amt}` : "BET";
      case "allin":
        return amt ? `ALL-IN ${amt}` : "ALL-IN";
      case "call":
        return "CALL";
      case "check":
        return "CHECK";
      default:
        return "FOLD";
    }
  }
  var pct3 = (x) => `${Math.round(x * 100)}%`;
  var mounted = /* @__PURE__ */ new WeakMap();
  function mountPanel(doc, h) {
    mounted.get(doc)?.();
    const win = doc.defaultView;
    const ui = loadUi();
    const el2 = (tag2, cls, text) => {
      const e = doc.createElement(tag2);
      if (cls) e.className = cls;
      if (text !== void 0) e.textContent = text;
      return e;
    };
    const guard2 = (what, fn) => (...args) => {
      try {
        fn(...args);
      } catch (e) {
        warn(`${what} failed`, e);
      }
    };
    const kv = (label, value, color) => {
      const row2 = el2("div", "tp-kv");
      const v = el2("span", void 0, value);
      if (color) v.style.color = color;
      row2.append(el2("span", "tp-muted", label), v);
      return row2;
    };
    const style = el2("style");
    style.id = "tp-advisor-style";
    style.textContent = `${PANEL_CSS}${REVIEW_CSS}.${CARDS_HIDDEN} #tp-cards{display:none!important}
`;
    const root = el2("div");
    root.id = "tp-advisor";
    const title = el2("span", "tp-title");
    const grip = el2("span", "tp-grip", "\u283F ");
    grip.setAttribute("aria-hidden", "true");
    title.append(grip, "Poker Advisor");
    const headNet = el2("span", "tp-head-net");
    headNet.title = "Session net";
    const minBtn = el2("button", "tp-min", "\u2013");
    minBtn.type = "button";
    minBtn.setAttribute("aria-controls", "tp-advisor-content");
    const labelMin = () => {
      const label = ui.minimised ? "Expand" : "Minimise";
      minBtn.title = label;
      minBtn.setAttribute("aria-label", label);
      minBtn.setAttribute("aria-expanded", String(!ui.minimised));
    };
    const head = el2("div", "tp-head");
    head.append(title, headNet, minBtn);
    const tabsEl = el2("div", "tp-tabs");
    tabsEl.setAttribute("role", "tablist");
    tabsEl.setAttribute("aria-label", "Advisor sections");
    const bodies = {
      advice: el2("div", "tp-body"),
      results: el2("div", "tp-body"),
      settings: el2("div", "tp-body")
    };
    const tabBtns = {};
    const showTab = (t) => {
      Object.keys(bodies).forEach((k) => {
        bodies[k].style.display = k === t ? "" : "none";
        tabBtns[k].setAttribute("aria-selected", String(k === t));
        tabBtns[k].tabIndex = k === t ? 0 : -1;
      });
    };
    const TABS = [["advice", "Advice"], ["results", "Results"], ["settings", "Settings"]];
    for (const [t, label] of TABS) {
      bodies[t].id = `tp-panel-${t}`;
      bodies[t].setAttribute("role", "tabpanel");
      bodies[t].setAttribute("aria-labelledby", `tp-tab-${t}`);
      const b = el2("button", "tp-tab", label);
      b.type = "button";
      b.id = `tp-tab-${t}`;
      b.setAttribute("role", "tab");
      b.setAttribute("aria-controls", `tp-panel-${t}`);
      b.addEventListener("click", guard2("tab", () => showTab(t)));
      b.addEventListener("keydown", guard2("tab keys", (e) => {
        const at = TABS.findIndex(([k]) => k === t);
        const to = e.key === "ArrowRight" ? at + 1 : e.key === "ArrowLeft" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : null;
        if (to === null) return;
        e.preventDefault();
        const next = TABS[(to + TABS.length) % TABS.length][0];
        showTab(next);
        tabBtns[next].focus();
      }));
      tabBtns[t] = b;
      tabsEl.append(b);
    }
    const alertEl = el2("div", "tp-alert");
    alertEl.style.display = "none";
    alertEl.setAttribute("role", "status");
    alertEl.setAttribute("aria-live", "polite");
    const alertText = el2("span");
    const alertClose = el2("button", "tp-alert-close", "\xD7");
    alertClose.type = "button";
    alertClose.title = "Dismiss";
    alertClose.setAttribute("aria-label", "Dismiss");
    alertClose.addEventListener("click", guard2("dismiss alert", () => {
      alertEl.style.display = "none";
    }));
    alertEl.append(alertText, alertClose);
    const content = el2("div");
    content.id = "tp-advisor-content";
    content.append(tabsEl, bodies.advice, bodies.results, bodies.settings);
    root.append(head, alertEl, content);
    const applyMin = () => {
      content.style.display = ui.minimised ? "none" : "";
      labelMin();
      doc.body.classList.toggle(CARDS_HIDDEN, ui.minimised || !ui.showCards);
    };
    let docked = false;
    const clamp = () => {
      if (docked) return;
      const w = root.offsetWidth || PANEL_WIDTH;
      const ht = root.offsetHeight || FALLBACK_HEIGHT;
      const docEl = doc.documentElement;
      const vw = docEl.clientWidth > 0 ? docEl.clientWidth : win?.innerWidth ?? Infinity;
      const vh = docEl.clientHeight > 0 ? docEl.clientHeight : win?.innerHeight ?? Infinity;
      const maxLeft = Math.max(0, vw - w);
      const maxTop = Math.max(0, vh - ht);
      const left = ui.left ?? (Number.isFinite(vw) ? vw - w - 16 : null);
      const top = ui.top ?? DEFAULT_TOP;
      if (left === null) return;
      const l = Math.min(Math.max(0, left), maxLeft);
      const t = Math.min(Math.max(0, top), maxTop);
      if (ui.left !== null) {
        ui.left = l;
        ui.top = t;
      }
      root.style.left = `${l}px`;
      root.style.top = `${t}px`;
      root.style.right = "auto";
    };
    minBtn.addEventListener("click", guard2("minimise", () => {
      ui.minimised = !ui.minimised;
      applyMin();
      clamp();
      saveUi(ui);
    }));
    const onResize = guard2("resize", clamp);
    win?.addEventListener("resize", onResize);
    let endDrag = null;
    const onBlur = () => {
      try {
        endDrag?.();
      } catch (e) {
        warn("drag end failed", e);
      }
    };
    win?.addEventListener("blur", onBlur);
    head.addEventListener("mousedown", (down) => {
      try {
        if (docked || down.button !== 0 || down.target === minBtn) return;
        endDrag?.();
        const rect = root.getBoundingClientRect();
        const dx = down.clientX - rect.left;
        const dy = down.clientY - rect.top;
        down.preventDefault();
        down.stopPropagation();
        let moved = false;
        const stop = () => {
          doc.removeEventListener("mousemove", move, true);
          doc.removeEventListener("mouseup", up, true);
          endDrag = null;
          if (moved) saveUi(ui);
        };
        const move = (e) => {
          try {
            if (e.buttons === 0) {
              stop();
              return;
            }
            e.stopPropagation();
            moved = true;
            ui.left = e.clientX - dx;
            ui.top = e.clientY - dy;
            clamp();
          } catch (err) {
            warn("panel drag failed", err);
          }
        };
        const up = (e) => {
          try {
            e.stopPropagation();
            stop();
          } catch (err) {
            warn("panel drag end failed", err);
          }
        };
        endDrag = stop;
        doc.addEventListener("mousemove", move, true);
        doc.addEventListener("mouseup", up, true);
      } catch (err) {
        warn("panel drag start failed", err);
      }
    });
    const adviceBox = el2("div");
    const youLine = el2("button", "tp-you tp-muted");
    youLine.type = "button";
    youLine.title = "Show your stats";
    youLine.addEventListener("click", guard2("hero line", () => showTab("results")));
    const reminderEl = el2("div", "tp-reminder");
    reminderEl.style.display = "none";
    reminderEl.setAttribute("role", "status");
    reminderEl.setAttribute("aria-live", "polite");
    const reviewBox = el2("div");
    bodies.advice.append(adviceBox, reviewBox, reminderEl);
    function showReview(review) {
      try {
        reviewBox.replaceChildren(...review ? [buildReviewCard(doc, review, "Your last hand")] : []);
      } catch (e) {
        warn("showReview failed", e);
      }
    }
    function reminder(text) {
      try {
        reminderEl.textContent = text;
        reminderEl.style.display = text ? "" : "none";
      } catch (e) {
        warn("reminder failed", e);
      }
    }
    function renderYou(hero) {
      if (!hero || hero.hands <= 0) {
        youLine.remove();
        return;
      }
      const st = classify(hero);
      const r = rates(hero);
      const known = hero.hands >= MIN_HANDS_FOR_STYLE && r.vpip !== null;
      const badge = el2("span", void 0, known ? STYLES[st].short : STYLES.Unknown.short);
      badge.style.color = STYLE_TEXT[st];
      badge.style.fontWeight = "bold";
      const rest = known ? ` \xB7 play ${formatStat("vpip", r.vpip)}, raise ${formatStat("pfr", r.pfr)} \xB7 ${hero.hands} hands` : ` \xB7 ${hero.hands}/${MIN_HANDS_FOR_STYLE} hands`;
      youLine.replaceChildren("You: ", badge, rest);
      bodies.advice.append(youLine);
    }
    const render = (target, build2) => {
      const tmp = el2("div");
      build2(tmp);
      target.replaceChildren(...Array.from(tmp.childNodes));
    };
    function setStatus(s, detail) {
      try {
        render(adviceBox, (box) => {
          box.append(el2("div", void 0, STATUS_TEXT[s]));
          if (detail) box.append(el2("div", "tp-muted", detail));
        });
      } catch (e) {
        warn("setStatus failed", e);
      }
    }
    function showAdvice(a, opts) {
      try {
        render(adviceBox, (box) => {
          if (opts?.preview) {
            box.append(el2("div", "tp-preview-label", "If it comes to you \xB7 updates as players act"));
          } else {
            box.append(el2("div", "tp-turn-label", "Your turn"));
          }
          const big = el2("div", opts?.preview ? "tp-big tp-big-preview" : "tp-big", actionLine(a));
          big.style.color = actionColor(a.action);
          box.append(big);
          if (opts?.bet && !opts.preview) box.append(buildBetSlider(doc, a, opts.bet));
          box.append(buildMeters(doc, a));
          if (!a.strength) box.append(kv("Hand", a.hand));
          box.append(kv("Position", a.position));
          if (a.potOdds !== null) box.append(kv("Pot odds to call", pct3(a.potOdds)));
          if (a.facing) box.append(kv("Facing", `${a.facing.name} \xB7 ${a.facing.style}`));
          const reason = el2("div", "tp-muted", a.reason);
          reason.style.marginTop = "6px";
          box.append(reason);
          if (a.detail.length > 0) {
            const list = el2("ul");
            for (const d of a.detail) list.append(el2("li", void 0, d));
            list.style.display = "none";
            list.id = "tp-reasons";
            const more = el2("button", "tp-btn", "Show Reasons");
            more.type = "button";
            more.setAttribute("aria-expanded", "false");
            more.setAttribute("aria-controls", list.id);
            more.addEventListener("click", guard2("reasons toggle", () => {
              const open = list.style.display === "none";
              list.style.display = open ? "" : "none";
              more.textContent = open ? "Hide Reasons" : "Show Reasons";
              more.setAttribute("aria-expanded", String(open));
            }));
            box.append(more, list);
          }
          const chip = el2("div", "tp-chip", `${a.confidence} confidence`);
          chip.style.color = a.confidence === "high" ? THEME.good : a.confidence === "medium" ? THEME.warning : THEME.bad;
          box.append(chip);
        });
      } catch (e) {
        warn("showAdvice failed", e);
        setStatus("unreadable");
      }
    }
    function heroSection(hero) {
      const sec = el2("div", "tp-hero");
      sec.style.marginBottom = "8px";
      sec.append(el2("h4", "tp-heading", "Your play"));
      if (!hero || hero.hands <= 0) {
        sec.append(el2("div", "tp-muted", "No hands recorded yet."));
        return sec;
      }
      const style2 = classify(hero);
      const badge = el2("span", void 0, style2);
      badge.className = "tp-style-badge";
      badge.style.background = BADGE[style2];
      sec.append(badge, el2("div", "tp-muted", `${hero.hands} hands${hero.hands < LOW_SAMPLE ? " \xB7 low sample" : ""}`));
      if (style2 !== "Unknown") sec.append(el2("div", "tp-style-about", STYLES[style2].about));
      const r = rates(hero);
      const list = el2("div", "tp-stats");
      for (const key of ["vpip", "pfr", "threeBet", "af", "foldToRaise", "wtsd"]) {
        const info = STATS[key];
        const v = verdict(key, r[key]);
        const item = el2("div", "tp-stat-row");
        item.title = info.help;
        const top = el2("div", "tp-kv");
        const name = el2("span", void 0, info.label);
        name.append(el2("small", "tp-abbr", ` ${info.abbr}`));
        const value = el2("b", void 0, formatStat(key, r[key]));
        value.style.color = v === "good" ? THEME.good : v === "unknown" ? THEME.text : THEME.warning;
        top.append(name, value);
        const hint = v === "low" ? info.low : v === "high" ? info.high : void 0;
        const note = el2("div", "tp-stat-note", hint ? `${hint} Good: ${goodRange(key)}` : `Good: ${goodRange(key)}`);
        if (hint) note.style.color = THEME.warning;
        item.append(top, note, el2("div", "tp-stat-note", info.help));
        list.append(item);
      }
      sec.append(list);
      if (hero.hands < MIN_HANDS_FOR_STYLE) sec.append(el2("div", "tp-muted", `Style shows after ${MIN_HANDS_FOR_STYLE} hands`));
      return sec;
    }
    function netSpan(net, bb) {
      const color = netColor(net);
      if (typeof bb !== "number" || !Number.isFinite(bb)) {
        const d = el2("span", void 0, formatMoney(net));
        d.style.color = color;
        return d;
      }
      const wrap = el2("span");
      const main = el2("span", void 0, formatBB(bb));
      main.style.color = color;
      const dollars2 = el2("span", "tp-muted", `(${formatMoney(net)})`);
      dollars2.style.fontSize = "0.85em";
      wrap.append(main, " ", dollars2);
      return wrap;
    }
    const plural = (n, one, many) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
    const amount = (t) => t.bb === null ? formatMoney(t.net) : formatBB(t.bb);
    function leakSection(report, scope) {
      const sec = el2("div", "tp-leaks");
      const line = (spots, text, none, hands) => {
        const p = el2("div", "tp-leak-line");
        if (spots === 0) {
          p.textContent = none;
          p.classList.add("tp-muted");
        } else {
          p.append(`${text(spots.toLocaleString("en-US"))} Those hands: `);
          const v = el2("b", void 0, amount(hands));
          v.style.color = netColor(hands.net);
          p.append(v, ".");
        }
        return p;
      };
      sec.append(
        line(
          report.passedUp.spots,
          (n) => `You passed up ${n} ${report.passedUp.spots === 1 ? "bet or raise" : "bets or raises"} ${scope}.`,
          `You did not pass up any bets or raises ${scope}.`,
          report.passedUp.hands
        ),
        line(
          report.calledFold.spots,
          () => `You called ${plural(report.calledFold.spots, "time", "times")} when the advice was to fold ${scope}.`,
          `You did not call against fold advice ${scope}.`,
          report.calledFold.hands
        )
      );
      if (report.followed.hands > 0) {
        const p = el2("div", "tp-leak-line");
        p.append(`Hands where you followed the advice: `);
        const v = el2("b", void 0, amount(report.followed));
        v.style.color = netColor(report.followed.net);
        p.append(v, ".");
        sec.append(p);
      }
      sec.append(el2("div", "tp-hint", "This compares what happened on those hands. It is not the exact amount a choice cost you."));
      return sec;
    }
    const SVG = "http://www.w3.org/2000/svg";
    function profitChart(curve) {
      const pts = curve.points;
      if (pts.length < 3) return null;
      const W = 250, H = 64, PAD = 4;
      const lo = Math.min(0, ...pts), hi = Math.max(0, ...pts);
      const span = hi - lo || 1;
      const x = (i) => PAD + i / (pts.length - 1) * (W - 2 * PAD);
      const y = (v) => PAD + (1 - (v - lo) / span) * (H - 2 * PAD);
      const end = pts[pts.length - 1];
      const color = netColor(end);
      const svg = doc.createElementNS(SVG, "svg");
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.setAttribute("class", "tp-chart");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", `Net result after each hand this session, ending at ${curve.unit === "bb" ? formatBB(end) : formatMoney(end)}`);
      const zero2 = doc.createElementNS(SVG, "line");
      for (const [k, v] of Object.entries({ x1: PAD, x2: W - PAD, y1: y(0), y2: y(0), stroke: THEME.muted, "stroke-dasharray": "3 3", "stroke-width": 1 })) zero2.setAttribute(k, String(v));
      const line = doc.createElementNS(SVG, "polyline");
      line.setAttribute("points", pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" "));
      for (const [k, v] of Object.entries({ fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round" })) line.setAttribute(k, String(v));
      svg.append(zero2, line);
      const wrap = el2("div", "tp-chart-wrap");
      wrap.append(el2("h4", "tp-subhead tp-muted", "This session, hand by hand"), svg);
      return wrap;
    }
    function sparkline(p) {
      const W = 250, H = 44, PAD = 4;
      const vs = p.values;
      const lo = Math.min(...vs, ...p.good ?? []), hi = Math.max(...vs, ...p.good ?? []);
      const span = hi - lo || 1;
      const x = (i) => PAD + i / (vs.length - 1) * (W - 2 * PAD);
      const y = (v) => PAD + (1 - (v - lo) / span) * (H - 2 * PAD);
      const svg = doc.createElementNS(SVG, "svg");
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.setAttribute("class", "tp-chart");
      svg.setAttribute("role", "img");
      const range = p.good && p.key !== "followed" ? ` The target range is ${goodRange(p.key)}.` : "";
      svg.setAttribute("aria-label", `${p.label} over your last ${plural(vs.length, "session", "sessions")}, oldest first: ${vs.map((v) => formatProgress(p.key, v)).join(", ")}.${range}`);
      if (p.good) {
        const band = doc.createElementNS(SVG, "rect");
        for (const [k, v] of Object.entries({ x: 0, width: W, y: y(p.good[1]), height: Math.max(1, y(p.good[0]) - y(p.good[1])), fill: THEME.good, "fill-opacity": 0.18 })) band.setAttribute(k, String(v));
        svg.append(band);
      }
      const line = doc.createElementNS(SVG, "polyline");
      line.setAttribute("points", vs.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" "));
      for (const [k, v] of Object.entries({ fill: "none", stroke: THEME.draw, "stroke-width": 2, "stroke-linejoin": "round" })) line.setAttribute(k, String(v));
      const dot = doc.createElementNS(SVG, "circle");
      for (const [k, v] of Object.entries({ cx: x(vs.length - 1), cy: y(vs[vs.length - 1]), r: 3, fill: THEME.draw })) dot.setAttribute(k, String(v));
      svg.append(line, dot);
      return svg;
    }
    function progressSection(report) {
      const sec = el2("div", "tp-progress");
      sec.append(el2("h4", "tp-subhead tp-muted", "Your progress"));
      sec.append(el2("div", "tp-hint", `How you play, not how much you win. Only sessions of ${MIN_SESSION_HANDS} or more hands count, up to ${SPARK_SESSIONS} of the latest.`));
      for (const p of report.stats) {
        const item = el2("div", "tp-progress-item");
        const top = el2("div", "tp-kv");
        top.append(el2("span", void 0, p.label), el2("b", "tp-num", formatProgress(p.key, p.latest)));
        item.append(top);
        if (p.values.length >= 2) item.append(sparkline(p));
        item.append(el2("div", "tp-hint", p.trend));
        sec.append(item);
      }
      if (report.skipped > 0) sec.append(el2("div", "tp-hint", `${plural(report.skipped, "shorter session", "shorter sessions")} left out.`));
      return sec;
    }
    function pastSessions(past) {
      if (past.length === 0) return null;
      const sec = el2("div", "tp-past");
      sec.append(el2("h4", "tp-subhead tp-muted", "Earlier sessions"));
      for (const p of past) {
        const item = el2("div", "tp-past-item");
        const top = el2("div", "tp-kv");
        top.append(
          el2("span", void 0, `${new Date(p.start).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} \xB7 ${plural(p.hands, "hand", "hands")}`),
          netSpan(p.net, p.bb)
        );
        const bits = [];
        if (p.bbPer100 !== null) bits.push(`${formatBB(p.bbPer100)} per 100 hands`);
        if (p.perHour) bits.push(`${p.perHour.unit === "bb" ? formatBB(p.perHour.value) : formatMoney(Math.round(p.perHour.value))} per hour`);
        if (p.durationMs > 0) bits.push(`${Math.max(1, Math.round(p.durationMs / 6e4))} min`);
        if (p.biggestWinBb !== null) bits.push(`biggest win ${formatBB(p.biggestWinBb).replace(/^\+/, "")}`);
        else if (p.biggestWin > 0) bits.push(`biggest pot won ${p.biggestWin.toLocaleString("en-US")}`);
        item.append(top);
        if (bits.length > 0) item.append(el2("div", "tp-hint", bits.join(" \xB7 ")));
        sec.append(item);
      }
      return sec;
    }
    const limitsOf = () => ({ stopLoss: ui.stopLoss, winTarget: ui.winTarget });
    let alertState = { loss: false, win: false };
    function alertMessage(kind, bb) {
      const size = formatBB(Math.abs(bb)).replace(/^[+−]/, "");
      return kind === "stop-loss" ? `You are down ${size} this session, past the stop-loss you set. This could be a good moment to take a break.` : `You are up ${size} this session, past the win target you set. You may want to take that and step away.`;
    }
    function checkAlerts(s) {
      const r = checkLimits(alertState, s.session.bb, limitsOf());
      alertState = r.state;
      if (r.fired && s.session.bb !== null) {
        alertText.textContent = alertMessage(r.fired, s.session.bb);
        alertEl.style.display = "";
      }
    }
    const openHands = /* @__PURE__ */ new Set();
    function showResults(s, hero) {
      try {
        checkAlerts(s);
        renderYou(hero);
        if (s.session.hands > 0) {
          headNet.replaceChildren(typeof s.session.bb === "number" && Number.isFinite(s.session.bb) ? formatBB(s.session.bb) : formatMoney(s.session.net));
          headNet.style.color = netColor(s.session.net);
        } else {
          headNet.replaceChildren();
        }
        render(bodies.results, (box) => {
          const tally2 = (label, t) => {
            const row2 = el2("div", "tp-kv");
            const v = el2("span");
            v.append(`${t.hands.toLocaleString("en-US")} \xB7 `);
            v.append(netSpan(t.net, t.bb));
            row2.append(el2("span", "tp-muted", label), v);
            return row2;
          };
          const netRow = (label, t) => {
            const row2 = el2("div", "tp-kv");
            row2.append(el2("span", "tp-muted", label), netSpan(t.net, t.bb));
            return row2;
          };
          box.append(
            heroSection(hero),
            netRow("Session net", s.session),
            netRow("All-time net", s.allTime),
            kv("Hands", s.allTime.hands.toLocaleString("en-US")),
            tally2("Followed advice", s.followed),
            tally2("Ignored advice", s.ignored)
          );
          if (s.insights) {
            const lead = el2("h4", "tp-subhead tp-muted", "Where passive play shows up");
            lead.style.marginTop = "8px";
            box.append(lead, leakSection(s.insights.leaks.session, "this session"));
            if (s.insights.leaks.allTime.followed.hands + s.insights.leaks.allTime.passedUp.spots + s.insights.leaks.allTime.calledFold.spots > 0) {
              box.append(leakSection(s.insights.leaks.allTime, "overall"));
            }
            const chart = profitChart(s.insights.curve);
            if (chart) box.append(chart);
            const past = pastSessions(s.insights.past);
            if (past) box.append(past);
          }
          if (s.progress && s.progress.sessions.length > 0) box.append(progressSection(s.progress));
          const heading = el2("h4", "tp-subhead tp-muted", "Last 20 hands");
          heading.style.marginTop = "6px";
          box.append(heading, el2("div", "tp-legend", "\u2713 followed the advice \xB7 \u2717 went against it \xB7 \u2013 no advice recorded. Click a hand to review it."));
          for (const hand of s.recent.slice(0, 20)) {
            const mark = hand.followed === true ? "\u2713" : hand.followed === false ? "\u2717" : "\u2013";
            const item = el2("div", "tp-hand-item");
            const row2 = el2("button", "tp-hand-row");
            row2.type = "button";
            const open = openHands.has(hand.handId);
            row2.setAttribute("aria-expanded", String(open));
            const chevron = el2("span", "tp-hand-chevron", open ? "\u25BE" : "\u25B8");
            chevron.setAttribute("aria-hidden", "true");
            const main = el2("span", "tp-hand-main");
            main.append(chevron, cardsEl(doc, hand.cards));
            const side = el2("span", "tp-hand-side");
            const markEl = el2("span", "tp-muted", mark);
            const meaning = hand.followed === true ? "Followed the advice" : hand.followed === false ? "Went against the advice" : "No advice recorded";
            markEl.setAttribute("role", "img");
            markEl.setAttribute("aria-label", meaning);
            markEl.title = meaning;
            side.append(netSpan(hand.net, hand.bigBlind ? hand.net / hand.bigBlind : null), markEl);
            row2.append(main, side);
            item.append(row2);
            let review = null;
            const sync2 = () => {
              const isOpen = openHands.has(hand.handId);
              row2.setAttribute("aria-expanded", String(isOpen));
              chevron.textContent = isOpen ? "\u25BE" : "\u25B8";
              if (isOpen && !review) {
                review = buildReviewCard(doc, buildReview(hand));
                item.append(review);
              }
              if (review) review.style.display = isOpen ? "" : "none";
            };
            row2.addEventListener("click", guard2("hand review", () => {
              if (!openHands.delete(hand.handId)) openHands.add(hand.handId);
              sync2();
            }));
            if (open) sync2();
            box.append(item);
          }
        });
      } catch (e) {
        warn("showResults failed", e);
      }
    }
    const recBox = el2("input");
    recBox.type = "checkbox";
    recBox.addEventListener("change", guard2("toggle recording", () => h.onToggleRecording(recBox.checked)));
    const recCount = el2("span", "tp-muted", "0 frames");
    const recLabel = el2("label");
    recLabel.append(recBox, " Record raw messages ", recCount);
    const cardsBox = el2("input");
    cardsBox.type = "checkbox";
    cardsBox.checked = ui.showCards;
    cardsBox.addEventListener("change", guard2("toggle profile cards", () => {
      ui.showCards = cardsBox.checked;
      applyMin();
      saveUi(ui);
    }));
    const cardsLabel = el2("label");
    cardsLabel.append(cardsBox, " Show profile cards");
    const limitInput = (key, label, name) => {
      const input = el2("input");
      input.type = "number";
      input.min = "1";
      input.step = "1";
      input.placeholder = "e.g. 50";
      input.name = key;
      input.autocomplete = "off";
      input.inputMode = "numeric";
      input.style.cssText = "width:72px";
      input.value = ui[key] === null ? "" : String(ui[key]);
      const error = el2("div", "tp-field-error");
      error.setAttribute("role", "alert");
      error.style.display = "none";
      input.addEventListener("change", guard2(`set ${key}`, () => {
        const n = Number(input.value);
        const typed = input.value.trim() !== "";
        const valid = typed && Number.isFinite(n) && n > 0;
        ui[key] = valid ? n : null;
        input.value = ui[key] === null ? "" : String(ui[key]);
        input.setAttribute("aria-invalid", String(typed && !valid));
        error.textContent = typed && !valid ? `${name} is off. Enter a number above 0, or leave the box empty.` : "";
        error.style.display = typed && !valid ? "" : "none";
        saveUi(ui);
      }));
      const l = el2("label");
      l.append(`${label} `, input, " big blinds");
      const wrap = el2("div");
      wrap.append(l, error);
      return wrap;
    };
    const btn = (text, fn) => {
      const b = el2("button", "tp-btn", text);
      b.type = "button";
      b.addEventListener("click", guard2(text, fn));
      return b;
    };
    const file = el2("input");
    file.type = "file";
    file.accept = "application/json";
    file.style.display = "none";
    file.addEventListener("change", () => {
      const f = file.files?.[0];
      if (!f) return;
      f.text().then((t) => h.onImportData(t)).catch((e) => {
        warn("import failed", e);
        notice("Couldn\u2019t read that file. Pick a .json file exported from this script.");
      }).finally(() => {
        try {
          file.value = "";
        } catch {
        }
      });
    });
    const section = (heading, ...kids) => {
      const d = el2("div", "tp-section");
      d.append(el2("h3", "tp-section-title", heading), ...kids.filter((k) => k !== null));
      return d;
    };
    const row = (...kids) => {
      const d = el2("div");
      d.append(...kids);
      return d;
    };
    const noticeEl = el2("div", "tp-muted tp-notice");
    noticeEl.style.display = "none";
    noticeEl.setAttribute("role", "status");
    noticeEl.setAttribute("aria-live", "polite");
    const posRow = row(btn("Reset Position", () => {
      ui.left = ui.top = null;
      root.style.left = root.style.top = root.style.right = "";
      clamp();
      saveUi(ui);
    }));
    const posSection = section("Position", el2("div", "tp-hint", "Drag the title bar to move the panel. Reset Position puts it back at the right edge."), posRow);
    const resetBtn = btn("Reset All Profiles", () => {
      if (confirm("Reset all opponent profiles?")) h.onResetProfiles();
    });
    resetBtn.classList.add("tp-danger");
    bodies.settings.append(
      section(
        "Display",
        cardsLabel,
        el2("div", "tp-hint", "Optional session notes. A gentle message appears once when your session result passes a number, counted in big blinds. Leave empty to turn off."),
        limitInput("stopLoss", "Stop-loss, down by", "Stop-loss"),
        limitInput("winTarget", "Win target, up by", "Win target")
      ),
      posSection,
      section(
        "Your data",
        el2("div", "tp-hint", "Back up or move your player profiles and results."),
        row(btn("Export Data", () => h.onExportData()), btn("Import Data", () => file.click()), file),
        noticeEl,
        row(resetBtn)
      ),
      section("Debugging", recLabel, row(btn("Export Capture", () => h.onExportCapture())))
    );
    function setRecording(on, frames) {
      try {
        recBox.checked = on;
        recCount.textContent = `${frames.toLocaleString("en-US")} frames`;
      } catch (e) {
        warn("setRecording failed", e);
      }
    }
    function notice(text) {
      try {
        noticeEl.textContent = text;
        noticeEl.style.display = text ? "" : "none";
      } catch (e) {
        warn("notice failed", e);
      }
    }
    const applyHidden = () => {
      root.style.display = ui.hidden && docked ? "none" : "";
      posSection.style.display = docked ? "none" : "";
    };
    function dockInto(anchor) {
      try {
        if (anchor) {
          if (!root.isConnected || root.previousElementSibling !== anchor) anchor.after(root);
          if (!docked) {
            docked = true;
            root.classList.add("tp-docked");
            root.style.left = root.style.top = root.style.right = "";
            applyHidden();
          }
        } else if (docked || !root.isConnected) {
          docked = false;
          root.classList.remove("tp-docked");
          doc.body.appendChild(root);
          applyHidden();
          clamp();
        }
      } catch (e) {
        warn("dock failed", e);
      }
    }
    function toggleVisible() {
      ui.hidden = !ui.hidden;
      applyHidden();
      saveUi(ui);
      if (!ui.hidden) clamp();
      return !ui.hidden;
    }
    mounted.set(doc, () => {
      endDrag?.();
      win?.removeEventListener("resize", onResize);
      win?.removeEventListener("blur", onBlur);
      root.remove();
      style.remove();
      doc.body.classList.remove(CARDS_HIDDEN);
    });
    setStatus("not-seated");
    showTab("advice");
    applyMin();
    applyHidden();
    doc.head.appendChild(style);
    doc.body.appendChild(root);
    clamp();
    return { setStatus, showAdvice, showResults, showReview, setRecording, notice, reminder, dockInto, toggleVisible, isVisible: () => !ui.hidden };
  }

  // src/profiles/labels.ts
  var LABELS2 = {
    fish: { name: "Fish", colour: "#1e9e6a", help: "Weak player who loses money. Target them." },
    rock: { name: "Rock", colour: "#6c7a89", help: "Plays only strong hands." },
    maniac: { name: "Maniac", colour: "#e0592a", help: "Bets and raises wildly." },
    reg: { name: "Reg", colour: "#3b82c4", help: "Regular who plays well. Be careful." }
  };
  var LABEL_KEYS = Object.keys(LABELS2);
  var isLabel = (v) => typeof v === "string" && Object.hasOwn(LABELS2, v);

  // src/core/evaluator.ts
  var CATEGORIES = [
    "High card",
    "Pair",
    "Two pair",
    "Trips",
    "Straight",
    "Flush",
    "Full house",
    "Quads",
    "Straight flush"
  ];
  function categoryOf(value) {
    return CATEGORIES[value >>> 20];
  }
  var counts = new Int8Array(13);
  var suitMasks = new Int32Array(4);
  function popcount(m) {
    let n = 0;
    while (m) {
      m &= m - 1;
      n++;
    }
    return n;
  }
  function straightHigh(mask) {
    const m = mask << 1 | mask >> 12;
    for (let h = 13; h >= 4; h--) {
      if ((m >> h - 4 & 31) === 31) return h - 1;
    }
    return -1;
  }
  function topRanks(mask, n) {
    let out = 0;
    for (let r = 12; r >= 0 && n > 0; r--) {
      if (mask & 1 << r) {
        out = out << 4 | r;
        n--;
      }
    }
    return out;
  }
  function evaluate(cards) {
    counts.fill(0);
    suitMasks.fill(0);
    let rankMask2 = 0;
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      const r = c >> 2;
      counts[r]++;
      suitMasks[c & 3] |= 1 << r;
      rankMask2 |= 1 << r;
    }
    for (let s = 0; s < 4; s++) {
      const sm = suitMasks[s];
      if (popcount(sm) >= 5) {
        const sh2 = straightHigh(sm);
        if (sh2 >= 0) return 8 << 20 | sh2;
        return 5 << 20 | topRanks(sm, 5);
      }
    }
    let quad = -1;
    let trips = -1;
    let pairA = -1;
    let pairB = -1;
    for (let r = 12; r >= 0; r--) {
      const n = counts[r];
      if (n === 4) quad = r;
      else if (n === 3) {
        if (trips < 0) trips = r;
        else if (pairA < 0) pairA = r;
      } else if (n === 2) {
        if (pairA < 0) pairA = r;
        else if (pairB < 0) pairB = r;
      }
    }
    if (quad >= 0) {
      return 7 << 20 | quad << 4 | topRanks(rankMask2 & ~(1 << quad), 1);
    }
    if (trips >= 0 && pairA >= 0) return 6 << 20 | trips << 4 | pairA;
    const sh = straightHigh(rankMask2);
    if (sh >= 0) return 4 << 20 | sh;
    if (trips >= 0) {
      return 3 << 20 | trips << 8 | topRanks(rankMask2 & ~(1 << trips), 2);
    }
    if (pairB >= 0) {
      const used = 1 << pairA | 1 << pairB;
      return 2 << 20 | pairA << 8 | pairB << 4 | topRanks(rankMask2 & ~used, 1);
    }
    if (pairA >= 0) {
      return 1 << 20 | pairA << 16 | topRanks(rankMask2 & ~(1 << pairA), 3);
    }
    return topRanks(rankMask2, 5);
  }

  // src/core/preflop-order.ts
  var PREFLOP_ORDER = [
    "AA",
    "KK",
    "QQ",
    "JJ",
    "TT",
    "99",
    "88",
    "AKs",
    "AQs",
    "77",
    "AJs",
    "AKo",
    "AQo",
    "AJo",
    "ATs",
    "KQs",
    "66",
    "ATo",
    "KJs",
    "A9s",
    "A8s",
    "KTs",
    "KQo",
    "A7s",
    "A9o",
    "KJo",
    "55",
    "QJs",
    "K9s",
    "A8o",
    "KTo",
    "A6s",
    "QTs",
    "A5s",
    "QJo",
    "A7o",
    "A4s",
    "K8s",
    "A6o",
    "A5o",
    "A3s",
    "JTs",
    "Q9s",
    "K9o",
    "A2s",
    "K7s",
    "44",
    "A4o",
    "QTo",
    "K6s",
    "A3o",
    "Q8s",
    "K8o",
    "K5s",
    "K4s",
    "Q9o",
    "J9s",
    "K7o",
    "A2o",
    "JTo",
    "K3s",
    "T9s",
    "Q7s",
    "K6o",
    "J8s",
    "Q8o",
    "Q6s",
    "J9o",
    "33",
    "K2s",
    "K5o",
    "T8s",
    "Q5s",
    "J7s",
    "Q4s",
    "K4o",
    "J8o",
    "Q7o",
    "K3o",
    "T9o",
    "Q3s",
    "Q6o",
    "K2o",
    "J6s",
    "T7s",
    "98s",
    "J5s",
    "T8o",
    "Q5o",
    "22",
    "Q2s",
    "Q4o",
    "J4s",
    "J7o",
    "J3s",
    "97s",
    "T6s",
    "Q3o",
    "J6o",
    "T7o",
    "87s",
    "J2s",
    "96s",
    "98o",
    "J5o",
    "Q2o",
    "T4s",
    "86s",
    "97o",
    "T5s",
    "J4o",
    "T6o",
    "87o",
    "76s",
    "95s",
    "J3o",
    "T2s",
    "T3s",
    "85s",
    "96o",
    "T5o",
    "94s",
    "J2o",
    "75s",
    "93s",
    "T4o",
    "65s",
    "86o",
    "95o",
    "84s",
    "T3o",
    "76o",
    "92s",
    "T2o",
    "74s",
    "85o",
    "54s",
    "64s",
    "83s",
    "94o",
    "82s",
    "93o",
    "65o",
    "73s",
    "75o",
    "53s",
    "84o",
    "63s",
    "92o",
    "43s",
    "72s",
    "64o",
    "54o",
    "74o",
    "52s",
    "62s",
    "83o",
    "82o",
    "63o",
    "42s",
    "53o",
    "73o",
    "32s",
    "43o",
    "72o",
    "62o",
    "52o",
    "42o",
    "32o"
  ];

  // src/core/ranges.ts
  var COMBOS = 1326;
  var RANK_CHARS = "23456789TJQKA";
  function comboIndex(a, b) {
    const hi = Math.max(a, b);
    const lo = Math.min(a, b);
    return hi * (hi - 1) / 2 + lo;
  }
  var PAIRS = [];
  for (let hi = 1; hi < 52; hi++) {
    for (let lo = 0; lo < hi; lo++) PAIRS.push([lo, hi]);
  }
  function comboCards(i) {
    const p = PAIRS[i];
    return [p[0], p[1]];
  }
  function handClass(a, b) {
    const ra = rankOf(a);
    const rb = rankOf(b);
    const hi = Math.max(ra, rb);
    const lo = Math.min(ra, rb);
    if (ra === rb) return RANK_CHARS[hi] + RANK_CHARS[lo];
    return RANK_CHARS[hi] + RANK_CHARS[lo] + (suitOf(a) === suitOf(b) ? "s" : "o");
  }
  var COMBO_CLASS = PAIRS.map(([a, b]) => handClass(a, b));
  var CLASS_COMBOS = /* @__PURE__ */ new Map();
  COMBO_CLASS.forEach((cls, i) => {
    const list = CLASS_COMBOS.get(cls);
    if (list) list.push(i);
    else CLASS_COMBOS.set(cls, [i]);
  });
  function topPercent(pct5) {
    const r = new Float32Array(COMBOS);
    const target = pct5 / 100 * COMBOS;
    let total2 = 0;
    for (const c of PREFLOP_ORDER) {
      const combos = CLASS_COMBOS.get(c);
      if (total2 + combos.length >= target) {
        if (Math.abs(total2 + combos.length - target) >= Math.abs(total2 - target)) break;
      }
      for (const i of combos) r[i] = 1;
      total2 += combos.length;
      if (total2 >= target) break;
    }
    return r;
  }
  function rangePercent(r) {
    let sum2 = 0;
    for (let i = 0; i < COMBOS; i++) sum2 += r[i];
    return sum2 / COMBOS * 100;
  }
  function removeDead(r, dead) {
    const out = Float32Array.from(r);
    const deadSet = new Set(dead);
    for (let i = 0; i < COMBOS; i++) {
      const [a, b] = PAIRS[i];
      if (deadSet.has(a) || deadSet.has(b)) out[i] = 0;
    }
    return out;
  }

  // src/core/strength.ts
  var classCombos = (cls) => cls.length === 2 ? 6 : cls.endsWith("s") ? 4 : 12;
  function handStrength(hole, board) {
    if (board.length < 3) return preflopStrength(hole);
    const dead = /* @__PURE__ */ new Set([...hole, ...board]);
    const mine = evaluate([...hole, ...board]);
    let beat = 0;
    let total2 = 0;
    for (let i = 0; i < COMBOS; i++) {
      const [a, b] = comboCards(i);
      if (dead.has(a) || dead.has(b)) continue;
      const theirs = evaluate([a, b, ...board]);
      total2++;
      if (mine > theirs) beat += 1;
      else if (mine === theirs) beat += 0.5;
    }
    const value = total2 > 0 ? beat / total2 : 0;
    return { value, note: `Beats ${Math.round(value * 100)}% of hands` };
  }
  function preflopStrength(hole) {
    const cls = handClass(hole[0], hole[1]);
    let before = 0;
    for (const c of PREFLOP_ORDER) {
      if (c === cls) break;
      before += classCombos(c);
    }
    const mine = classCombos(cls);
    const value = 1 - (before + mine / 2) / COMBOS;
    if (value >= 0.5) {
      const top = Math.max(1, Math.round((before + mine) / COMBOS * 100));
      return { value, note: `Top ${top}% of starting hands` };
    }
    const bottom = Math.max(1, Math.round((1 - before / COMBOS) * 100));
    return { value, note: `Bottom ${bottom}% of starting hands` };
  }

  // src/profiles/bet-sizes.ts
  var BUCKETS = ["small", "medium", "large"];
  var SIZE_EDGES = { small: 0.4, large: 0.85 };
  var GRADE_EDGES = { strong: 0.85, weak: 0.6 };
  var MIN_SHOWDOWNS = 4;
  var AGREE = { strong: 0.7, weak: 0.6 };
  var bucketOf = (fraction) => fraction < SIZE_EDGES.small ? "small" : fraction <= SIZE_EDGES.large ? "medium" : "large";
  function betFraction(a, levelBefore) {
    const aggressive = a.action === "bet" || a.action === "raise" || a.action === "allin" && a.handBetAfter > levelBefore;
    const pot = a.potBefore + a.toCallBefore;
    if (!aggressive || !(pot > 0)) return null;
    return Math.max(0, a.handBetAfter - levelBefore) / pot;
  }
  function gradeHand(hole, board) {
    const v = handStrength(hole, board).value;
    return v >= GRADE_EDGES.strong ? "strong" : v < GRADE_EDGES.weak ? "weak" : "medium";
  }
  function betBuckets(hand, userID) {
    let level = hand.bigBlind;
    const biggest = /* @__PURE__ */ new Map();
    for (const a of hand.actions) {
      if (a.userID === userID && a.street !== "preflop") {
        const f = betFraction(a, level);
        if (f !== null && f > (biggest.get(a.street) ?? -1)) biggest.set(a.street, f);
      }
      if (a.handBetAfter > level) level = a.handBetAfter;
    }
    return [...biggest.values()].map(bucketOf);
  }
  var empty = () => ({
    small: { seen: 0, strong: 0, weak: 0 },
    medium: { seen: 0, strong: 0, weak: 0 },
    large: { seen: 0, strong: 0, weak: 0 }
  });
  function addBetSizes(prev, hand, userID) {
    const shown = hand.shown.find((x) => x.userID === userID);
    if (!shown || shown.cards.length !== 2 || hand.board.length < 3) return prev;
    const buckets = betBuckets(hand, userID);
    if (buckets.length === 0) return prev;
    const grade = gradeHand([shown.cards[0], shown.cards[1]], hand.board);
    const out = prev ? { small: { ...prev.small }, medium: { ...prev.medium }, large: { ...prev.large } } : empty();
    for (const b of buckets) {
      out[b].seen += 1;
      if (grade === "strong") out[b].strong += 1;
      else if (grade === "weak") out[b].weak += 1;
    }
    return out;
  }
  var isCount = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0;
  function isBetSizes(v) {
    if (v === null || typeof v !== "object") return false;
    const o = v;
    return BUCKETS.every((b) => {
      const r = o[b];
      return r !== null && typeof r === "object" && isCount(r.seen) && isCount(r.strong) && isCount(r.weak) && r.strong + r.weak <= r.seen;
    });
  }
  var BUCKET_WORD = { small: "Small", medium: "Medium", large: "Big" };
  function readBetSize(sizes, bucket) {
    const r = sizes?.[bucket];
    if (!r || r.seen < MIN_SHOWDOWNS) return null;
    const head = `${BUCKET_WORD[bucket]} bets`;
    let kind = "mixed";
    let text = `${head}: no clear pattern (${r.strong} of ${r.seen} strong)`;
    if (r.strong / r.seen >= AGREE.strong) {
      kind = "strong";
      text = `${head}: strong ${r.strong} of ${r.seen} times`;
    } else if (r.weak / r.seen >= AGREE.weak) {
      kind = "bluffy";
      text = `${head}: often bluffs (${r.weak} of ${r.seen} weak)`;
    }
    return { bucket, seen: r.seen, strong: r.strong, weak: r.weak, kind, text };
  }

  // src/ui/range-grid.ts
  var RANKS = "AKQJT98765432";
  var SHADE = "240,192,96";
  function cellHand(row, col) {
    if (row === col) return RANKS[row] + RANKS[col];
    return row < col ? `${RANKS[row]}${RANKS[col]}s` : `${RANKS[col]}${RANKS[row]}o`;
  }
  function classWeights(range) {
    const sum2 = /* @__PURE__ */ new Map();
    const count = /* @__PURE__ */ new Map();
    for (let i = 0; i < COMBOS; i++) {
      const [a, b] = comboCards(i);
      const c = handClass(a, b);
      sum2.set(c, (sum2.get(c) ?? 0) + range[i]);
      count.set(c, (count.get(c) ?? 0) + 1);
    }
    return new Map([...sum2].map(([c, s]) => [c, s / count.get(c)]));
  }
  function generalRange(s) {
    return topPercent(blendedRates(s ?? freshStats(0, "")).vpip);
  }
  var RANGE_GRID_RULES = [
    ".tp-rg{margin:8px 0 4px}",
    ".tp-rg-cap{color:#aaa;font-size:11px;margin:0 0 3px}",
    ".tp-rg-grid{display:grid;grid-template-columns:repeat(14,15px);grid-auto-rows:15px;gap:1px;font-variant-numeric:tabular-nums}",
    ".tp-rg-ax{display:flex;align-items:center;justify-content:center;color:#aaa;font-size:11px;line-height:15px}",
    ".tp-rg-cell{background:#262626;border-radius:2px;box-sizing:border-box}",
    `.tp-rg-cell.tp-rg-on{outline:1px solid rgba(${SHADE},.35);outline-offset:-1px}`,
    ".tp-rg-sum{color:#ddd;font-size:11px;margin:3px 0 0}"
  ];
  function rangeGrid(doc, range, live) {
    const weights = classWeights(range);
    const pct5 = rangePercent(range);
    const summary = pct5 > 0 && pct5 < 1 ? "Less than 1% of hands" : `About ${Math.round(pct5)}% of hands`;
    const caption = live ? "Hands they likely have now" : "Hands they likely play";
    const wrap = doc.createElement("div");
    wrap.className = "tp-rg";
    const cap = doc.createElement("div");
    cap.className = "tp-rg-cap";
    cap.textContent = caption;
    const grid = doc.createElement("div");
    grid.className = "tp-rg-grid";
    grid.setAttribute("role", "img");
    grid.setAttribute("aria-label", `${caption}. ${summary}. Pairs on the diagonal, suited hands above it, offsuit hands below.`);
    const axis = (text) => {
      const e = doc.createElement("div");
      e.className = "tp-rg-ax";
      e.textContent = text;
      return e;
    };
    grid.append(axis(""), ...[...RANKS].map(axis));
    for (let row = 0; row < 13; row++) {
      grid.append(axis(RANKS[row]));
      for (let col = 0; col < 13; col++) {
        const hand = cellHand(row, col);
        const w = weights.get(hand) ?? 0;
        const cell = doc.createElement("div");
        cell.className = w > 0 ? "tp-rg-cell tp-rg-on" : "tp-rg-cell";
        cell.dataset.hand = hand;
        cell.dataset.weight = w.toFixed(2);
        if (w > 0) cell.style.background = `rgba(${SHADE},${(0.25 + 0.75 * w).toFixed(2)})`;
        grid.append(cell);
      }
    }
    const sum2 = doc.createElement("div");
    sum2.className = "tp-rg-sum";
    sum2.textContent = `${summary}. Pairs run down the middle, suited hands sit above and offsuit hands below.`;
    wrap.append(cap, grid, sum2);
    return wrap;
  }

  // src/ui/profile-cards.ts
  var CARD_WIDTH = 250;
  var TAG_HEIGHT = 18;
  var CARDS_ID = "tp-cards";
  var STYLE_ID = "tp-cards-style";
  var CARDS_CSS = `
#${CARDS_ID}{color-scheme:dark}
#${CARDS_ID} .tp-card{position:absolute;z-index:2147482999;height:${TAG_HEIGHT}px}
#${CARDS_ID} .tp-card:hover,#${CARDS_ID} .tp-card.tp-open{z-index:2147483000}
#${CARDS_ID} .tp-card *{box-sizing:border-box}
#${CARDS_ID} .tp-tag{appearance:none;display:flex;align-items:center;gap:5px;width:100%;height:${TAG_HEIGHT}px;margin:0;border:0;padding:0 5px;color:#fff;font:11px/${TAG_HEIGHT}px sans-serif;text-align:left;white-space:nowrap;overflow:hidden;cursor:pointer;border-radius:4px 4px 0 0}
#${CARDS_ID} .tp-card.tp-open .tp-tag{box-shadow:inset 0 0 0 2px #fff}
#${CARDS_ID} .tp-card.tp-open .tp-pop{border-color:#fff}
#${CARDS_ID} .tp-card.tp-below .tp-tag{border-radius:0 0 4px 4px}
#${CARDS_ID} .tp-tag.tp-low{outline:1px dashed rgba(255,255,255,.7);outline-offset:-3px}
#${CARDS_ID} .tp-tag-style{font-weight:700;letter-spacing:.3px}
#${CARDS_ID} .tp-tag-rates{font-variant-numeric:tabular-nums}
#${CARDS_ID} .tp-tag-hands{margin-left:auto;font-size:11px;overflow:hidden;text-overflow:ellipsis}
#${CARDS_ID} .tp-tag-sep{opacity:.5}
#${CARDS_ID} .tp-tag-label{flex:none;padding:0 5px;border-radius:3px;font-size:11px;font-weight:700;line-height:14px;background:rgba(0,0,0,.35);border-left:4px solid var(--tp-label,#fff)}
#${CARDS_ID} .tp-labels{display:flex;flex-wrap:wrap;gap:4px;margin:8px 0 4px}
#${CARDS_ID} .tp-label-btn{min-height:${MIN_TARGET}px;padding:3px 8px;border-radius:3px;border:1px solid #555;background:#262626;color:#ddd;font:12px sans-serif;cursor:pointer}
#${CARDS_ID} .tp-label-btn:hover{background:#333;border-color:#888}
#${CARDS_ID} .tp-label-btn[aria-pressed="true"]{background:#3a3a3a;color:#fff;border:2px solid var(--tp-label,#fff);padding:2px 7px}
#${CARDS_ID} .tp-note{display:block;width:100%;min-height:42px;resize:vertical;margin:4px 0 0;padding:5px 6px;background:#1c1c1c;color:#eee;border:1px solid #444;border-radius:4px;font:12px/1.4 sans-serif}
#${CARDS_ID} .tp-note-help{color:${THEME.subtle};font-size:11px;margin:2px 0 6px}
#${CARDS_ID} .tp-note-help.tp-bad{color:#ff8a8a}
#${CARDS_ID} .tp-sec{color:#aaa;font-size:11px;margin:8px 0 3px}
#${CARDS_ID} .tp-bs{color:#ddd;font-size:12px;font-variant-numeric:tabular-nums;padding:1px 0}
#${CARDS_ID} .tp-sd{padding:4px 0;border-top:1px solid #333}
#${CARDS_ID} .tp-sd-cards{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-variant-numeric:tabular-nums}
#${CARDS_ID} .tp-c{font-weight:700;color:#eee}
#${CARDS_ID} .tp-c.tp-red{color:#ff6b6b}
#${CARDS_ID} .tp-sd-board{color:#aaa;display:flex;gap:3px;font-size:11px}
#${CARDS_ID} .tp-sd-name{color:#f0c060;font-size:11px}
#${CARDS_ID} .tp-sd-line{color:#aaa;font-size:11px}
#${CARDS_ID} .tp-pop{display:none;position:absolute;left:0;width:${CARD_WIDTH}px;z-index:2147483001;background:${THEME.bg};color:#ddd;border:1px solid #444;border-radius:6px;padding:8px;font:12px/1.4 sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.6);white-space:normal}
#${CARDS_ID} .tp-card.tp-flip .tp-pop{left:auto;right:0}
#${CARDS_ID} .tp-card.tp-above .tp-pop{top:100%}
#${CARDS_ID} .tp-card.tp-below .tp-pop{bottom:100%}
#${CARDS_ID} .tp-pop{max-height:min(70vh,var(--tp-pop-room,70vh));overflow-y:auto;overscroll-behavior:contain}
#${CARDS_ID} .tp-card:hover .tp-pop,#${CARDS_ID} .tp-card.tp-open .tp-pop{display:block}
#${CARDS_ID} .tp-pop-close{display:none;float:right;min-width:${MIN_TARGET}px;min-height:${MIN_TARGET}px;margin:-4px -4px 0 4px;border:0;border-radius:4px;background:none;color:#ddd;font:16px/1 sans-serif;cursor:pointer}
#${CARDS_ID} .tp-pop-close:hover{background:rgba(255,255,255,.12)}
#${CARDS_ID} .tp-card.tp-open .tp-pop-close{display:block}
#${CARDS_ID} .tp-card-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:4px 6px;margin-bottom:4px}
#${CARDS_ID} .tp-card-name{font-weight:700;font-size:13px;overflow-wrap:anywhere}
#${CARDS_ID} .tp-badge{flex:none;padding:1px 6px;border-radius:3px;color:#fff;font-size:11px;font-weight:700;text-transform:uppercase}
#${CARDS_ID} .tp-card-about{color:#aaa;font-size:11px;margin:-2px 0 6px}
#${CARDS_ID} .tp-card-stats{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin:0 0 8px}
#${CARDS_ID} .tp-stat{display:flex;align-items:baseline;justify-content:space-between;gap:6px;background:#262626;border-radius:4px;padding:5px 8px}
#${CARDS_ID} .tp-stat b{font-size:14px;color:#fff;font-variant-numeric:tabular-nums;white-space:nowrap}
#${CARDS_ID} .tp-stat span{font-size:11px;color:#aaa;white-space:nowrap}
#${CARDS_ID} .tp-card-tip{color:#f0c060;padding:5px 6px;background:rgba(240,192,96,.08);border-left:2px solid #f0c060;border-radius:2px}
#${CARDS_ID} .tp-card-foot{display:flex;justify-content:space-between;align-items:center;gap:4px;color:${THEME.subtle};font-size:12px;margin-top:3px}
#${CARDS_ID} .tp-card-reset{min-height:${MIN_TARGET}px;padding:2px 6px;border:0;border-radius:4px;background:none;color:${THEME.link};cursor:pointer;font:inherit}
#${CARDS_ID} .tp-card-reset:hover{background:rgba(90,160,224,.15);text-decoration:underline}
#${CARDS_ID} .tp-stat.tp-stat-wrap{flex-wrap:wrap}
#${CARDS_ID} .tp-stat.tp-stat-wrap span{white-space:normal}
#${CARDS_ID} .tp-stat .tp-stat-n{flex-basis:100%;white-space:normal;font-variant-numeric:tabular-nums}
${RANGE_GRID_RULES.map((r) => `#${CARDS_ID} ${r}`).join("\n")}
${SHARED_CSS}${FOCUS_CSS}`;
  var states = /* @__PURE__ */ new WeakMap();
  var signatures = /* @__PURE__ */ new WeakMap();
  var rangeIds = /* @__PURE__ */ new WeakMap();
  var nextRangeId = 1;
  function rangeId(r) {
    let id = rangeIds.get(r);
    if (id === void 0) rangeIds.set(r, id = nextRangeId++);
    return id;
  }
  function closeCards(doc, refocus) {
    for (const card of Array.from(doc.querySelectorAll(`#${CARDS_ID} .tp-card.tp-open`))) {
      const tag2 = card.querySelector(".tp-tag");
      if (refocus && card.contains(doc.activeElement)) tag2?.focus();
      card.classList.remove("tp-open");
      tag2?.setAttribute("aria-expanded", "false");
    }
  }
  function warn2(what, e) {
    console.warn(`[torn-poker] ${what}`, e);
  }
  function container(doc) {
    let box = doc.getElementById(CARDS_ID);
    if (!box) {
      box = doc.createElement("div");
      box.id = CARDS_ID;
      doc.body.appendChild(box);
    }
    if (!doc.getElementById(STYLE_ID)) {
      const s = doc.createElement("style");
      s.id = STYLE_ID;
      s.textContent = CARDS_CSS;
      doc.head.appendChild(s);
    }
    return box;
  }
  function buildContent(doc, wrap, p, st) {
    const el2 = (tag3, cls, text) => {
      const e = doc.createElement(tag3);
      if (cls) e.className = cls;
      if (text !== void 0) e.textContent = text;
      return e;
    };
    const s = p.stats;
    const r = s && s.hands > 0 ? blendedRates(s) : null;
    const style = s ? readStyle(s) : "Unknown";
    const hands = s?.hands ?? 0;
    const early = !s || isEarlyRead(s);
    const badge = el2("span", "tp-badge", style);
    badge.style.background = BADGE[style];
    const head = el2("div", "tp-card-head");
    head.append(el2("span", "tp-card-name", p.name), badge);
    const about = el2("div", "tp-card-about", STYLES[style].about);
    const helps = [];
    const stat = (label2, value, help) => {
      const c = el2("div", "tp-stat");
      c.title = help;
      helps.push([label2, help.slice(help.indexOf(":") + 2)]);
      c.append(el2("span", void 0, label2), " ", el2("b", void 0, value));
      return c;
    };
    const stats = el2("div", "tp-card-stats");
    const box = (key, label2) => stat(label2, formatStat(key, r?.[key] ?? null), `${STATS[key].abbr}: ${STATS[key].help.replace(/\byou(r)?\b/g, (_m, s2) => s2 ? "their" : "they")}`);
    stats.append(box("vpip", "Plays"), box("pfr", "Raises"), box("af", "Aggression"), box("foldToRaise", "Folds to raise"));
    const street = (key, c) => {
      const seen = c !== void 0 && c.d > 0;
      const help = `${STATS[key].abbr}: ${STATS[key].help.replace(/\byou(r)?\b/g, (_m, s2) => s2 ? "their" : "they")}`;
      const cell = stat(STATS[key].label, seen ? formatStat(key, r?.[key] ?? null) : "\u2013", help);
      cell.classList.add("tp-stat-wrap");
      const n = Math.round(c?.d ?? 0);
      cell.append(el2("span", "tp-stat-n", n === 0 ? "No chances seen yet" : `From ${n} ${n === 1 ? "chance" : "chances"}`));
      return cell;
    };
    stats.append(street("cbet", s?.cbet), street("foldToCbet", s?.foldToCbet));
    const tip = el2("div", "tp-card-tip", r ? tipFor(style, r) : "No hands seen yet.");
    const reset = el2("button", "tp-card-reset");
    reset.type = "button";
    const resetIcon = el2("span", void 0, "\u21BB");
    resetIcon.setAttribute("aria-hidden", "true");
    reset.append(resetIcon, " Reset Profile");
    reset.addEventListener("click", () => {
      try {
        if (confirm(`Reset profile for ${p.name}?`)) st.h.onReset(p.userID);
      } catch (e) {
        warn2("reset failed", e);
      }
    });
    const foot = el2("div", "tp-card-foot");
    foot.append(el2("span", void 0, `${hands} ${hands === 1 ? "hand" : "hands"}${early ? " \xB7 early read" : ""}`), reset);
    const pop = el2("div", "tp-pop");
    pop.id = `tp-pop-${p.userID}`;
    pop.setAttribute("role", "group");
    pop.setAttribute("aria-label", `${p.name} profile`);
    const close = el2("button", "tp-pop-close", "\xD7");
    close.type = "button";
    close.title = "Close profile";
    close.setAttribute("aria-label", "Close profile");
    close.addEventListener("click", () => closeCards(doc, true));
    pop.append(
      close,
      head,
      about,
      stats,
      helpList(doc, "What these numbers mean", helps),
      rangeGrid(doc, p.liveRange ?? generalRange(s), p.liveRange !== void 0),
      tip,
      labelPicker(doc, p),
      noteBox(doc, p)
    );
    pop.append(betSizeList(doc, s?.betSizes));
    const shows = showdownList(doc, s?.showdowns ?? []);
    if (shows) pop.append(shows);
    pop.append(foot);
    const tag2 = el2("button", "tp-tag");
    tag2.type = "button";
    tag2.setAttribute("aria-controls", pop.id);
    tag2.setAttribute("aria-expanded", String(wrap.classList.contains("tp-open")));
    const sep = () => el2("span", "tp-tag-sep", " \xB7 ");
    const handsText = `${hands} ${hands === 1 ? "hand" : "hands"}`;
    const label = s?.label;
    if (label) {
      const chip = el2("span", "tp-tag-label", LABELS2[label].name);
      chip.style.setProperty("--tp-label", LABELS2[label].colour);
      tag2.append(chip);
    }
    const note = s?.note ? ` Note: ${s.note}` : "";
    if (r) {
      const plays = `plays ${Math.round(r.vpip)}%`;
      tag2.append(el2("span", "tp-tag-style", STYLES[style].short), sep(), el2("span", "tp-tag-rates", plays));
      if (early) tag2.append(sep(), el2("span", "tp-tag-hands", "early read"));
      tag2.title = `${p.name}: ${STYLES[style].about} Plays ${Math.round(r.vpip)}% of hands, raises ${formatStat("pfr", r.pfr)} before the flop, over ${handsText}.${early ? " Early read: more hands will sharpen it." : ""}${note} Click for profile.`;
      tag2.setAttribute("aria-label", tag2.title.replace(" Click for profile.", " Opens the profile."));
    } else {
      tag2.append(el2("span", "tp-tag-style", "New player"));
      tag2.title = `${p.name}: no hands seen yet.${note} Click for profile.`;
      tag2.setAttribute("aria-label", tag2.title.replace(" Click for profile.", " Opens the profile."));
    }
    tag2.classList.toggle("tp-low", early);
    tag2.style.background = BADGE[style];
    tag2.addEventListener("click", () => {
      try {
        const open = !wrap.classList.contains("tp-open");
        closeCards(doc, false);
        if (open) wrap.classList.add("tp-open");
        tag2.setAttribute("aria-expanded", String(open));
      } catch (e) {
        warn2("toggle failed", e);
      }
    });
    return [tag2, pop];
  }
  var cardEl = (doc, c) => {
    const e = doc.createElement("span");
    const red = suitOf(c) === 1 || suitOf(c) === 2;
    e.className = red ? "tp-c tp-red" : "tp-c";
    e.textContent = formatCard(c);
    return e;
  };
  function labelPicker(doc, p) {
    const row = doc.createElement("div");
    row.className = "tp-labels";
    const current = p.stats?.label ?? null;
    const btn = (key) => {
      const b = doc.createElement("button");
      b.type = "button";
      b.className = "tp-label-btn";
      b.textContent = key ? LABELS2[key].name : "None";
      if (key) b.title = LABELS2[key].help;
      b.setAttribute("aria-pressed", String(key === current));
      if (key === current && key) b.style.setProperty("--tp-label", LABELS2[key].colour);
      b.addEventListener("click", () => {
        try {
          p.onLabel(key);
        } catch (e) {
          warn2("label failed", e);
        }
      });
      return b;
    };
    row.append(btn(null), ...LABEL_KEYS.map(btn));
    return row;
  }
  function noteBox(doc, p) {
    const box = doc.createElement("div");
    const area = doc.createElement("textarea");
    area.className = "tp-note";
    area.rows = 2;
    area.maxLength = 500;
    area.placeholder = "Your note about this player\u2026";
    area.name = "note";
    area.setAttribute("aria-label", "Your note about this player");
    area.value = p.stats?.note ?? "";
    let saved = area.value;
    const help = doc.createElement("div");
    help.className = "tp-note-help";
    help.textContent = "Press Enter to save.";
    help.setAttribute("aria-live", "polite");
    const save = () => {
      const text = area.value.trim();
      if (text === saved) return;
      try {
        p.onNote(text);
        saved = text;
        help.classList.remove("tp-bad");
        help.textContent = "Saved.";
      } catch (e) {
        warn2("note failed", e);
        help.classList.add("tp-bad");
        help.textContent = "Couldn\u2019t save the note. Press Enter to try again.";
      }
    };
    area.addEventListener("blur", save);
    area.addEventListener("input", () => {
      help.classList.remove("tp-bad");
      help.textContent = "Press Enter to save.";
    });
    area.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        area.blur();
      }
    });
    box.append(area, help);
    return box;
  }
  function betSizeList(doc, sizes) {
    const wrap = doc.createElement("div");
    const title = doc.createElement("div");
    title.className = "tp-sec";
    title.textContent = "Bet sizes";
    wrap.append(title);
    const lines = BUCKETS.map((b) => readBetSize(sizes, b)?.text).filter((t) => t !== void 0);
    for (const text of lines.length ? lines : ["Not enough showdowns yet"]) {
      const row = doc.createElement("div");
      row.className = "tp-bs";
      row.textContent = text;
      wrap.append(row);
    }
    return wrap;
  }
  function showdownList(doc, list) {
    if (list.length === 0) return null;
    const wrap = doc.createElement("div");
    const title = doc.createElement("div");
    title.className = "tp-sec";
    title.textContent = `Hands they showed (last ${list.length})`;
    wrap.append(title);
    for (const sd of list) {
      const row = doc.createElement("div");
      row.className = "tp-sd";
      const cards = doc.createElement("div");
      cards.className = "tp-sd-cards";
      const hole = doc.createElement("span");
      hole.append(cardEl(doc, sd.cards[0]), " ", cardEl(doc, sd.cards[1]));
      cards.append(hole);
      if (sd.board.length) {
        const board = doc.createElement("span");
        board.className = "tp-sd-board";
        board.title = "Board";
        board.append(...sd.board.map((c) => cardEl(doc, c)));
        cards.append(board);
      }
      if (sd.handName) {
        const name = doc.createElement("span");
        name.className = "tp-sd-name";
        name.textContent = sd.handName;
        cards.append(name);
      }
      const line = doc.createElement("div");
      line.className = "tp-sd-line";
      line.textContent = sd.line;
      row.append(cards, line);
      wrap.append(row);
    }
    return wrap;
  }
  function place(doc, wrap, rect, center) {
    const win = doc.defaultView;
    const sx = win?.scrollX ?? 0;
    const sy = win?.scrollY ?? 0;
    const vw = win?.innerWidth ?? Infinity;
    const vh = win?.innerHeight ?? Infinity;
    const above = rect.top + rect.height / 2 < center.y;
    const rawTop = (above ? rect.top - TAG_HEIGHT : rect.bottom) + sy;
    const maxLeft = sx + Math.max(0, vw - rect.width);
    const maxTop = sy + Math.max(0, vh - TAG_HEIGHT);
    wrap.classList.toggle("tp-above", above);
    wrap.classList.toggle("tp-below", !above);
    wrap.classList.toggle("tp-flip", rect.left + CARD_WIDTH > vw);
    const top = Math.min(Math.max(rawTop, sy), maxTop);
    wrap.style.width = `${rect.width}px`;
    wrap.style.left = `${Math.min(Math.max(rect.left + sx, sx), maxLeft)}px`;
    wrap.style.top = `${top}px`;
    const tagTop = top - sy;
    const room = above ? vh - (tagTop + TAG_HEIGHT) - POP_MARGIN : tagTop - POP_MARGIN;
    if (Number.isFinite(room)) wrap.style.setProperty("--tp-pop-room", `${Math.max(MIN_POP_ROOM, Math.floor(room))}px`);
  }
  var POP_MARGIN = 8;
  var MIN_POP_ROOM = 160;
  var BOX_SELECTOR = '[class*="additionalBox"], [class*="detailsBox"]';
  function anchorRect(seat) {
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const e of Array.from(seat.querySelectorAll(BOX_SELECTOR))) {
      const q = e.getBoundingClientRect();
      if (q.width === 0 && q.height === 0) continue;
      l = Math.min(l, q.left);
      t = Math.min(t, q.top);
      r = Math.max(r, q.right);
      b = Math.max(b, q.bottom);
    }
    if (l === Infinity) return seat.getBoundingClientRect();
    return { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t, x: l, y: t, toJSON() {
    } };
  }
  function sync(doc, st) {
    const box = container(doc);
    const keep = /* @__PURE__ */ new Set();
    const seen = [];
    for (const p of st.players) {
      const wrap = doc.getElementById(`tp-card-${p.userID}`);
      const seat = doc.getElementById(`player-${p.userID}`);
      const rect = seat ? anchorRect(seat) : void 0;
      if (!seat || !rect || rect.width === 0 && rect.height === 0) {
        wrap?.remove();
        continue;
      }
      seen.push({ p, rect, wrap });
    }
    const center = {
      x: (Math.min(...seen.map((e) => e.rect.left)) + Math.max(...seen.map((e) => e.rect.right))) / 2,
      y: (Math.min(...seen.map((e) => e.rect.top)) + Math.max(...seen.map((e) => e.rect.bottom))) / 2
    };
    for (const { p, rect, wrap: existing } of seen) {
      const id = `tp-card-${p.userID}`;
      keep.add(id);
      let wrap = existing;
      if (!wrap) {
        wrap = doc.createElement("div");
        wrap.id = id;
        wrap.className = "tp-card";
        box.appendChild(wrap);
      }
      const sig = JSON.stringify([p.name, p.stats, p.liveRange ? rangeId(p.liveRange) : 0]);
      const typing = wrap.contains(doc.activeElement);
      if (signatures.get(wrap) !== sig && !typing) {
        signatures.set(wrap, sig);
        wrap.replaceChildren(...buildContent(doc, wrap, p, st));
      }
      place(doc, wrap, rect, center);
    }
    for (const c of Array.from(box.children)) if (!keep.has(c.id)) c.remove();
  }
  function install(doc, st) {
    const win = doc.defaultView;
    if (!win) return;
    const run = () => {
      st.raf = false;
      try {
        sync(doc, st);
      } catch (e) {
        warn2("card reposition failed", e);
      }
    };
    const schedule = () => {
      if (st.raf) return;
      st.raf = true;
      win.requestAnimationFrame(run);
    };
    win.addEventListener("resize", schedule);
    win.addEventListener("scroll", schedule, true);
    doc.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeCards(doc, true);
    }, true);
    doc.addEventListener("click", (e) => {
      const target = e.target;
      if (!target?.closest?.(`#${CARDS_ID} .tp-card.tp-open`)) closeCards(doc, false);
    });
  }
  function renderProfileCards(doc, players, h) {
    try {
      let st = states.get(doc);
      if (!st) {
        st = { players, h, raf: false };
        states.set(doc, st);
        install(doc, st);
      }
      st.players = players;
      st.h = h;
      sync(doc, st);
    } catch (e) {
      warn2("renderProfileCards failed", e);
    }
  }

  // src/ui/bet-box.ts
  var BOX = '[class*="betInputWrap"] input.input-money:not([type="hidden"])';
  var CURRENCY_KEY = "HOLDEM_USER_CURRENCY";
  function tornShowsBigBlinds(doc) {
    try {
      return doc.defaultView?.localStorage.getItem(CURRENCY_KEY) === "BB";
    } catch {
      return false;
    }
  }
  function boxValue(amount, bigBlind, inBigBlinds) {
    if (inBigBlinds && bigBlind > 0) return String(Number((amount / bigBlind).toFixed(2)));
    return String(Math.round(amount));
  }
  function setTornBet(doc, amount, bigBlind) {
    const input = doc.querySelector(BOX);
    if (!input) return false;
    const win = doc.defaultView;
    const proto = win?.HTMLInputElement?.prototype ?? HTMLInputElement.prototype;
    const setValue = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    const value = boxValue(amount, bigBlind, tornShowsBigBlinds(doc));
    if (setValue) setValue.call(input, value);
    else input.value = value;
    for (const type of ["input", "keyup", "change"]) input.dispatchEvent(new Event(type, { bubbles: true }));
    return true;
  }

  // src/ui/bet-keys.ts
  var BET_KEYS = [
    { key: "a", label: "advised", amount: (_r, a) => a.amount },
    { key: "1", label: "min", amount: (r) => r.min },
    { key: "2", label: "\xBD pot", amount: (r) => potSized(r, 0.5) },
    { key: "3", label: "\u2154 pot", amount: (r) => potSized(r, 2 / 3) },
    { key: "4", label: "pot", amount: (r) => potSized(r, 1) },
    { key: "m", label: "max", amount: (r) => r.max }
  ];
  function betKeyAmount(key, r, a) {
    const k = BET_KEYS.find((x) => x.key === key.toLowerCase());
    const raw = k?.amount(r, a) ?? null;
    if (raw === null || !Number.isFinite(raw)) return null;
    return Math.min(r.max, Math.max(r.min, Math.round(raw)));
  }
  var NON_TEXT_INPUTS = /* @__PURE__ */ new Set(["range", "checkbox", "radio", "button", "submit", "reset", "image", "color", "file"]);
  function isTypingTarget(target) {
    const el2 = target;
    if (!el2 || typeof el2.closest !== "function") return false;
    const tag2 = el2.tagName;
    if (tag2 === "TEXTAREA" || tag2 === "SELECT") return true;
    if (tag2 === "INPUT") return !NON_TEXT_INPUTS.has(el2.type);
    return !!el2.closest('[contenteditable]:not([contenteditable="false"])');
  }
  var STORAGE_KEY = "tp-bet-keys";
  function loadKeysEnabled(win) {
    try {
      return win?.localStorage.getItem(STORAGE_KEY) !== "off";
    } catch {
      return true;
    }
  }
  function saveKeysEnabled(win, on) {
    try {
      win?.localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
    } catch {
    }
  }
  function buildKeyLegend(doc, enabled, onToggle) {
    const wrap = doc.createElement("div");
    wrap.className = "tp-keys";
    const list = doc.createElement("span");
    list.className = "tp-keys-list";
    list.append("Keys: ");
    BET_KEYS.forEach((k, i) => {
      const kbd = doc.createElement("kbd");
      kbd.textContent = k.key.toUpperCase();
      list.append(kbd, ` ${k.label}${i < BET_KEYS.length - 1 ? " \xB7 " : ""}`);
    });
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "tp-keys-toggle";
    let on = enabled;
    const paint = () => {
      btn.setAttribute("aria-pressed", String(on));
      btn.textContent = on ? "Shortcuts on" : "Shortcuts off";
      list.hidden = !on;
    };
    btn.addEventListener("click", () => {
      on = !on;
      paint();
      onToggle(on);
    });
    paint();
    wrap.append(list, btn);
    return wrap;
  }

  // src/ui/torn-hud.ts
  var SEL = {
    positioner: '[class*="panelPositioner___"]',
    topRow: '[class*="panelTopRow___"]',
    toggles: '[class*="toggle-button-"]',
    toggleButton: '[class*="toggleButton___"]',
    betOptions: '[class*="betOptions___"]',
    buttonsWrap: '[class*="buttonsWrap___"]'
  };
  var ROW_ID = "tp-hud-row";
  var TOGGLE_ID = "tp-hud-toggle";
  var STYLE_ID2 = "tp-hud-style";
  var ADVISED2 = "tp-advised";
  var PRESET = "data-tp-preset";
  var HUD_CSS = `
#${ROW_ID}{margin:0;padding:6px 10px;background:rgba(0,0,0,.35);border-top:1px solid rgba(255,255,255,.08);border-bottom:1px solid rgba(0,0,0,.4);font:13px/1.4 Arial,sans-serif;color:#eee;text-align:left;box-sizing:border-box}
#${ROW_ID} b{font:15px 'Fjalla One',sans-serif;letter-spacing:.4px;text-transform:uppercase}
#${ROW_ID} *{box-sizing:border-box}
#${ROW_ID}.tp-preview{border-top-style:dashed;border-top-color:rgba(255,255,255,.3)}
#${ROW_ID} .tp-hud-label{font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:#aaa;margin-right:6px}
#${ROW_ID} .tp-hud-meta{color:#aaa;font-size:12px;margin-left:6px}
/* Slider styled like Torn's own controls: one row, recessed track, grey fader knob, inset readout */
/* Torn's own bet box shows the amount, so only the label and track show here */
#${ROW_ID} .tp-bet{display:grid;grid-template-columns:auto 1fr;grid-template-areas:"title track";align-items:center;column-gap:10px;margin:6px 0 2px;padding:0;border:0;background:none}
#${ROW_ID} .tp-bet-value,#${ROW_ID} .tp-bet-sub{display:none}
#${ROW_ID} .tp-bet-head{display:contents}
#${ROW_ID} .tp-bet-title{grid-area:title;font:14px 'Fjalla One',sans-serif;letter-spacing:.4px;text-transform:uppercase;color:#bbb}
#${ROW_ID} .tp-bet-track{grid-area:track;margin:0;height:22px;display:flex;align-items:center}
#${ROW_ID} .tp-bet-note{display:none}
#${ROW_ID} .tp-bet-note.tp-bet-error{display:block;grid-column:1/-1;font-size:12px}
#${ROW_ID} .tp-bet-tick{top:2px;height:18px;width:2px;background:#f0a030;opacity:.9;z-index:1}
#${ROW_ID} .tp-bet-range{-webkit-appearance:none;appearance:none;width:100%;height:8px;margin:0;padding:0;border-radius:4px;border:1px solid #111;box-shadow:inset 0 1px 3px rgba(0,0,0,.9),0 1px 0 rgba(255,255,255,.08);background:linear-gradient(to right,#6aa84f 0,#6aa84f var(--tp-fill,0%),#1a1a1a var(--tp-fill,0%),#1a1a1a 100%);cursor:pointer}
#${ROW_ID} .tp-bet-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:22px;border-radius:3px;border:1px solid #111;background:linear-gradient(#8a8a8a,#555 55%,#3d3d3d);box-shadow:0 1px 3px rgba(0,0,0,.7),inset 0 1px 0 rgba(255,255,255,.25);position:relative;z-index:2}
#${ROW_ID} .tp-bet-range::-moz-range-thumb{width:14px;height:22px;border-radius:3px;border:1px solid #111;background:linear-gradient(#8a8a8a,#555 55%,#3d3d3d);box-shadow:0 1px 3px rgba(0,0,0,.7),inset 0 1px 0 rgba(255,255,255,.25)}
#${ROW_ID} .tp-bet-range:hover::-webkit-slider-thumb{background:linear-gradient(#9a9a9a,#666 55%,#4a4a4a)}
#${ROW_ID} .tp-keys{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;margin:4px 0 2px;font-size:12px;color:${THEME.subtle}}
#${ROW_ID} .tp-keys kbd{display:inline-block;min-width:18px;padding:0 4px;border:1px solid #666;border-radius:3px;background:#2c2c2c;color:${THEME.text};font:600 11px/16px Arial,sans-serif;text-align:center}
#${ROW_ID} .tp-keys-toggle{min-height:${MIN_TARGET}px;padding:0 8px;border:1px solid #4a4a4a;border-radius:5px;background:#2c2c2c;color:${THEME.text};font:12px Arial,sans-serif;cursor:pointer}
#${ROW_ID} .tp-keys-toggle[aria-pressed="false"]{color:${THEME.subtle}}
${SEL.buttonsWrap} button.${ADVISED2}{box-shadow:inset 0 0 0 2px var(--tp-adv),0 0 10px var(--tp-adv)!important}
#${TOGGLE_ID} button{display:flex;align-items:center;justify-content:center}
#${TOGGLE_ID} button svg{width:16px;height:16px;fill:#9a9a9a}
#${TOGGLE_ID} button[aria-pressed="true"] svg{fill:#5fd35f}
#${TOGGLE_ID} button[aria-pressed="false"] svg path{fill:none;stroke:#9a9a9a;stroke-width:1.5}
${SHARED_CSS}${FOCUS_CSS}`;
  function matchesAction(text, action) {
    const t = text.trim().toLowerCase();
    switch (action) {
      case "fold":
        return /^fold\b/.test(t);
      case "check":
        return /^check\b/.test(t);
      case "call":
        return /^call\b/.test(t) && !/\bany\b/.test(t);
      case "bet":
        return /^bet\b/.test(t);
      case "raise":
        return /^raise\b/.test(t);
      case "allin":
        return /all.?in/.test(t);
    }
  }
  function advisedButtons(buttons, action) {
    const hits = buttons.filter((b) => matchesAction(b.textContent ?? "", action));
    const plain = hits.filter((b) => !(b.textContent ?? "").includes("/"));
    return plain.length > 0 ? plain : hits;
  }
  var warn3 = (what, e) => console.warn(`[torn-poker] ${what}`, e);
  function mountTornHud(doc, panel) {
    const win = doc.defaultView;
    let shown = null;
    let keysOn = loadKeysEnabled(win);
    const style = doc.createElement("style");
    style.id = STYLE_ID2;
    style.textContent = HUD_CSS;
    doc.head.appendChild(style);
    const row = doc.createElement("div");
    row.id = ROW_ID;
    row.style.display = "none";
    const q = (sel, root = doc) => root.querySelector(sel);
    function renderRow() {
      row.replaceChildren();
      row.classList.toggle("tp-preview", !!shown?.preview);
      if (!shown) {
        row.style.display = "none";
        return;
      }
      row.style.display = "";
      const { a, preview, bet } = shown;
      const line = doc.createElement("div");
      const label = doc.createElement("span");
      label.className = "tp-hud-label";
      label.textContent = preview ? "If it comes to you" : "Advised";
      if (preview) label.title = "Updates as players act";
      const act = doc.createElement("b");
      act.textContent = actionLine(a);
      act.style.color = actionColor(a.action);
      line.append(label, act);
      row.append(line, buildMeters(doc, a));
      if (bet && !preview) {
        row.append(buildBetSlider(doc, a, bet, { chips: false }));
        row.append(buildKeyLegend(doc, keysOn, (on) => {
          keysOn = on;
          saveKeysEnabled(win, on);
        }));
      }
    }
    function makeToggle() {
      const wrap = doc.createElement("div");
      wrap.id = TOGGLE_ID;
      const btn = doc.createElement("button");
      btn.type = "button";
      const like = q(`${SEL.topRow} ${SEL.toggleButton}`);
      if (like) btn.className = like.className;
      btn.setAttribute("aria-label", "Poker Advisor");
      btn.title = "Show or hide the Poker Advisor";
      btn.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0 15 8 8 16 1 8Z"/></svg>';
      btn.setAttribute("aria-pressed", String(panel.isVisible?.() ?? true));
      btn.addEventListener("click", () => {
        try {
          const visible = panel.toggleVisible?.() ?? true;
          btn.setAttribute("aria-pressed", String(visible));
        } catch (e) {
          warn3("advisor toggle failed", e);
        }
      });
      wrap.append(btn);
      return wrap;
    }
    const presetAmount = (key, s) => {
      const b = s.bet;
      if (!b) return null;
      const amount = key === "advised" ? s.a.amount : Math.round(potSized(b, 2 / 3));
      if (amount === null) return null;
      return Math.min(b.max, Math.max(b.min, amount));
    };
    function fill(cur, amount) {
      const event = cur.bet?.onChange(amount) ? new CustomEvent(SET_AMOUNT, { detail: amount }) : new CustomEvent(FILL_FAILED);
      row.querySelector(".tp-bet")?.dispatchEvent(event);
    }
    function onKey(e) {
      try {
        if (!keysOn || e.ctrlKey || e.metaKey || e.altKey) return;
        const cur = shown && !shown.preview && shown.bet ? shown : null;
        if (!cur?.bet || isTypingTarget(e.target)) return;
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          if (e.target?.classList?.contains("tp-bet-range")) return;
          e.preventDefault();
          row.querySelector(".tp-bet")?.dispatchEvent(new CustomEvent(NUDGE, { detail: e.key === "ArrowUp" ? 1 : -1 }));
          return;
        }
        const amount = betKeyAmount(e.key, cur.bet, cur.a);
        if (amount === null) return;
        e.preventDefault();
        fill(cur, amount);
      } catch (err) {
        warn3("bet shortcut failed", err);
      }
    }
    doc.addEventListener("keydown", onKey, true);
    function syncPresets() {
      const opts = q(SEL.betOptions);
      if (!opts) return;
      const live = shown && !shown.preview && shown.bet ? shown : null;
      for (const [key, label, what] of [["twothirds", "\u2154", "Bet \u2154 of the pot"], ["advised", "Advised", "Bet the advised amount"]]) {
        let b = opts.querySelector(`[${PRESET}="${key}"]`);
        const amount = live ? presetAmount(key, live) : null;
        if (amount === null) {
          b?.remove();
          continue;
        }
        if (!b) {
          b = doc.createElement("button");
          b.type = "button";
          b.setAttribute(PRESET, key);
          const like = opts.querySelector("button:not([data-tp-preset])");
          if (like) b.className = like.className;
          b.textContent = label;
          b.title = what;
          b.setAttribute("aria-label", what);
          if (key === "advised") b.style.color = THEME.warning;
          b.addEventListener("click", () => {
            try {
              const cur = shown && !shown.preview ? shown : null;
              const amt = cur ? presetAmount(key, cur) : null;
              if (cur?.bet && amt !== null) fill(cur, amt);
            } catch (e) {
              warn3("preset failed", e);
            }
          });
          opts.append(b);
        }
      }
    }
    function syncOutline(wrap) {
      const buttons = Array.from(wrap.querySelectorAll("button"));
      const advised = shown ? advisedButtons(buttons, shown.a.action) : [];
      for (const b of buttons) {
        const want = advised.includes(b);
        if (b.classList.contains(ADVISED2) !== want) b.classList.toggle(ADVISED2, want);
        const color = want && shown ? actionColor(shown.a.action) : "";
        if (b.style.getPropertyValue("--tp-adv") !== color) {
          if (color) b.style.setProperty("--tp-adv", color);
          else b.style.removeProperty("--tp-adv");
        }
      }
    }
    function sync2() {
      try {
        panel.dockInto?.(q(SEL.buttonsWrap));
        const top = q(SEL.topRow);
        if (top && !top.querySelector(`#${TOGGLE_ID}`)) {
          const toggles = top.querySelectorAll(SEL.toggles);
          const last = toggles[toggles.length - 1];
          const t = doc.getElementById(TOGGLE_ID) ?? makeToggle();
          if (last) last.after(t);
          else top.prepend(t);
        }
        const wrap = q(SEL.buttonsWrap);
        if (wrap) {
          if (row.nextElementSibling !== wrap) wrap.before(row);
          syncOutline(wrap);
        } else if (row.isConnected) {
          row.remove();
        }
        syncPresets();
      } catch (e) {
        warn3("hud sync failed", e);
      }
    }
    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      const run = () => {
        queued = false;
        sync2();
      };
      if (win?.requestAnimationFrame) win.requestAnimationFrame(run);
      else setTimeout(run, 16);
    };
    const Observer = win?.MutationObserver;
    if (Observer) {
      new Observer(schedule).observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    }
    sync2();
    return {
      available: () => !!q(SEL.buttonsWrap),
      showAdvice(a, opts) {
        shown = { a, preview: !!opts?.preview, bet: opts?.bet ?? null };
        renderRow();
        sync2();
      },
      clear() {
        if (!shown) return;
        shown = null;
        renderRow();
        sync2();
      },
      sync: sync2
    };
  }
  function withTornHud(panel, hud) {
    return {
      ...panel,
      setStatus(s, detail) {
        panel.setStatus(s, detail);
        hud.clear();
      },
      showAdvice(a, opts) {
        const inHud = hud.available();
        panel.showAdvice(a, inHud ? { preview: opts?.preview } : opts);
        hud.showAdvice(a, opts);
      }
    };
  }

  // src/table/state.ts
  var STREETS3 = { 1: "preflop", 2: "flop", 3: "turn", 4: "river", 5: "river" };
  var ACTION_STATUS = {
    fold: "Fold",
    check: "Check",
    call: "Call",
    bet: "Bet",
    raise: "Raise",
    allin: "All in"
  };
  var NOT_DEALT = /* @__PURE__ */ new Set(["Waiting BB", "Sitting out"]);
  var FOLDED = /* @__PURE__ */ new Set(["Fold", "Folded"]);
  function initialState(heroId) {
    return {
      heroId,
      tableId: null,
      handId: null,
      round: 1,
      street: "preflop",
      board: [],
      dealerSeat: 0,
      seats: [],
      turn: null,
      pot: 0,
      roundPot: 0,
      bigBlind: 0,
      heroCards: null,
      heroLegal: null,
      heroCanShowCards: false,
      isTournament: false,
      actions: [],
      readable: true,
      problem: null,
      startedAtRound: null,
      startedClean: false,
      dealtIn: [],
      handDone: false,
      ending: null,
      pendingHole: null,
      invested: {},
      shown: []
    };
  }
  function isHeroTurn(s) {
    return s.readable && !s.isTournament && s.turn === s.heroId && s.heroLegal !== null && s.heroLegal.actions.length > 0;
  }
  function projectedLegal(s) {
    if (!s.readable || s.isTournament || s.handDone || !s.heroCards) return null;
    const hero = s.seats.find((q) => q.userID === s.heroId);
    if (!hero || !hero.inHand || hero.money <= 0) return null;
    const top = Math.max(0, ...s.seats.map((q) => q.streetBet));
    const toCall = Math.max(0, top - hero.streetBet);
    const bb = Math.max(1, s.bigBlind);
    const all = hero.money + hero.streetBet;
    if (toCall === 0) {
      return { actions: ["check", "bet"], toCall: 0, minBet: Math.min(bb, hero.money), maxBet: hero.money, minRaise: 0, maxRaise: 0 };
    }
    if (toCall >= hero.money) {
      return { actions: ["fold", "allin"], toCall, minBet: 0, maxBet: 0, minRaise: all, maxRaise: all };
    }
    const minRaise = Math.min(all, Math.max(2 * top, top + bb));
    return { actions: ["fold", "call", "raise"], toCall, minBet: 0, maxBet: 0, minRaise, maxRaise: all };
  }
  function toSeat(p, dealt) {
    return {
      seat: p.seat,
      userID: p.userID,
      name: p.name,
      money: p.money,
      status: p.status,
      streetBet: p.streetBet,
      handBet: p.handBet,
      amountCall: p.amountCall,
      isSitOut: p.isSitOut,
      inHand: dealt.some((d) => d.userID === p.userID) && !FOLDED.has(p.status)
    };
  }
  function dealtOf(players) {
    return players.filter((p) => !p.isSitOut && !NOT_DEALT.has(p.status)).map((p) => ({ userID: p.userID, name: p.name, seat: p.seat, startMoney: p.money + p.handBet }));
  }
  function shownOf(players) {
    return players.filter((p) => p.shown.length > 0).map((p) => ({ userID: p.userID, cards: [...p.shown], handName: p.handName }));
  }
  function record(s, complete, now, winnings, invested) {
    const hero = s.seats.find((q) => q.userID === s.heroId);
    const heroShown = s.shown.find((x) => x.userID === s.heroId);
    return {
      handId: s.handId ?? "",
      tableId: s.tableId,
      heroId: s.heroId,
      bigBlind: s.bigBlind,
      dealerSeat: s.dealerSeat,
      dealtIn: s.dealtIn,
      actions: s.actions,
      board: s.board,
      shown: s.shown,
      winnings,
      invested,
      heroCards: s.heroCards ?? (hero && heroShown?.cards.length === 2 ? [heroShown.cards[0], heroShown.cards[1]] : null),
      complete: complete && s.startedAtRound === 1 && s.startedClean,
      endedAt: now
    };
  }
  function withInvested(prior, players) {
    const out = { ...prior };
    for (const p of players) if (p.handBet > (out[p.userID] ?? 0)) out[p.userID] = p.handBet;
    return out;
  }
  function actorOf(prev, msg, action) {
    const label = ACTION_STATUS[action];
    const matching = msg.players.filter((p) => p.status === label);
    const changed = matching.filter((p) => {
      const before = prev.seats.find((q) => q.userID === p.userID);
      return !before || before.status !== label || before.handBet !== p.handBet;
    });
    if (prev.seats.length === 0 && matching.length !== 1) return null;
    if (changed.length > 0) {
      return (changed.find((p) => p.userID === prev.turn) ?? changed[0]).userID;
    }
    const last = prev.actions[prev.actions.length - 1];
    if (last && last.action === action && matching.some((p) => p.userID === last.userID)) return last.userID;
    return prev.turn;
  }
  var VOLUNTARY = /* @__PURE__ */ new Set(["Fold", "Folded", "Check", "Call", "Bet", "Raise", "All in"]);
  function isCleanStart(msg) {
    const label = msg.eventType === "playerMakeMove" && msg.userAction ? ACTION_STATUS[msg.userAction] : null;
    const own = label ? msg.players.filter((p) => p.status === label) : [];
    const actor = own.length === 1 ? own[0] : null;
    return msg.players.every((p) => p === actor || !VOLUNTARY.has(p.status));
  }
  function reduceTable(s, msg, now) {
    let finished = null;
    let base = s;
    const newHand = msg.handId !== s.handId;
    if (newHand) {
      if (s.ending) finished = s.ending;
      else if (s.handId !== null && !s.handDone) finished = record(s, false, now, {}, s.invested);
      base = {
        ...s,
        handId: msg.handId,
        actions: [],
        startedAtRound: msg.round,
        startedClean: isCleanStart(msg),
        board: [],
        dealtIn: dealtOf(msg.players),
        handDone: false,
        ending: null,
        shown: [],
        invested: {},
        seats: [],
        pot: 0,
        roundPot: 0,
        turn: null,
        heroLegal: null,
        heroCards: s.pendingHole?.handId === msg.handId ? s.pendingHole.cards : null,
        pendingHole: null
      };
    }
    const street = newHand ? STREETS3[msg.round] : s.street;
    const swept = !newHand && msg.players.every((p) => p.handBet === 0) && base.seats.some((q) => q.handBet > 0);
    const invested = withInvested(base.invested, msg.players);
    let actions = base.actions;
    if (!base.handDone && msg.eventType === "playerMakeMove" && msg.userAction !== null) {
      const userID = actorOf(base, msg, msg.userAction);
      const actor = msg.players.find((p) => p.userID === userID);
      const before = base.seats.find((q) => q.userID === userID);
      let handBetAfter = actor?.handBet ?? 0;
      if (swept && before) {
        const extra = msg.userAction === "call" ? Math.min(before.amountCall, before.money) : msg.userAction === "allin" ? before.money : 0;
        handBetAfter = before.handBet + extra;
        invested[before.userID] = handBetAfter;
      }
      const last = actions[actions.length - 1];
      const dup = last !== void 0 && last.userID === userID && last.street === street && last.action === msg.userAction && last.handBetAfter === handBetAfter;
      if (userID !== null && actor && !dup) {
        actions = [
          ...actions,
          {
            userID,
            street,
            action: msg.userAction,
            handBetAfter,
            toCallBefore: before?.amountCall ?? 0,
            potBefore: base.pot
          }
        ];
      }
    }
    const hero = msg.players.find((p) => p.userID === s.heroId);
    const heroLegal = hero && msg.turn === s.heroId ? {
      actions: [...hero.acceptedActions],
      toCall: hero.amountCall,
      minBet: hero.minBet,
      maxBet: hero.maxBet,
      minRaise: hero.minRaise,
      maxRaise: hero.maxRaise
    } : null;
    const shown = shownOf(msg.players);
    const heroShown = hero && hero.shown.length === 2 ? [hero.shown[0], hero.shown[1]] : null;
    let state = {
      ...base,
      tableId: msg.tableId,
      round: msg.round,
      street: STREETS3[msg.round],
      board: msg.board.length > 0 ? [...msg.board] : base.board,
      dealerSeat: msg.dealer,
      seats: msg.players.map((p) => toSeat(p, base.dealtIn)),
      turn: msg.turn,
      pot: msg.totalPot,
      roundPot: msg.roundPot,
      bigBlind: msg.bigBlind,
      heroCards: base.heroCards ?? heroShown,
      heroLegal,
      heroCanShowCards: hero?.canShowCards ?? false,
      isTournament: msg.isTournament,
      actions,
      readable: true,
      problem: null,
      invested,
      shown: shown.length > 0 ? shown : base.shown
    };
    if (!newHand && base.ending) {
      finished = { ...base.ending, shown: shown.length > 0 ? shown : base.ending.shown };
      state = { ...state, ending: null, handDone: true };
    } else if (!base.handDone && finished === null && (msg.round === 5 || msg.ended)) {
      const winnings = {};
      for (const p of msg.players) if (p.winnings > 0) winnings[p.userID] = p.winnings;
      if (Object.keys(winnings).length > 0) {
        const rec = record(state, true, now, winnings, state.invested);
        if (state.shown.length > 0) {
          finished = rec;
          state = { ...state, handDone: true };
        } else {
          state = { ...state, handDone: true, ending: rec };
        }
      }
    }
    return { state, finished };
  }
  function reduce(s, ev, now) {
    switch (ev.kind) {
      case "table":
        return reduceTable(s, ev.msg, now);
      case "holeCards": {
        const state = ev.handId === s.handId ? { ...s, heroCards: ev.cards } : { ...s, pendingHole: { handId: ev.handId, cards: ev.cards } };
        return { state, finished: null };
      }
      case "seat": {
        const seat = toSeat(ev.player, s.dealtIn);
        const rest = s.seats.filter((q) => q.seat !== seat.seat);
        const seats = [...rest, seat].sort((a, b) => a.seat - b.seat);
        const invested = withInvested(s.invested, [ev.player]);
        return { state: { ...s, seats, invested }, finished: null };
      }
      case "seatRemoved":
        return { state: { ...s, seats: s.seats.filter((q) => q.seat !== ev.seat) }, finished: null };
      case "unknown":
        return { state: { ...s, readable: false, problem: ev.reason }, finished: null };
    }
  }

  // src/advice/position.ts
  var OPEN_PCT = {
    UTG: 12,
    "UTG+1": 14,
    MP: 17,
    LJ: 20,
    HJ: 25,
    CO: 30,
    BTN: 45,
    SB: 40,
    BB: 0
  };
  var FROM_BUTTON = ["BTN", "CO", "HJ", "LJ", "MP", "UTG+1", "UTG"];
  function dealerIndex(seats, dealerSeat) {
    let idx = -1;
    for (let i = 0; i < seats.length; i++) if (seats[i] <= dealerSeat) idx = i;
    return idx >= 0 ? idx : seats.length - 1;
  }
  function orderAfterDealer(seats, dealerSeat, seat) {
    const i = seats.indexOf(seat);
    if (i < 0) return -1;
    const n = seats.length;
    return (i - dealerIndex(seats, dealerSeat) - 1 + n) % n;
  }
  function positionOf(dealtInSeats, dealerSeat, seat) {
    const n = dealtInSeats.length;
    const order = orderAfterDealer(dealtInSeats, dealerSeat, seat);
    if (order < 0) throw new Error("Seat not dealt in");
    if (n <= 2) return order === n - 1 ? "BTN" : "BB";
    if (order === 0) return "SB";
    if (order === 1) return "BB";
    const names = n === 3 ? ["BTN"] : ["UTG", ...FROM_BUTTON.slice(0, n - 3).reverse()];
    return names[order - 2];
  }

  // src/advice/context.ts
  function priceOf(s, toCall, heroMoney) {
    const heroIn = s.invested[s.heroId];
    if (toCall <= heroMoney || heroIn === void 0) return { pot: s.pot, toCall };
    const cap = heroIn + heroMoney;
    const pot = Object.values(s.invested).reduce((sum2, x) => sum2 + Math.min(x, cap), 0);
    return { pot, toCall: heroMoney };
  }
  var NO_RATES = { vpip: null, pfr: null, threeBet: null, foldToRaise: null, wtsd: null, af: null, cbet: null, foldToCbet: null };
  function buildContext(s, profiles) {
    if (!isHeroTurn(s) || !s.heroLegal) return null;
    return contextFor(s, profiles, s.heroLegal);
  }
  function buildPreviewContext(s, profiles) {
    if (isHeroTurn(s)) return null;
    const legal = projectedLegal(s);
    return legal ? contextFor(s, profiles, legal) : null;
  }
  function villainRates(prof) {
    const r = blendedRates(prof);
    return {
      ...r,
      foldToRaise: prof.hands >= MIN_HANDS_FOR_STYLE ? r.foldToRaise : null,
      cbet: (prof.cbet?.d ?? 0) >= MIN_CBET_OPPS ? r.cbet : null,
      foldToCbet: (prof.foldToCbet?.d ?? 0) >= MIN_CBET_OPPS ? r.foldToCbet : null
    };
  }
  function contextFor(s, profiles, legal) {
    if (!s.heroCards) return null;
    const hero = s.seats.find((q) => q.userID === s.heroId);
    const heroDealt = s.dealtIn.find((d) => d.userID === s.heroId);
    if (!hero || !heroDealt) return null;
    const dealtSeats = s.dealtIn.map((d) => d.seat).sort((a, b) => a - b);
    const position = positionOf(dealtSeats, s.dealerSeat, heroDealt.seat);
    const foldedIds = new Set(s.actions.filter((a) => a.action === "fold").map((a) => a.userID));
    const villains = [];
    for (const d of s.dealtIn) {
      if (d.userID === s.heroId || foldedIds.has(d.userID)) continue;
      const seat = s.seats.find((q) => q.userID === d.userID);
      if (seat && !seat.inHand) continue;
      const prof = profiles.get(d.userID);
      const known = prof !== void 0 && prof.hands > 0;
      villains.push({
        userID: d.userID,
        name: d.name,
        seat: d.seat,
        position: positionOf(dealtSeats, s.dealerSeat, d.seat),
        stack: seat?.money ?? 0,
        style: known ? readStyle(prof) : "Unknown",
        rates: known ? villainRates(prof) : NO_RATES,
        hands: prof?.hands ?? 0,
        ...prof?.betSizes ? { betSizes: prof.betSizes } : {},
        actions: s.actions.filter((a) => a.userID === d.userID)
      });
    }
    let maxBet = s.bigBlind;
    let preflopRaises = 0;
    let lastAggressorId = null;
    let lastPreflopRaiserId = null;
    let facedBet;
    for (const a of s.actions) {
      if (a.action === "raise" || a.action === "bet" || a.action === "allin" && a.handBetAfter > maxBet) {
        if (a.userID !== s.heroId) lastAggressorId = a.userID;
        const f = a.street === "preflop" || a.userID === s.heroId ? null : betFraction(a, maxBet);
        facedBet = f === null ? void 0 : bucketOf(f);
        if (a.street === "preflop") {
          preflopRaises += 1;
          lastPreflopRaiserId = a.userID;
        }
      }
      if (a.handBetAfter > maxBet) maxBet = a.handBetAfter;
    }
    const orderOf = (seat) => orderAfterDealer(dealtSeats, s.dealerSeat, seat);
    const heroOrder = orderOf(heroDealt.seat);
    const inPosition = !(s.street === "preflop" && position === "BB") && villains.every((v) => orderOf(v.seat) < heroOrder);
    return {
      heroCards: s.heroCards,
      board: s.board,
      street: s.street,
      position,
      ...priceOf(s, legal.toCall, hero.money),
      legal,
      bigBlind: s.bigBlind,
      heroStack: hero.money,
      heroStreetBet: hero.streetBet,
      villains,
      preflopRaises,
      lastAggressor: villains.find((v) => v.userID === lastAggressorId) ?? null,
      inPosition,
      heroRaisedPreflop: lastPreflopRaiserId === s.heroId,
      ...facedBet ? { facedBet } : {},
      heroCheckedThisStreet: s.actions.some((a) => a.userID === s.heroId && a.street === s.street && a.action === "check")
    };
  }

  // src/core/equity.ts
  var MAX_TRIES = 50;
  function cumulative(range) {
    const cum = new Float64Array(COMBOS);
    let total2 = 0;
    for (let i = 0; i < COMBOS; i++) {
      total2 += range[i];
      cum[i] = total2;
    }
    return cum;
  }
  function createSim(hero, board, villains, rng) {
    const dead = [hero[0], hero[1], ...board];
    const tables = villains.map((v) => {
      let r = removeDead(v, dead);
      const cum = cumulative(r);
      if (cum[COMBOS - 1] <= 0) {
        r = removeDead(new Float32Array(COMBOS).fill(1), dead);
        return cumulative(r);
      }
      return cum;
    });
    const combos = Array.from({ length: COMBOS }, (_, i) => comboCards(i));
    const nV = villains.length;
    const used = new Uint8Array(52);
    const boardNeeded = 5 - board.length;
    const heroCards = new Array(7);
    const villainCards = Array.from({ length: nV }, () => new Array(7));
    const vCombo = new Array(nV);
    const fixed = [hero[0], hero[1], ...board];
    let wins = 0;
    let ties = 0;
    let samples = 0;
    let equitySum = 0;
    function pick(cum) {
      const x = rng() * cum[COMBOS - 1];
      let lo = 0;
      let hi = COMBOS - 1;
      while (lo < hi) {
        const mid = lo + hi >> 1;
        if (cum[mid] > x) hi = mid;
        else lo = mid + 1;
      }
      return lo;
    }
    function step() {
      used.fill(0);
      for (const c of fixed) used[c] = 1;
      for (let v = 0; v < nV; v++) {
        let found = false;
        for (let t = 0; t < MAX_TRIES; t++) {
          const combo = combos[pick(tables[v])];
          if (used[combo[0]] || used[combo[1]]) continue;
          used[combo[0]] = 1;
          used[combo[1]] = 1;
          vCombo[v] = combo;
          found = true;
          break;
        }
        if (!found) return false;
      }
      for (let i = 0; i < fixed.length; i++) {
        heroCards[i] = fixed[i];
        for (let v = 0; v < nV; v++) villainCards[v][i] = fixed[i];
      }
      for (let k = 0; k < boardNeeded; k++) {
        let c;
        do
          c = Math.floor(rng() * 52);
        while (used[c]);
        used[c] = 1;
        heroCards[2 + board.length + k] = c;
        for (let v = 0; v < nV; v++) villainCards[v][2 + board.length + k] = c;
      }
      for (let v = 0; v < nV; v++) {
        villainCards[v][0] = vCombo[v][0];
        villainCards[v][1] = vCombo[v][1];
      }
      const heroScore = evaluate(heroCards);
      let best = heroScore;
      let tiedWithHero = 1;
      for (let v = 0; v < nV; v++) {
        const s = evaluate(villainCards[v]);
        if (s > best) {
          best = s;
          tiedWithHero = 0;
        } else if (s === best && heroScore === best) {
          tiedWithHero++;
        }
      }
      samples++;
      if (heroScore === best) {
        if (tiedWithHero === 1) {
          wins++;
          equitySum += 1;
        } else {
          ties++;
          equitySum += 1 / tiedWithHero;
        }
      }
      return true;
    }
    return {
      step,
      result: () => samples === 0 ? { equity: 0, win: 0, tie: 0, samples: 0 } : { equity: equitySum / samples, win: wins / samples, tie: ties / samples, samples }
    };
  }
  function abortError() {
    const e = new Error("Aborted");
    e.name = "AbortError";
    return e;
  }
  async function equityAsync(hero, board, villains, opts) {
    const { signal } = opts;
    if (signal?.aborted) throw abortError();
    const sliceMs = opts.sliceMs ?? 8;
    const sim = createSim(hero, board, villains, opts.rng ?? Math.random);
    let i = 0;
    while (i < opts.iterations) {
      const start = performance.now();
      do {
        sim.step();
        i++;
      } while (i < opts.iterations && performance.now() - start < sliceMs);
      if (i < opts.iterations) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (signal?.aborted) throw abortError();
      }
    }
    return sim.result();
  }

  // src/core/draws.ts
  var MADE = ["Straight", "Flush", "Full house", "Quads", "Straight flush"];
  var hasCategory = (cards, names) => names.includes(categoryOf(evaluate(cards)));
  function hitChance(outs, boardSize) {
    const unseen = 52 - 2 - boardSize;
    if (boardSize === 4) return outs / unseen;
    const misses = unseen - outs;
    return 1 - misses * (misses - 1) / (unseen * (unseen - 1));
  }
  function findDraw(hole, board) {
    if (board.length !== 3 && board.length !== 4) return null;
    const now = [...hole, ...board];
    if (hasCategory(now, MADE)) return null;
    const boardRanks = new Set(board.map(rankOf));
    const boardPaired = boardRanks.size < board.length;
    const flushOuts = /* @__PURE__ */ new Set();
    const straightOuts = /* @__PURE__ */ new Set();
    const straightRanks = /* @__PURE__ */ new Set();
    for (let card = 0; card < 52; card++) {
      if (now.includes(card)) continue;
      const next = [...now, card];
      const nextBoard = [...board, card];
      if (hasCategory(next, ["Flush", "Straight flush"]) && !hasCategory(nextBoard, ["Flush", "Straight flush"])) {
        if (!(boardPaired && boardRanks.has(rankOf(card)))) flushOuts.add(card);
      } else if (hasCategory(next, ["Straight", "Straight flush"]) && !hasCategory(nextBoard, ["Straight", "Straight flush"])) {
        straightOuts.add(card);
        straightRanks.add(rankOf(card));
      }
    }
    const outs = flushOuts.size + straightOuts.size;
    if (outs === 0) return null;
    const parts = [];
    if (flushOuts.size > 0) parts.push("flush draw");
    if (straightRanks.size >= 2) parts.push("open-ended straight draw");
    else if (straightRanks.size === 1) parts.push("gutshot straight draw");
    const name = parts.join(" and ");
    return { name: name[0].toUpperCase() + name.slice(1), outs, hitChance: hitChance(outs, board.length) };
  }

  // src/advice/depth.ts
  var TIERS = [
    { name: "short", maxBB: 15, bluffShare: Infinity, label: "short stack" },
    { name: "medium", maxBB: 40, bluffShare: 0.33, label: "medium stack" },
    { name: "deep", maxBB: Infinity, bluffShare: Infinity, label: "deep stack" }
  ];
  var SPR_BANDS = [
    { maxSpr: 3, valueShift: -0.08, commit: true },
    { maxSpr: 13, valueShift: 0, commit: false },
    { maxSpr: Infinity, valueShift: 0.04, commit: false }
  ];
  function sprBand(spr) {
    return SPR_BANDS.find((b) => spr !== null && spr <= b.maxSpr) ?? SPR_BANDS[1];
  }
  function depthOf(ctx) {
    const deepest = Math.max(0, ...ctx.villains.map((v) => v.stack));
    const chips = deepest > 0 ? Math.min(ctx.heroStack, deepest) : ctx.heroStack;
    const stackBB = ctx.bigBlind > 0 ? chips / ctx.bigBlind : Infinity;
    const tier = TIERS.find((t) => stackBB <= t.maxBB).name;
    const spr = ctx.board.length > 0 && ctx.pot > 0 ? chips / ctx.pot : null;
    return { stackBB, tier, spr };
  }
  var tierOf = (d) => TIERS.find((t) => t.name === d.tier);
  var bbText = (bb) => `${Number(bb.toFixed(1))} BB`;

  // src/advice/villain-range.ts
  var PARAMS = {
    Rock: { keep: 0.35, bluff: 0.05, call: 0.4 },
    "Tight-Aggressive": { keep: 0.5, bluff: 0.15, call: 0.5 },
    Aggro: { keep: 0.65, bluff: 0.3, call: 0.6 },
    Maniac: { keep: 0.85, bluff: 0.5, call: 0.7 },
    "Calling station": { keep: 0.4, bluff: 0.05, call: 0.85 },
    Unknown: { keep: 0.5, bluff: 0.15, call: 0.55 }
  };
  var BOARD_LEN2 = { preflop: 0, flop: 3, turn: 4, river: 5 };
  var DRAW_BONUS = 0.15;
  var EPS2 = 1e-6;
  function classified(v, bigBlind) {
    let committed = v.position === "SB" ? bigBlind / 2 : v.position === "BB" ? bigBlind : 0;
    return v.actions.map((a) => {
      const facing = committed + a.toCallBefore;
      const aggressive = a.action === "raise" || a.action === "bet" || a.action === "allin" && a.handBetAfter > facing + EPS2;
      committed = a.handBetAfter;
      return { a, facing, aggressive };
    });
  }
  function preflopRange(v, ctx, acts) {
    let level = -1;
    for (const { a, facing, aggressive } of acts) {
      if (a.street !== "preflop") continue;
      let l;
      if (aggressive) l = facing > ctx.bigBlind + EPS2 ? 3 : 2;
      else if (a.action === "check") l = v.position === "BB" ? 0 : -1;
      else if (a.action === "fold") l = -1;
      else l = 1;
      if (l > level) level = l;
    }
    const { vpip, pfr, threeBet } = v.rates;
    if (level === 3) return topPercent(threeBet ?? 5);
    if (level === 2) return topPercent(pfr ?? (OPEN_PCT[v.position] || 12));
    const out = new Float32Array(COMBOS);
    if (level === 1) {
      const wide = topPercent(vpip ?? 25);
      const tight = topPercent(pfr ?? 12);
      for (let i = 0; i < COMBOS; i++) out[i] = wide[i] > 0 ? tight[i] > 0 ? 0.3 : 1 : 0;
      return out;
    }
    if (level === 0) {
      const top = topPercent(10);
      for (let i = 0; i < COMBOS; i++) out[i] = top[i] > 0 ? 0.3 : 1;
      return out;
    }
    return topPercent(vpip ?? 25);
  }
  function hasFlushDraw(hole, board) {
    if (board.length >= 5) return false;
    for (let s = 0; s < 4; s++) {
      const inHole = hole.filter((c) => suitOf(c) === s).length;
      if (inHole === 0) continue;
      if (inHole + board.filter((c) => suitOf(c) === s).length >= 4) return true;
    }
    return false;
  }
  function hasOpenEnder(hole, board) {
    if (board.length >= 5) return false;
    let boardMask = 0;
    let holeMask = 0;
    for (const c of hole) holeMask |= 1 << rankOf(c);
    for (const c of board) boardMask |= 1 << rankOf(c);
    const mask = boardMask | holeMask;
    for (let r = 0; r <= 8; r++) {
      const run = 15 << r;
      if ((mask & run) === run && (holeMask & ~boardMask & run) !== 0) return true;
    }
    return false;
  }
  function strengthOn(board) {
    const value = new Float64Array(COMBOS);
    const draw = new Uint8Array(COMBOS);
    const boardSet = new Set(board);
    const cards = [0, 0, ...board];
    for (let i = 0; i < COMBOS; i++) {
      const hole = comboCards(i);
      if (boardSet.has(hole[0]) || boardSet.has(hole[1])) {
        value[i] = -1;
        continue;
      }
      cards[0] = hole[0];
      cards[1] = hole[1];
      value[i] = evaluate(cards);
      draw[i] = hasFlushDraw(hole, board) || hasOpenEnder(hole, board) ? 1 : 0;
    }
    return { value, draw };
  }
  function scores(range, st) {
    const live = [];
    for (let i = 0; i < COMBOS; i++) if (range[i] > 0 && st.value[i] >= 0) live.push(i);
    live.sort((a, b) => st.value[a] - st.value[b]);
    const out = new Float64Array(COMBOS);
    const n = live.length;
    for (let lo = 0; lo < n; ) {
      let hi = lo;
      while (hi + 1 < n && st.value[live[hi + 1]] === st.value[live[lo]]) hi++;
      const avgRank = (lo + hi + 2) / 2;
      for (let k = lo; k <= hi; k++) {
        const i = live[k];
        out[i] = Math.min(1, avgRank / n + (st.draw[i] ? DRAW_BONUS : 0));
      }
      lo = hi + 1;
    }
    return out;
  }
  function narrow(range, a, aggressive, sc, p, style) {
    const out = Float32Array.from(range);
    for (let i = 0; i < COMBOS; i++) {
      if (out[i] <= 0) continue;
      const s = sc[i];
      switch (aggressive ? "bet" : a.action === "allin" ? "call" : a.action) {
        case "bet":
          if (s < 1 - p.keep) out[i] = Math.fround(out[i] * p.bluff);
          break;
        case "call":
          if (s < 1 - p.call) out[i] = Math.fround(out[i] * 0.1);
          else if (s > 0.9 && style !== "Calling station") out[i] = Math.fround(out[i] * 0.5);
          break;
        case "check":
          if (s > 0.85) out[i] = Math.fround(out[i] * 0.4);
          break;
      }
    }
    return out;
  }
  function total(r) {
    let t = 0;
    for (let i = 0; i < COMBOS; i++) t += r[i];
    return t;
  }
  function estimateRange(v, ctx) {
    const dead = [...ctx.heroCards, ...ctx.board];
    const acts = classified(v, ctx.bigBlind);
    let start = removeDead(preflopRange(v, ctx, acts), dead);
    if (total(start) <= 0) start = removeDead(topPercent(v.rates.vpip ?? 25), dead);
    const params = PARAMS[v.style];
    const cache = /* @__PURE__ */ new Map();
    let range = start;
    for (const { a, aggressive } of acts) {
      if (a.street === "preflop" || a.action === "fold") continue;
      let st = cache.get(a.street);
      if (!st) {
        st = strengthOn(ctx.board.slice(0, BOARD_LEN2[a.street]));
        cache.set(a.street, st);
      }
      range = narrow(range, a, aggressive, scores(range, st), params, v.style);
    }
    if (total(range) <= 0) return start;
    return removeDead(range, dead);
  }

  // src/advice/describe.ts
  var SINGULAR = ["Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Jack", "Queen", "King", "Ace"];
  var PLURAL = ["Twos", "Threes", "Fours", "Fives", "Sixes", "Sevens", "Eights", "Nines", "Tens", "Jacks", "Queens", "Kings", "Aces"];
  var NO_DRAW_FROM = ["Straight", "Flush", "Full house", "Quads", "Straight flush"];
  function rankMask(cards) {
    let m = 0;
    for (const c of cards) m |= 1 << rankOf(c);
    return m;
  }
  function completingRanks(hole, board) {
    const holeMask = rankMask(hole);
    const mask = holeMask | rankMask(board);
    let completing = 0;
    for (let m = 0; m < 13; m++) {
      if (mask & 1 << m) continue;
      for (let s = -1; s <= 8; s++) {
        let inWindow = false;
        let missing = 0;
        let heroUsed = false;
        for (let k = 0; k < 5; k++) {
          const r = s + k < 0 ? 12 : s + k;
          if (r === m) inWindow = true;
          else if (!(mask & 1 << r)) missing++;
          else if (holeMask & 1 << r) heroUsed = true;
        }
        if (inWindow && missing === 0 && heroUsed) {
          completing++;
          break;
        }
      }
    }
    return completing;
  }
  function detectDraw(hole, board) {
    if (hasFlushDraw(hole, board)) return "flush draw";
    if (hasOpenEnder(hole, board)) return "open-ended straight draw";
    const n = completingRanks(hole, board);
    return n >= 2 ? "open-ended straight draw" : n === 1 ? "gutshot" : null;
  }
  function preflopLabel(hole) {
    const [hi, lo] = rankOf(hole[0]) >= rankOf(hole[1]) ? hole : [hole[1], hole[0]];
    if (rankOf(hi) === rankOf(lo)) return `Pocket ${PLURAL[rankOf(hi)]}`;
    const suited = (hi & 3) === (lo & 3);
    return `${SINGULAR[rankOf(hi)]}-${SINGULAR[rankOf(lo)]} ${suited ? "suited" : "offsuit"}`;
  }
  function ownContribution(hole, board) {
    const [a, b] = [rankOf(hole[0]), rankOf(hole[1])];
    const boardRanks = [...new Set(board.map(rankOf))].sort((x, y) => y - x);
    const top = boardRanks[0];
    const bottom = boardRanks[boardRanks.length - 1];
    if (a === b) {
      if (a > top) return `Overpair (${PLURAL[a]})`;
      if (a < bottom) return `Underpair (${PLURAL[a]})`;
      return "Middle pair";
    }
    const paired = [a, b].filter((r) => boardRanks.includes(r));
    if (paired.length === 0) return "High card";
    const pr = Math.max(...paired);
    if (pr === top) {
      const kicker = pr === a ? b : a;
      let best = 12;
      while (boardRanks.includes(best)) best--;
      return kicker === best ? "Top pair, top kicker" : "Top pair, weak kicker";
    }
    return pr === bottom ? "Bottom pair" : "Middle pair";
  }
  function boardKickerLabel(hole, board, category) {
    const size = { Pair: 1, "Two pair": 2, Trips: 1, Quads: 1 }[category];
    const need = { Pair: 2, "Two pair": 2, Trips: 3, Quads: 4 }[category];
    if (!size || !need) return null;
    const boardCounts = new Array(13).fill(0);
    for (const c of board) boardCounts[rankOf(c)]++;
    const holeRanks = hole.map(rankOf);
    const defining = [];
    for (let r = 12; r >= 0 && defining.length < size; r--) {
      if (boardCounts[r] + holeRanks.filter((h) => h === r).length >= need) defining.push(r);
    }
    if (defining.some((r) => boardCounts[r] < need || holeRanks.includes(r))) return null;
    const kickers = [...board.map(rankOf), ...holeRanks].filter((r) => !defining.includes(r)).sort((a, b) => b - a).slice(0, 5 - size * need);
    const heroKicker = holeRanks.filter((r) => kickers.includes(r)).sort((a, b) => b - a)[0];
    return heroKicker === void 0 ? null : `${category} on the board, ${SINGULAR[heroKicker]} kicker`;
  }
  function madeLabel(hole, board, category) {
    const counts2 = new Array(13).fill(0);
    for (const c of [...hole, ...board]) counts2[rankOf(c)]++;
    const holeRanks = hole.map(rankOf);
    switch (category) {
      case "Straight flush":
      case "Flush":
      case "Straight":
        return category;
      case "Quads":
      case "Full house":
        return holeRanks.some((r) => counts2[r] >= 2) ? category : ownContribution(hole, board);
      case "Trips": {
        const t = counts2.indexOf(3);
        if (holeRanks[0] === t && holeRanks[1] === t) return `Set of ${PLURAL[t]}`;
        if (holeRanks.includes(t)) return "Trips";
        return ownContribution(hole, board);
      }
      case "Two pair": {
        const pairs = [];
        for (let r = 12; r >= 0; r--) if (counts2[r] >= 2) pairs.push(r);
        return holeRanks.some((r) => pairs.slice(0, 2).includes(r)) ? "Two pair" : ownContribution(hole, board);
      }
      case "Pair":
        return ownContribution(hole, board);
      default:
        return "High card";
    }
  }
  function describeHand(hole, board) {
    if (board.length === 0) return { label: preflopLabel(hole), draw: null, category: null };
    const value = evaluate([...hole, ...board]);
    const category = categoryOf(value);
    if (board.length === 5 && evaluate(board) === value) {
      return { label: `Playing the board (${category})`, draw: null, category };
    }
    let label = boardKickerLabel(hole, board, category) ?? madeLabel(hole, board, category);
    let draw = null;
    if ((board.length === 3 || board.length === 4) && !NO_DRAW_FROM.includes(category)) {
      draw = detectDraw(hole, board);
      if (draw) label += ` + ${draw}`;
    }
    return { label, draw, category };
  }

  // src/advice/decide.ts
  var PREFLOP_ORDER2 = ["UTG", "UTG+1", "MP", "LJ", "HJ", "CO", "BTN", "SB", "BB"];
  var POSTFLOP_ORDER = ["SB", "BB", "UTG", "UTG+1", "MP", "LJ", "HJ", "CO", "BTN"];
  function roundAmount(x) {
    if (!(x > 0)) return 0;
    const scale = 10 ** (Math.floor(Math.log10(x)) - 1);
    return Math.round(x / scale + 1e-9) * scale;
  }
  var pct4 = (x) => Math.round(x * 100);
  var allInTotal = (ctx) => ctx.heroStack + ctx.heroStreetBet;
  var betLevel = (ctx) => ctx.heroStreetBet + ctx.toCall;
  var potOddsOf = (ctx) => ctx.toCall > 0 ? ctx.toCall / (ctx.pot + ctx.toCall) : null;
  function facingOf(ctx) {
    if (ctx.toCall > 0 && ctx.lastAggressor) return ctx.lastAggressor;
    return ctx.villains.length === 1 ? ctx.villains[0] : null;
  }
  function targetOf(ctx) {
    return facingOf(ctx) ?? ctx.villains.find((v) => v.style === "Calling station") ?? ctx.villains[0] ?? null;
  }
  function confidence(ctx, equity, threshold) {
    const margin = threshold === null ? null : Math.abs(equity - threshold);
    if (ctx.villains.some((v) => v.hands < LOW_SAMPLE) || margin !== null && margin < 0.05) return "low";
    if (ctx.villains.every((v) => v.hands >= 100) && (margin === null || margin > 0.1)) return "high";
    return "medium";
  }
  function build(ctx, eq, d) {
    const facing = facingOf(ctx);
    const depth = depthOf(ctx);
    const draw = findDraw(ctx.heroCards, ctx.board);
    return {
      action: d.action,
      amount: d.amount,
      equity: eq.equity,
      potOdds: potOddsOf(ctx),
      hand: describeHand(ctx.heroCards, ctx.board).label,
      position: ctx.position,
      facing: facing ? { name: facing.name, style: facing.style } : null,
      reason: d.reason,
      detail: [`Equity ${pct4(eq.equity)}% from ${eq.samples} samples`, ...d.detail],
      confidence: confidence(ctx, eq.equity, d.threshold),
      bigBlind: ctx.bigBlind,
      effectiveStackBB: depth.stackBB,
      spr: depth.spr,
      ...draw ? { draw } : {}
    };
  }
  function callCopy(eq, potOdds) {
    return `Getting ${pct4(potOdds)}% pot odds with ${pct4(eq.equity)}% equity \u2014 call.`;
  }
  function foldCopy(eq, potOdds) {
    return foldText(eq.equity, potOdds);
  }
  function foldText(equity, potOdds) {
    const e = pct4(equity);
    const o = pct4(potOdds ?? 0);
    return e >= o ? `${e}% equity only breaks even at ${o}% pot odds \u2014 not worth the risk, fold.` : `${e}% equity isn't enough at ${o}% pot odds \u2014 fold.`;
  }
  var CHECK_COPY = "Not strong enough to bet \u2014 check.";
  function valueCopy(name, style) {
    return style === "Unknown" ? "Strong hand \u2014 bet for value." : `Strong hand vs ${name}'s ${style} range \u2014 bet for value.`;
  }
  function inPositionVs(ctx, v) {
    if (!v) return ctx.inPosition;
    return POSTFLOP_ORDER.indexOf(ctx.position) > POSTFLOP_ORDER.indexOf(v.position);
  }
  function decidePreflop(ctx, eq) {
    const a = chartPreflop(ctx, eq);
    const depth = depthOf(ctx);
    const stack = `${tierOf(depth).label} of ${bbText(depth.stackBB)}`;
    const limp = ctx.preflopRaises === 0 && ctx.toCall > 0 && ctx.toCall <= ctx.bigBlind;
    if (depth.tier === "short") {
      if (a.action === "raise") {
        return { ...a, action: "allin", amount: allInTotal(ctx), reason: `${a.hand} is playable, but with a ${stack} the move is all-in, not a small raise.`, detail: [...a.detail, "Short stacks push all-in or fold."] };
      }
      if (a.action === "call" && limp) {
        return { ...a, action: "fold", amount: null, reason: `With a ${stack}, ${a.hand} is not worth a limp \u2014 fold.`, detail: [...a.detail, "Short stacks push all-in or fold, they do not limp."] };
      }
    }
    if (depth.tier === "medium" && a.action === "raise" && ctx.preflopRaises === 1 && topPercent(MEDIUM_3BET_PCT)[comboIndex(ctx.heroCards[0], ctx.heroCards[1])] === 0) {
      const cheap = ctx.toCall <= 0.1 * ctx.heroStack;
      const reason = `With a ${stack}, a 3-bet with ${a.hand} would commit too much of it \u2014 ${cheap ? "just call" : "fold"}.`;
      return cheap ? { ...a, action: "call", amount: null, reason, detail: [...a.detail, `Medium stacks 3-bet only the top ${MEDIUM_3BET_PCT}% of hands.`] } : { ...a, action: "fold", amount: null, reason, detail: [...a.detail, `Medium stacks 3-bet only the top ${MEDIUM_3BET_PCT}% of hands.`] };
    }
    return a;
  }
  var MEDIUM_3BET_PCT = 3;
  function chartPreflop(ctx, eq) {
    const hand = describeHand(ctx.heroCards, ctx.board).label;
    const combo = comboIndex(ctx.heroCards[0], ctx.heroCards[1]);
    const inTop = (p) => topPercent(p)[combo] > 0;
    const potOdds = potOddsOf(ctx);
    const bb = ctx.bigBlind;
    const fold = (threshold = null) => ({
      action: "fold",
      amount: null,
      reason: potOdds !== null && eq.equity < potOdds ? foldCopy(eq, potOdds) : `${hand} isn't in your ${ctx.position} range here \u2014 fold.`,
      threshold,
      detail: []
    });
    const chartFold = () => {
      const raiser = ctx.lastAggressor;
      const closes = raiser !== null && (raiser.stack === 0 || raiser.actions.some((a) => a.action === "allin") || ctx.villains.every((v) => v === raiser || v.stack === 0));
      if (closes && potOdds !== null && eq.equity >= potOdds + 0.05) {
        return {
          action: "call",
          amount: null,
          reason: callCopy(eq, potOdds),
          threshold: potOdds + 0.05,
          detail: [raiser.stack === 0 ? `${raiser.name} is all-in \u2014 a cheap call.` : "Nobody else can act \u2014 a cheap call."]
        };
      }
      return fold();
    };
    const call = (threshold, why) => ({
      action: "call",
      amount: null,
      reason: potOdds !== null && eq.equity >= potOdds ? callCopy(eq, potOdds) : `${hand} is good enough to call ${ctx.lastAggressor?.name ?? "the raise"}.`,
      threshold,
      detail: [why]
    });
    if (ctx.preflopRaises === 0) {
      const heroIdx = PREFLOP_ORDER2.indexOf(ctx.position);
      const behind = ctx.villains.filter((v) => PREFLOP_ORDER2.indexOf(v.position) > heroIdx);
      let p = OPEN_PCT[ctx.position];
      if (behind.length > 0 && behind.every((v) => (v.rates.foldToRaise ?? 0) >= 60)) p += 5;
      if (behind.some((v) => v.style === "Maniac")) p -= 3;
      const limpers = ctx.villains.filter(
        (v) => v.actions.some((a) => a.street === "preflop") && v.actions.every((a) => a.street !== "preflop" || a.action === "call")
      ).length;
      const limperCopy = `${limpers} limper${limpers === 1 ? "" : "s"}`;
      const outOfPosition = ctx.position === "SB";
      const iso = (open) => Math.max(4, open - 4 * limpers - (outOfPosition ? 3 : 0));
      if (ctx.position === "BB" && ctx.toCall === 0) {
        const range = limpers ? iso(15) : 15;
        if (inTop(range)) {
          return build(ctx, eq, {
            action: "raise",
            amount: roundAmount((4 + limpers) * bb),
            reason: limpers ? `${hand} is strong enough to raise ${limperCopy}.` : `${hand} is in your BB opening range.`,
            threshold: null,
            detail: [
              ...limpers ? [`Raising the top ${range}% against ${limperCopy}.`] : [],
              `Raise to ${4 + limpers}\xD7 the big blind.`
            ]
          });
        }
        return build(ctx, eq, { action: "check", amount: null, reason: CHECK_COPY, threshold: null, detail: [] });
      }
      const raiseRange = limpers ? iso(p) : p;
      if (inTop(raiseRange)) {
        return build(ctx, eq, {
          action: "raise",
          amount: roundAmount((3 + limpers) * bb),
          reason: limpers ? `${hand} is strong enough to raise ${limperCopy}.` : `${hand} is in your ${ctx.position} opening range.`,
          threshold: null,
          detail: [
            limpers ? `Raising the top ${raiseRange}% against ${limperCopy}.` : `Opening the top ${p}% of hands from ${ctx.position}.`,
            `Raise to 3\xD7 the big blind${limpers ? ` plus 1\xD7 per limper (${limpers})` : ""}.`
          ]
        });
      }
      if (limpers && inTop(p) && ctx.toCall > 0 && ctx.toCall <= bb) {
        return build(ctx, eq, {
          action: "call",
          amount: null,
          reason: `${hand} plays well multiway \u2014 just call ${Number((ctx.toCall / bb).toFixed(2))} BB and see a flop.`,
          threshold: null,
          detail: [`Too many limpers to raise ${hand} profitably.`]
        });
      }
      if (ctx.toCall === 0) {
        return build(ctx, eq, { action: "check", amount: null, reason: CHECK_COPY, threshold: null, detail: [] });
      }
      return build(ctx, eq, fold());
    }
    const aggressor = ctx.lastAggressor;
    if (ctx.preflopRaises === 1) {
      const style = aggressor?.style;
      const threeBet = style === "Rock" ? 3 : style === "Aggro" || style === "Maniac" ? 9 : 5;
      if (inTop(threeBet)) {
        const ip = inPositionVs(ctx, aggressor);
        const mult = ip ? 3 : 3.5;
        return build(ctx, eq, {
          action: "raise",
          amount: roundAmount(mult * betLevel(ctx)),
          reason: `${hand} is strong enough to 3-bet ${aggressor?.name ?? "the raiser"}.`,
          threshold: null,
          detail: [`3-betting the top ${threeBet}%; raise to ${mult}\xD7 the raise ${ip ? "in" : "out of"} position.`]
        });
      }
      const wide = ["BTN", "CO", "BB"].includes(ctx.position) ? 12 : 7;
      if (inTop(threeBet + wide) && ctx.toCall <= 0.1 * ctx.heroStack) {
        return build(ctx, eq, call(null, `Calling the top ${threeBet + wide}% when it costs \u2264 10% of your stack.`));
      }
      if (ctx.position === "BB" && potOdds !== null) {
        if (eq.equity >= potOdds) return build(ctx, eq, call(potOdds, "Equity beats the pot odds from the big blind."));
        return build(ctx, eq, fold(potOdds));
      }
      return build(ctx, eq, chartFold());
    }
    if (inTop(2.5)) {
      return build(ctx, eq, {
        action: "allin",
        amount: allInTotal(ctx),
        reason: `${hand} is strong enough to go all-in against ${aggressor?.name ?? "the raisers"}.`,
        threshold: null,
        detail: ["Top 2.5% of hands facing two or more raises \u2014 all-in."]
      });
    }
    if (inTop(5) && ctx.toCall <= 0.25 * ctx.heroStack) {
      return build(ctx, eq, call(null, "Top 5% of hands and the call is \u2264 25% of your stack."));
    }
    return build(ctx, eq, chartFold());
  }
  function valueThreshold(headsUp, floor, villains) {
    const fairShare = 1 / (Math.max(1, villains) + 1);
    return Math.max(floor, headsUp + (fairShare - 0.5));
  }
  function isDryBoard(board) {
    const suits = board.map(suitOf);
    if (new Set(suits).size < suits.length) return false;
    const ranks = new Set(board.map(rankOf));
    for (let s = -1; s <= 8; s++) {
      let inWindow = 0;
      for (let k = 0; k < 5; k++) if (ranks.has(s + k < 0 ? 12 : s + k)) inWindow++;
      if (inWindow >= 3) return false;
    }
    return true;
  }
  var TRAP_CATEGORIES = ["Trips", "Straight", "Flush", "Full house", "Quads", "Straight flush"];
  function heroMadeTripsPlus(ctx) {
    const { label, category } = describeHand(ctx.heroCards, ctx.board);
    if (!category || !TRAP_CATEGORIES.includes(category)) return false;
    const made = label.split(" + ")[0];
    return made === category || made.startsWith("Set of ");
  }
  function trapTarget(ctx, equity) {
    const only = ctx.villains.length === 1 ? ctx.villains[0] : null;
    if (!only || only.style !== "Aggro" && only.style !== "Maniac") return null;
    if (ctx.street !== "flop" && ctx.street !== "turn") return null;
    if (equity < 0.8 || !isDryBoard(ctx.board) || !heroMadeTripsPlus(ctx)) return null;
    return only;
  }
  var CBET = { bluffAt: 60, noBluffAt: 30 };
  var SIZE_READ_SHIFT = { strong: 0.1, bluffy: -0.05, mixed: 0 };
  function decidePostflop(ctx, eq) {
    const n = ctx.villains.length;
    const equity = eq.equity;
    const depth = depthOf(ctx);
    const band = sprBand(depth.spr);
    const sprText = depth.spr === null ? "" : ` (stack-to-pot ratio ${Number(depth.spr.toFixed(1))})`;
    const bluffOk = (amount) => amount <= tierOf(depth).bluffShare * (depth.stackBB * ctx.bigBlind);
    const bar = (base) => {
      const at = base + band.valueShift;
      return { at, moved: band.valueShift !== 0 && equity >= at !== equity >= base };
    };
    const sprWhy = (moved) => moved ? [band.valueShift < 0 ? `The stack is small next to the pot${sprText}, so a hand this good is worth getting all-in.` : `The stack is big next to the pot${sprText}, so this hand needs to be stronger before putting in more.`] : [];
    const valueAmount = (amount) => band.commit ? allInTotal(ctx) : amount;
    if (ctx.toCall > 0) {
      const potOdds = potOddsOf(ctx);
      const aggressor = ctx.lastAggressor ?? ctx.villains[0] ?? null;
      const style = aggressor?.style ?? "Unknown";
      const name = aggressor?.name ?? "the bettor";
      const base = valueThreshold(style === "Aggro" || style === "Maniac" ? 0.6 : 0.7, 0.5, n);
      const { at: raiseAt, moved } = bar(base);
      const raiseTo = roundAmount(3 * betLevel(ctx));
      if (equity >= raiseAt) {
        return build(ctx, eq, {
          action: "raise",
          amount: valueAmount(raiseTo),
          reason: ctx.heroCheckedThisStreet ? `Check-raise \u2014 the trap worked. Raise ${name} for value.` : valueCopy(name, style),
          threshold: raiseAt,
          detail: [band.commit ? "All-in for value." : "Raise to 3\xD7 the bet for value.", ...sprWhy(moved)]
        });
      }
      const baseCallAt = potOdds + 0.03;
      const sizeRead = ctx.facedBet ? readBetSize(aggressor?.betSizes, ctx.facedBet) : null;
      const callAt = baseCallAt + (sizeRead ? SIZE_READ_SHIFT[sizeRead.kind] : 0);
      const readDetail = sizeRead ? [`${sizeRead.text} (${name}).`] : [];
      if (equity >= callAt) {
        const flipped = sizeRead?.kind === "bluffy" && equity < baseCallAt;
        return build(ctx, eq, {
          action: "call",
          amount: null,
          reason: flipped ? `${name}'s ${BUCKET_WORD[sizeRead.bucket].toLowerCase()} bets are often bluffs (${sizeRead.weak} of ${sizeRead.seen} weak) \u2014 call.` : callCopy(eq, potOdds),
          threshold: callAt,
          detail: readDetail
        });
      }
      if (sizeRead?.kind === "strong" && equity >= baseCallAt) {
        return build(ctx, eq, {
          action: "fold",
          amount: null,
          reason: `${name}'s ${BUCKET_WORD[sizeRead.bucket].toLowerCase()} bets have been strong ${sizeRead.strong} of ${sizeRead.seen} times \u2014 fold.`,
          threshold: callAt,
          detail: readDetail
        });
      }
      const draw = describeHand(ctx.heroCards, ctx.board).draw;
      const folds2 = aggressor?.rates.foldToRaise ?? null;
      if (draw && ctx.street !== "river" && sizeRead?.kind !== "strong" && folds2 !== null && folds2 >= 55 && bluffOk(raiseTo)) {
        return build(ctx, eq, {
          action: "raise",
          amount: raiseTo,
          reason: `${name} folds to raises ${pct4(folds2 / 100)}% \u2014 a small bluff should work.`,
          threshold: callAt,
          detail: [`Semi-bluff with a ${draw}: raise to 3\xD7 the bet.`]
        });
      }
      return build(ctx, eq, { action: "fold", amount: null, reason: foldCopy(eq, potOdds), threshold: callAt, detail: readDetail });
    }
    const target = targetOf(ctx);
    const { at: betAt, moved: betMoved } = bar(valueThreshold(0.6, 0.45, n));
    const trap = equity >= betAt ? trapTarget(ctx, equity) : null;
    if (trap) {
      return build(ctx, eq, {
        action: "check",
        amount: null,
        reason: `Slow-play \u2014 ${trap.name} bets often; check and let them bet into you.`,
        threshold: betAt,
        detail: ["Check now, raise if they bet."]
      });
    }
    if (equity >= betAt) {
      const style = target?.style ?? "Unknown";
      const size = style === "Calling station" ? 0.75 : style === "Rock" ? 0.5 : 0.6;
      return build(ctx, eq, {
        action: "bet",
        amount: valueAmount(roundAmount(size * ctx.pot)),
        reason: valueCopy(target?.name ?? "the field", style),
        threshold: betAt,
        detail: [band.commit ? "Bet all-in." : `Bet ${size}\xD7 the pot${style === "Unknown" ? "" : ` against a ${style}`}.`, ...sprWhy(betMoved)]
      });
    }
    const only = ctx.villains.length === 1 ? ctx.villains[0] : null;
    const folds = only?.rates.foldToRaise ?? null;
    const cbetFolds = ctx.street === "flop" && ctx.heroRaisedPreflop && only ? only.rates.foldToCbet ?? null : null;
    if (equity < 0.35 && only && cbetFolds !== null && cbetFolds >= CBET.bluffAt && bluffOk(roundAmount(0.5 * ctx.pot))) {
      return build(ctx, eq, {
        action: "bet",
        amount: roundAmount(0.5 * ctx.pot),
        reason: `${only.name} folds to flop bets after a raise ${pct4(cbetFolds / 100)}% \u2014 a small bluff should work.`,
        threshold: 0.35,
        detail: ["Bet half the pot, as the player who raised before the flop."]
      });
    }
    const holdsOn = cbetFolds !== null && cbetFolds <= CBET.noBluffAt;
    if (!holdsOn && equity < 0.35 && only && ctx.inPosition && (only.style === "Rock" || only.style === "Tight-Aggressive") && folds !== null && folds >= 55 && bluffOk(roundAmount(0.5 * ctx.pot))) {
      return build(ctx, eq, {
        action: "bet",
        amount: roundAmount(0.5 * ctx.pot),
        reason: `${only.name} folds to raises ${pct4(folds / 100)}% \u2014 a small bluff should work.`,
        threshold: 0.35,
        detail: ["Bluff half the pot."]
      });
    }
    return build(ctx, eq, { action: "check", amount: null, reason: CHECK_COPY, threshold: betAt, detail: [] });
  }
  var SHOWDOWN_WARNING = "If you lose, Torn shows your cards to the table.";
  function legalize(a, ctx) {
    const acts = ctx.legal.actions;
    const has = (x) => acts.includes(x);
    const out = { ...a, detail: [...a.detail] };
    const become = (action) => {
      out.action = action;
      out.amount = null;
      if (action === "check") out.reason = CHECK_COPY;
      else if (action === "call") out.reason = `Raising isn't allowed here \u2014 call.`;
      else out.reason = foldText(a.equity, a.potOdds);
    };
    const passive = () => {
      if (ctx.toCall > 0 && has("call")) become("call");
      else if (has("check")) become("check");
      else become("fold");
    };
    if (out.action === "bet" || out.action === "raise" || out.action === "allin") {
      const kind = has("raise") ? "raise" : has("bet") ? "bet" : has("allin") ? "allin" : null;
      if (!kind) {
        passive();
      } else {
        const [lo, hi] = kind === "raise" ? [ctx.legal.minRaise, ctx.legal.maxRaise] : [ctx.legal.minBet, ctx.legal.maxBet];
        const amount = Math.min(Math.max(out.amount ?? lo, lo), hi);
        const total2 = allInTotal(ctx);
        if (kind === "allin") {
          out.action = "allin";
          out.amount = total2;
        } else if (amount >= 0.9 * total2) {
          out.detail.push(out.action === "allin" ? `${kind === "raise" ? "Raise" : "Bet"} the maximum \u2014 that's all-in.` : "That's most of your stack \u2014 make it the maximum, all-in.");
          out.action = kind;
          out.amount = hi;
        } else {
          out.action = kind;
          out.amount = amount;
        }
      }
    } else if (out.action === "call" && !has("call") && has("allin")) {
      out.action = "allin";
      out.amount = allInTotal(ctx);
      out.detail.push("Calling puts you all-in.");
    } else if (out.action === "check" && !has("check")) {
      become(has("fold") ? "fold" : "call");
    } else if ((out.action === "call" || out.action === "fold") && ctx.toCall === 0 && has("check")) {
      become("check");
    } else if (!has(out.action)) {
      passive();
    }
    const reachesShowdown = out.action === "call" && (ctx.street === "river" || ctx.toCall >= ctx.heroStack) || out.action === "allin" && a.action === "call";
    if (reachesShowdown) out.detail.push(SHOWDOWN_WARNING);
    return out;
  }

  // src/advice/advise.ts
  async function advise(ctx, opts = {}) {
    const preflop = ctx.street === "preflop";
    const run = (ranges2) => equityAsync(ctx.heroCards, ctx.board, ranges2, {
      iterations: preflop ? 3e3 : 5e3,
      rng: opts.rng,
      signal: opts.signal
    });
    let ranges = ctx.villains.map((v) => estimateRange(v, ctx));
    let eq = await run(ranges);
    const fellBack = eq.samples === 0;
    if (fellBack) {
      ranges = ctx.villains.map(() => topPercent(100));
      eq = await run(ranges);
      if (eq.samples === 0) throw new Error("No equity estimate");
    }
    if (!fellBack) opts.onRanges?.(new Map(ctx.villains.map((v, i) => [v.userID, ranges[i]])));
    const decided = preflop ? decidePreflop(ctx, eq) : decidePostflop(ctx, eq);
    const rangeLines = ctx.villains.map((v, i) => {
      const combos = rangePercent(ranges[i]) / 100 * COMBOS;
      return `${v.name} (${v.style}): ~${Math.round(rangePercent(ranges[i]))}% of hands, ${Math.round(combos)} combos`;
    });
    const header = fellBack ? ["Ranges unreadable \u2014 equity vs random hands"] : [];
    return legalize({
      ...decided,
      detail: [...header, ...rangeLines, ...decided.detail],
      strength: handStrength(ctx.heroCards, ctx.board),
      opponents: ctx.villains.length
    }, ctx);
  }

  // src/profiles/showdowns.ts
  var MAX_SHOWDOWNS = 10;
  var isCard = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 52;
  function isShowdown(v) {
    if (v === null || typeof v !== "object") return false;
    const s = v;
    return typeof s.handId === "string" && typeof s.at === "number" && Number.isFinite(s.at) && Array.isArray(s.cards) && s.cards.length === 2 && s.cards.every(isCard) && Array.isArray(s.board) && s.board.every(isCard) && (s.handName === null || typeof s.handName === "string") && typeof s.line === "string";
  }
  var STRENGTH = { fold: 0, check: 1, call: 2, bet: 3, raise: 4, allin: 5 };
  var PHRASE = {
    preflop: {
      fold: "folded before the flop",
      check: "checked before the flop",
      call: "called before the flop",
      bet: "raised before the flop",
      raise: "raised before the flop",
      allin: "went all in before the flop"
    },
    flop: { fold: "folded", check: "checked the flop", call: "called the flop", bet: "bet the flop", raise: "raised the flop", allin: "went all in on the flop" },
    turn: { fold: "folded", check: "checked the turn", call: "called the turn", bet: "bet the turn", raise: "raised the turn", allin: "went all in on the turn" },
    river: { fold: "folded", check: "checked the river", call: "called the river", bet: "bet the river", raise: "raised the river", allin: "went all in on the river" }
  };
  var STREETS4 = ["preflop", "flop", "turn", "river"];
  function describePlay(actions, userID) {
    const parts = [];
    for (const street of STREETS4) {
      let best = null;
      for (const a of actions) {
        if (a.userID !== userID || a.street !== street) continue;
        if (best === null || STRENGTH[a.action] > STRENGTH[best]) best = a.action;
      }
      if (best !== null && best !== "fold") parts.push(PHRASE[street][best]);
    }
    if (parts.length === 0) return "No moves recorded";
    const text = parts.join(", ");
    return text[0].toUpperCase() + text.slice(1);
  }
  function showdownFor(hand, userID) {
    const shown = hand.shown.find((x) => x.userID === userID);
    if (!shown || shown.cards.length !== 2) return null;
    return {
      handId: hand.handId,
      at: hand.endedAt,
      cards: [shown.cards[0], shown.cards[1]],
      board: [...hand.board],
      handName: shown.handName,
      line: describePlay(hand.actions, userID)
    };
  }
  function addShowdown(list, sd) {
    const rest = (list ?? []).filter((x) => sd.handId === "" || x.handId !== sd.handId);
    return [sd, ...rest].slice(0, MAX_SHOWDOWNS);
  }

  // src/profiles/store.ts
  var KEY2 = "profiles";
  var SAVE_DELAY_MS2 = 3e4;
  var MAX_PROFILES = 5e3;
  var MAX_NOTE_LENGTH = 500;
  var VERSION = 4;
  var num2 = (v) => typeof v === "number" && Number.isFinite(v);
  function isCounter(v) {
    if (v === null || typeof v !== "object") return false;
    const c = v;
    return num2(c.n) && num2(c.d);
  }
  function isStats(v) {
    if (v === null || typeof v !== "object") return false;
    const s = v;
    return num2(s.userID) && typeof s.name === "string" && num2(s.hands) && isCounter(s.vpip) && isCounter(s.pfr) && isCounter(s.threeBet) && isCounter(s.foldToRaise) && isCounter(s.wtsd) && num2(s.postAggr) && num2(s.postCalls) && num2(s.lastSeen);
  }
  function cleaned(s) {
    const { note, label, showdowns, betSizes, cbet, foldToCbet, ...core } = s;
    const out = { ...core };
    if (isCounter(cbet)) out.cbet = cbet;
    if (isCounter(foldToCbet)) out.foldToCbet = foldToCbet;
    if (typeof note === "string" && note.trim()) out.note = note.slice(0, MAX_NOTE_LENGTH);
    if (isLabel(label)) out.label = label;
    if (isBetSizes(betSizes)) out.betSizes = betSizes;
    if (Array.isArray(showdowns)) {
      const good = showdowns.filter(isShowdown).slice(0, MAX_SHOWDOWNS);
      if (good.length) out.showdowns = good;
    }
    return out;
  }
  function validProfiles(v) {
    if (v === null || typeof v !== "object") return null;
    const o = v;
    if (o.version !== 1 && o.version !== 2 && o.version !== 3 && o.version !== VERSION || !Array.isArray(o.profiles)) return null;
    return o.profiles.filter(isStats).map(cleaned);
  }
  var ProfileStore = class {
    constructor(store2) {
      this.store = store2;
      let stored;
      try {
        stored = store2.get(KEY2);
      } catch (err) {
        console.warn("[torn-poker] failed to read profiles", err);
      }
      for (const p of validProfiles(stored) ?? []) this.profiles.set(p.userID, p);
      this.prune();
    }
    store;
    profiles = /* @__PURE__ */ new Map();
    timer = null;
    get(userID) {
      return this.profiles.get(userID);
    }
    all() {
      return [...this.profiles.values()];
    }
    record(hand) {
      for (const p of hand.dealtIn) {
        let next = updateStats(this.profiles.get(p.userID), hand, p.userID);
        if (!next) continue;
        const sd = showdownFor(hand, p.userID);
        if (sd) next = { ...next, showdowns: addShowdown(next.showdowns, sd) };
        const sizes = addBetSizes(next.betSizes, hand, p.userID);
        if (sizes) next = { ...next, betSizes: sizes };
        this.profiles.set(p.userID, next);
      }
      this.prune();
      if (this.timer === null) this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS2);
    }
    setNote(userID, name, text) {
      const note = text.trim().slice(0, MAX_NOTE_LENGTH);
      this.edit(userID, name, (p) => {
        const { note: _old, ...rest } = p;
        return note ? { ...rest, note } : rest;
      });
    }
    setLabel(userID, name, label) {
      this.edit(userID, name, (p) => {
        const { label: _old, ...rest } = p;
        return label ? { ...rest, label } : rest;
      });
    }
    edit(userID, name, change) {
      const base = this.profiles.get(userID) ?? freshStats(userID, name);
      this.profiles.set(userID, change(base));
      this.prune();
      this.flush();
    }
    /** Clears the numbers and showdowns; the user's own note and label stay. */
    reset(userID) {
      const old = this.profiles.get(userID);
      this.profiles.delete(userID);
      if (old && (old.note || old.label)) {
        const kept = freshStats(userID, old.name);
        this.profiles.set(userID, { ...kept, ...old.note ? { note: old.note } : {}, ...old.label ? { label: old.label } : {} });
      }
      this.flush();
    }
    resetAll() {
      this.profiles.clear();
      this.flush();
    }
    flush() {
      this.cancelTimer();
      try {
        this.store.set(KEY2, this.snapshot());
      } catch (err) {
        console.warn("[torn-poker] failed to save profiles", err);
      }
    }
    exportJSON() {
      return JSON.stringify(this.snapshot(), null, 2);
    }
    importJSON(text) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("Not a profile export");
      }
      const incoming = validProfiles(parsed);
      if (!incoming) throw new Error("Not a profile export");
      for (const p of incoming) this.profiles.set(p.userID, p);
      this.prune();
      this.flush();
      return incoming.length;
    }
    snapshot() {
      return { version: VERSION, profiles: this.all() };
    }
    /** Keep the MAX_PROFILES most recently seen profiles. */
    prune() {
      if (this.profiles.size <= MAX_PROFILES) return;
      const oldest = this.all().sort((a, b) => a.lastSeen - b.lastSeen);
      for (const p of oldest.slice(0, this.profiles.size - MAX_PROFILES)) this.profiles.delete(p.userID);
    }
    cancelTimer() {
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    }
  };

  // src/recorder/scrub.ts
  var JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
  var SECRET_KEY_RE = /token|secret|passw|jwt|csrf|rfcv|^session(?:id|_id|key)?$|^auth(?:orization|token|_token|key)?$|^sig(?:nature)?$/i;
  var ALREADY_REDACTED_RE = /^<REDACTED(?::[0-9a-f]{8})?>$/;
  var KV_RE = /"([^"\\]*)"(\s*:\s*)("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  var KV_ESC_RE = /\\"([^"\\]*)\\"(\s*:\s*)\\"((?:[^\\]|\\(?!"))*?)\\"/g;
  var redactions = 0;
  function fnv1a(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }
  function tag(value) {
    if (typeof value === "string" && ALREADY_REDACTED_RE.test(value)) return value;
    redactions++;
    const s = typeof value === "string" ? value : String(JSON.stringify(value));
    return `<REDACTED:${fnv1a(s)}>`;
  }
  function decodeJsonString(body, levels) {
    try {
      let s = body;
      for (let i = 0; i < levels; i++) s = JSON.parse(`"${s}"`);
      return s;
    } catch {
      return body;
    }
  }
  function scrubString(s) {
    return s.replace(JWT_RE, (m) => tag(m)).replace(KV_RE, (m, key, sep, raw) => {
      if (!SECRET_KEY_RE.test(key)) return m;
      const value = raw.startsWith('"') ? decodeJsonString(raw.slice(1, -1), 1) : Number(raw);
      return `"${key}"${sep}"${tag(value)}"`;
    }).replace(
      KV_ESC_RE,
      (m, key, sep, raw) => SECRET_KEY_RE.test(key) ? `\\"${key}\\"${sep}\\"${tag(decodeJsonString(raw, 2))}\\"` : m
    );
  }
  function scrubValue(v) {
    if (typeof v === "string") return scrubString(v);
    if (Array.isArray(v)) return v.map(scrubValue);
    if (v !== null && typeof v === "object") {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        out[k] = SECRET_KEY_RE.test(k) ? tag(val) : scrubValue(val);
      }
      return out;
    }
    return v;
  }
  function scrubUnit(text, fallback) {
    const before = redactions;
    let out;
    try {
      out = JSON.stringify(scrubValue(JSON.parse(text)));
    } catch {
      out = fallback(text);
    }
    return redactions === before ? text : out;
  }
  function scrubText(text) {
    try {
      return scrubUnit(text, (t) => t.split("\n").map((line) => scrubUnit(line, scrubString)).join("\n"));
    } catch (err) {
      console.warn("[torn-poker] scrub failed", err);
      return "<REDACTED:scrub-failed>";
    }
  }

  // src/recorder/log.ts
  var KEY3 = "capture-log";
  var SAVE_DELAY_MS3 = 3e4;
  function isEntry(v) {
    if (v === null || typeof v !== "object") return false;
    const e = v;
    return typeof e.t === "number" && Number.isFinite(e.t) && typeof e.data === "string";
  }
  var CaptureLog = class {
    constructor(store2, opts = {}) {
      this.store = store2;
      this.cap = opts.cap ?? 2e4;
      this.maxBytes = opts.maxBytes ?? 15e6;
      let stored;
      try {
        stored = store2.get(KEY3);
      } catch (err) {
        console.warn("[torn-poker] failed to read capture log", err);
      }
      if (Array.isArray(stored)) {
        this.entries = stored.filter(isEntry);
        for (const e of this.entries) this.bytes += e.data.length;
        this.trim();
        this.compact();
      }
    }
    store;
    // Live entries are entries[head..]; dropped ones are compacted away in batches.
    entries = [];
    head = 0;
    bytes = 0;
    cap;
    maxBytes;
    timer = null;
    add(e) {
      const data = scrubText(e.data);
      this.entries.push({ ...e, data });
      this.bytes += data.length;
      this.trim();
      if (this.head > 1024 && this.head * 2 > this.entries.length) this.compact();
      if (this.timer === null) this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS3);
    }
    trim() {
      while (this.count() > 0 && (this.count() > this.cap || this.bytes > this.maxBytes)) {
        this.bytes -= this.entries[this.head].data.length;
        this.head++;
      }
    }
    compact() {
      if (this.head > 0) {
        this.entries = this.entries.slice(this.head);
        this.head = 0;
      }
    }
    flush() {
      this.cancelTimer();
      this.compact();
      try {
        this.store.set(KEY3, this.entries);
      } catch (err) {
        console.warn("[torn-poker] failed to save capture log", err);
      }
    }
    count() {
      return this.entries.length - this.head;
    }
    lastAt() {
      return this.count() ? this.entries[this.entries.length - 1].t : null;
    }
    clear() {
      this.cancelTimer();
      this.entries = [];
      this.head = 0;
      this.bytes = 0;
      try {
        this.store.del(KEY3);
      } catch (err) {
        console.warn("[torn-poker] failed to clear capture log", err);
      }
    }
    exportJSON(meta) {
      const out = {
        version: 1,
        exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
        userID: meta.userID,
        bundle: meta.bundle,
        entries: this.entries.slice(this.head)
      };
      return JSON.stringify(JSON.parse(scrubText(JSON.stringify(out))), null, 2);
    }
    cancelTimer() {
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    }
  };

  // src/table/parse.ts
  var isObj2 = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
  var num3 = (v, d = 0) => {
    const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) ? n : d;
  };
  var str = (v, d = "") => typeof v === "string" ? v : d;
  var cardsOf = (v) => Array.isArray(v) ? v.flatMap((c) => {
    const p = typeof c === "string" ? parseCard(c) : null;
    return p === null ? [] : [p];
  }) : [];
  var ACTIONS2 = ["fold", "check", "call", "bet", "raise", "allin"];
  function parsePlayer(key, p) {
    if (!isObj2(p)) return null;
    const seat = Number(key);
    if (!Number.isInteger(seat) || typeof p.userID === "undefined") return null;
    return {
      userID: num3(p.userID),
      name: str(p.playername),
      seat,
      status: str(p.status),
      money: num3(p.money),
      streetBet: num3(p.pot),
      handBet: num3(p.totalPot),
      amountCall: num3(p.amountCall),
      minBet: num3(p.minBet),
      maxBet: num3(p.maxBet),
      minRaise: num3(p.minRaise),
      maxRaise: num3(p.maxRaise),
      acceptedActions: Array.isArray(p.acceptedActions) ? p.acceptedActions.filter((a) => typeof a === "string") : [],
      isSitOut: p.isSitOut === true,
      isDealer: p.isDealer === true,
      isSmallBlind: p.isSmallBlind === true,
      isBigBlind: p.isBigBlind === true,
      winnings: num3(p.winnings),
      shown: cardsOf(p.hand),
      handName: typeof p.handName === "string" && p.handName !== "" ? p.handName : null,
      canShowCards: Array.isArray(p.showCardsButton) && p.showCardsButton.some((b) => isObj2(b) && b.pressed !== true)
    };
  }
  function parseTable(m) {
    const eventType = m.eventType;
    if (!isObj2(m.players)) return { kind: "unknown", reason: `${eventType}: missing players` };
    if (typeof m.token !== "string") return { kind: "unknown", reason: `${eventType}: missing token` };
    const rm = typeof m.round === "string" ? /^Round ([1-5])$/.exec(m.round) : null;
    if (!rm) return { kind: "unknown", reason: `${eventType}: bad round ${JSON.stringify(m.round)}` };
    const players = [];
    for (const [k, v] of Object.entries(m.players)) {
      const p = parsePlayer(k, v);
      if (!p) return { kind: "unknown", reason: `${eventType}: bad player at seat ${k}` };
      players.push(p);
    }
    const ua = m.userAction;
    return {
      kind: "table",
      msg: {
        eventType,
        handId: m.token,
        tableId: typeof m.table === "undefined" ? null : num3(m.table, NaN) || null,
        ended: m.phase === "ended" || m.gameStatus === "ended",
        round: Number(rm[1]),
        turn: typeof m.turn === "undefined" || m.turn === null ? null : num3(m.turn, NaN) || null,
        dealer: num3(m.dealer),
        board: cardsOf(m.communityCards),
        roundPot: num3(m.roundPot),
        totalPot: num3(m.totalPot),
        bigBlind: num3(m.bigBlind),
        isTournament: m.isTournament === true || m.isTournament === 1,
        userAction: typeof ua === "string" && ACTIONS2.includes(ua) ? ua : null,
        players
      }
    };
  }
  function parseSeat(change, m) {
    const entries = isObj2(m.player) ? Object.entries(m.player) : [];
    const p = entries.length === 1 ? parsePlayer(entries[0][0], entries[0][1]) : null;
    return p ? { kind: "seat", change, player: p } : { kind: "unknown", reason: `${m.eventType}: bad player` };
  }
  function parseMessage(m, privateChannel) {
    if (!isObj2(m) || typeof m.eventType !== "string") return [];
    if (privateChannel) {
      if (m.eventType !== "getState") return [];
      if (typeof m.token !== "string" || m.token === "") return [];
      const cards = cardsOf(m.hand);
      if (cards.length !== 2 || !Array.isArray(m.hand) || m.hand.length !== 2) return [];
      return [{ kind: "holeCards", handId: str(m.token), cards: [cards[0], cards[1]] }];
    }
    switch (m.eventType) {
      case "getState":
      case "playerMakeMove":
        return [parseTable(m)];
      case "playerJoin":
        return [parseSeat("join", m)];
      case "updatePlayer":
        return [parseSeat("update", m)];
      case "removePlayer": {
        const seats = m.player;
        if (!Array.isArray(seats) || !seats.every((x) => typeof x === "number" && Number.isInteger(x))) {
          return [{ kind: "unknown", reason: "removePlayer: bad player list" }];
        }
        return seats.map((seat) => ({ kind: "seatRemoved", seat }));
      }
      case "chat":
        return [];
      default:
        return [{ kind: "unknown", reason: `unknown eventType ${m.eventType}` }];
    }
  }
  function parseLine(line, src) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      return [];
    }
    try {
      if (!isObj2(o)) return [];
      if (src === "http") return isObj2(o.payload) ? parseMessage(o.payload, false) : [];
      if (src === "page") {
        const hole = parseMessage({ eventType: "getState", hand: o.hand, token: o.holeToken }, true);
        return [...hole, ...parseMessage(o, false)];
      }
      const push = o.push;
      if (!isObj2(push) || typeof push.channel !== "string") return [];
      const ch = push.channel;
      if (!ch.startsWith("holdem") || ch.startsWith("holdemlobby")) return [];
      const pub = push.pub;
      const data = isObj2(pub) ? pub.data : void 0;
      return parseMessage(isObj2(data) ? data.message : void 0, ch.includes("#"));
    } catch (e) {
      return [{ kind: "unknown", reason: `parse error: ${String(e)}` }];
    }
  }
  function parseFrame(data, src) {
    return data.split("\n").filter((l) => l.trim() !== "").flatMap((l) => parseLine(l, src));
  }

  // src/advisor/app.ts
  var RECORD_KEY = "settings.record";
  var RECORDING_UI_MS = 1e3;
  var SHOW_CARDS_REMINDER = "Don't press Show cards \u2014 keep them guessing.";
  var warn4 = (what, e) => console.warn(`[torn-poker] ${what}`, e);
  var isAbort = (e) => e instanceof Error && e.name === "AbortError";
  function parseDataExport(text) {
    let x;
    try {
      x = JSON.parse(text);
    } catch {
      throw new Error("Not a data export");
    }
    if (x === null || typeof x !== "object") throw new Error("Not a data export");
    const o = x;
    return { profiles: JSON.stringify(o.profiles ?? null), results: JSON.stringify(o.results ?? null) };
  }
  function scratchStore() {
    const m = /* @__PURE__ */ new Map();
    return { get: (k) => m.get(k), set: (k, v) => void m.set(k, v), del: (k) => void m.delete(k) };
  }
  function createApp(deps) {
    const { store: store2, panel } = deps;
    const profiles = new ProfileStore(store2);
    const results = new Results(store2);
    const capture = new CaptureLog(store2);
    let state = initialState(deps.heroId);
    let status = null;
    let adviceKey = null;
    let controller = null;
    let recordingShownAt = -Infinity;
    let showCardsNotice = false;
    let liveRanges = null;
    const recording = () => {
      try {
        return store2.get(RECORD_KEY) === true;
      } catch {
        return false;
      }
    };
    const setStatus = (s) => {
      if (s === status && s !== "thinking") return;
      status = s;
      panel.setStatus(s);
    };
    const showResults = () => panel.showResults(results.summary(deps.now()), profiles.get(state.heroId));
    const renderCards = () => {
      deps.renderCards(
        state.seats.filter((q) => q.userID !== state.heroId).map((q) => ({
          userID: q.userID,
          name: q.name,
          stats: profiles.get(q.userID),
          liveRange: liveRanges?.handId === state.handId ? liveRanges.ranges.get(q.userID) : void 0,
          onNote: guard2("save note", (text) => {
            profiles.setNote(q.userID, q.name, text);
            renderCards();
          }),
          onLabel: guard2("save label", (label) => {
            profiles.setLabel(q.userID, q.name, label);
            renderCards();
          })
        }))
      );
    };
    const betRangeOf = (ctx) => {
      const setBet = deps.setBet;
      if (!setBet) return null;
      const { legal } = ctx;
      const kind = legal.actions.includes("raise") ? "raise" : legal.actions.includes("bet") ? "bet" : null;
      if (!kind) return null;
      const [min, max] = kind === "raise" ? [legal.minRaise, legal.maxRaise] : [legal.minBet, legal.maxBet];
      if (!(max > 0) || max < min) return null;
      return {
        kind,
        min,
        max,
        pot: ctx.pot,
        toCall: ctx.toCall,
        streetBet: ctx.heroStreetBet,
        bigBlind: ctx.bigBlind,
        onChange: (amount) => setBet(amount, ctx.bigBlind)
      };
    };
    const cancelAdvice = () => {
      controller?.abort();
      controller = null;
      liveRanges = null;
      adviceKey = null;
    };
    const startAdvice = (key, preview = false) => {
      controller?.abort();
      controller = null;
      adviceKey = key;
      let ctx;
      try {
        ctx = preview ? buildPreviewContext(state, profiles) : buildContext(state, profiles);
      } catch (e) {
        setStatus("unreadable");
        warn4("advice context failed", e);
        return;
      }
      if (!ctx) {
        setStatus("waiting");
        return;
      }
      const ac = new AbortController();
      controller = ac;
      if (!preview) panel.showReview?.(null);
      const handId = state.handId ?? "";
      const street = state.street;
      if (!preview || status !== "advice") setStatus("thinking");
      const onRanges = (ranges) => {
        if (controller !== ac) return;
        liveRanges = { handId, ranges };
        renderCards();
      };
      advise(ctx, { signal: ac.signal, rng: deps.rng, onRanges }).then(
        (advice) => {
          if (controller !== ac) return;
          controller = null;
          try {
            status = "advice";
            const bet = preview ? null : betRangeOf(ctx);
            panel.showAdvice(advice, preview ? { preview: true } : bet ? { bet } : void 0);
          } catch (e) {
            setStatus("unreadable");
            warn4("show advice failed", e);
            return;
          }
          if (preview) return;
          try {
            results.recordAdvice(handId, street, advice);
          } catch (e) {
            warn4("record advice failed", e);
          }
        },
        (e) => {
          if (isAbort(e) || controller !== ac) return;
          controller = null;
          setStatus("unreadable");
          warn4("advice failed", e);
        }
      );
    };
    const updateStatus = () => {
      if (!state.readable) {
        cancelAdvice();
        setStatus("unreadable");
      } else if (state.isTournament) {
        cancelAdvice();
        setStatus("tournament");
      } else if (!state.seats.some((q) => q.userID === state.heroId)) {
        cancelAdvice();
        setStatus("not-seated");
      } else if (isHeroTurn(state) && !state.heroCards) {
        cancelAdvice();
        setStatus("no-cards");
      } else if (isHeroTurn(state) && state.heroLegal) {
        const key = `${state.handId}|${state.street}|${state.heroLegal.toCall}|${state.actions.length}`;
        if (key !== adviceKey) startAdvice(key);
      } else if (projectedLegal(state)) {
        const legal = projectedLegal(state);
        const key = `preview|${state.handId}|${state.street}|${legal.toCall}|${state.actions.length}|${state.board.length}`;
        if (key !== adviceKey) startAdvice(key, true);
      } else {
        cancelAdvice();
        setStatus("waiting");
      }
    };
    const showRecording = (force) => {
      const t = deps.now();
      if (!force && t - recordingShownAt < RECORDING_UI_MS) return;
      recordingShownAt = t;
      panel.setRecording(recording(), capture.count());
    };
    const onFrame = (f) => {
      try {
        if (recording()) {
          capture.add({ ...f, t: deps.now() });
          showRecording(false);
        }
        const events = parseFrame(f.data, f.src);
        if (events.length === 0) return;
        for (const ev of events) {
          const r = reduce(state, ev, deps.now());
          state = r.state;
          if (r.finished) {
            profiles.record(r.finished);
            const recorded = state.isTournament ? null : results.recordHand(r.finished);
            showResults();
            if (recorded) panel.showReview?.(buildReview(recorded));
          }
        }
        renderCards();
        updateStatus();
        if (state.heroCanShowCards !== showCardsNotice) {
          showCardsNotice = state.heroCanShowCards;
          panel.reminder?.(showCardsNotice ? SHOW_CARDS_REMINDER : "");
        }
      } catch (e) {
        warn4("frame handling failed", e);
      }
    };
    const guard2 = (what, fn) => (...args) => {
      try {
        fn(...args);
      } catch (e) {
        warn4(`${what} failed`, e);
      }
    };
    const stamp = () => new Date(deps.now()).toISOString();
    const settings2 = {
      onExportData: guard2("export data", () => {
        const data = {
          version: 1,
          profiles: JSON.parse(profiles.exportJSON()),
          results: JSON.parse(results.exportJSON())
        };
        deps.download(`torn-poker-data-${stamp()}.json`, JSON.stringify(data, null, 2));
      }),
      onImportData: guard2("import data", (text) => {
        let counts2;
        try {
          const x = parseDataExport(text);
          new ProfileStore(scratchStore()).importJSON(x.profiles);
          new Results(scratchStore()).importJSON(x.results);
          counts2 = { profiles: profiles.importJSON(x.profiles), hands: results.importJSON(x.results) };
        } catch (e) {
          panel.notice?.(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
          warn4("import failed", e);
          return;
        }
        panel.notice?.(`Imported ${counts2.profiles} profiles, ${counts2.hands} hands.`);
        showResults();
        renderCards();
      }),
      onResetProfiles: guard2("reset profiles", () => {
        profiles.resetAll();
        showResults();
        renderCards();
      }),
      onToggleRecording: guard2("toggle recording", (on) => {
        store2.set(RECORD_KEY, on);
        showRecording(true);
      }),
      onExportCapture: guard2("export capture", () => {
        deps.download(`torn-poker-capture-${stamp()}.json`, capture.exportJSON(deps.captureMeta()));
      })
    };
    const app2 = {
      onFrame,
      flush: guard2("flush", () => {
        profiles.flush();
        results.flush();
        capture.flush();
      }),
      settings: settings2,
      resetProfile: guard2("reset profile", (userID) => {
        profiles.reset(userID);
        showResults();
        renderCards();
      })
    };
    try {
      showResults();
      showRecording(true);
    } catch (e) {
      warn4("app start failed", e);
    }
    return app2;
  }

  // src/advisor/boot.ts
  var MAX_BUFFER = 2e3;
  var HERO_WAIT_MS = 1e4;
  var warn5 = (what, e) => console.warn(`[torn-poker] ${what}`, e);
  function createBoot(deps) {
    let app2 = null;
    let panel = null;
    let heroId = null;
    let failed = false;
    let readyAt = null;
    let retryQueued = false;
    const buffer = [];
    const tryStart = () => {
      if (app2 || failed || !panel) return;
      heroId ??= deps.readHeroId();
      if (heroId === null) {
        if (!deps.domReady()) return;
        readyAt ??= deps.now();
        if (deps.now() - readyAt < HERO_WAIT_MS) {
          if (!retryQueued) {
            retryQueued = true;
            deps.nextFrame(retry);
          }
          return;
        }
      }
      try {
        app2 = deps.start(heroId ?? -1, panel);
      } catch (e) {
        failed = true;
        buffer.length = 0;
        warn5("advisor start failed", e);
        return;
      }
      for (const f of buffer.splice(0)) app2.onFrame(f);
    };
    function retry() {
      retryQueued = false;
      try {
        tryStart();
      } catch (e) {
        warn5("hero retry failed", e);
      }
    }
    return {
      onFrame(f) {
        try {
          if (app2) {
            app2.onFrame(f);
            return;
          }
          if (failed) return;
          buffer.push(f);
          if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
          tryStart();
        } catch (e) {
          warn5("frame failed", e);
        }
      },
      panelReady(p) {
        panel = p;
        tryStart();
      },
      app: () => app2
    };
  }

  // src/advisor/main.ts
  console.info("[torn-poker] advisor loaded");
  var warn6 = (what, e) => console.warn(`[torn-poker] ${what}`, e);
  var store = {
    get: (k) => GM_getValue(k),
    set: (k, v) => GM_setValue(k, v),
    del: (k) => GM_deleteValue(k)
  };
  function readUserID() {
    try {
      const el2 = document.getElementById("torn-user");
      if (!el2) return null;
      const id = Number(JSON.parse(el2.value)?.id);
      return Number.isInteger(id) && id > 0 ? id : null;
    } catch {
      return null;
    }
  }
  function readBundle() {
    const s = [...document.scripts].find((x) => /\/builds\/holdem\/app\./.test(x.src));
    return s ? s.src : null;
  }
  function download(filename, text) {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1e3);
  }
  var boot = createBoot({
    readHeroId: readUserID,
    domReady: () => document.readyState !== "loading",
    now: Date.now,
    nextFrame: (cb) => void requestAnimationFrame(cb),
    start: (heroId, panel) => {
      const app2 = createApp({
        store,
        heroId,
        now: Date.now,
        panel,
        renderCards: (players) => renderProfileCards(document, players, { onReset: (id) => app2.resetProfile(id) }),
        download,
        captureMeta: () => ({ userID: heroId > 0 ? String(heroId) : null, bundle: readBundle() }),
        setBet: (amount, bigBlind) => setTornBet(document, amount, bigBlind)
      });
      return app2;
    }
  });
  var app = () => boot.app();
  watchPage(unsafeWindow.document, boot.onFrame);
  var settings = {
    onExportData: () => app()?.settings.onExportData(),
    onImportData: (text) => app()?.settings.onImportData(text),
    onResetProfiles: () => app()?.settings.onResetProfiles(),
    onToggleRecording: (on) => app()?.settings.onToggleRecording(on),
    onExportCapture: () => app()?.settings.onExportCapture()
  };
  function mount() {
    try {
      const panel = mountPanel(document, settings);
      boot.panelReady(withTornHud(panel, mountTornHud(document, panel)));
    } catch (e) {
      warn6("panel mount failed", e);
    }
  }
  if (document.readyState !== "loading") mount();
  else document.addEventListener("DOMContentLoaded", mount);
  window.addEventListener("pagehide", () => {
    try {
      app()?.flush();
    } catch (e) {
      warn6("flush failed", e);
    }
  });
})();
