/* global DurakEngine, io */
(function () {
  const E = typeof DurakEngine !== 'undefined' ? DurakEngine : null;
  if (!E) {
    console.error('DurakEngine fehlt');
    return;
  }

  document.body.classList.add('splash-active');

  const $ = (id) => document.getElementById(id);
  const appRoot = document.getElementById('app');
  const screens = { menu: $('screen-menu'), lobby: $('screen-lobby'), game: $('screen-game') };

  let mode = 'menu';
  let socket = null;
  let localState = null;
  let selected = new Set();
  let defendOrder = [];
  let mySlotOnline = 0;
  let aiTimer = null;
  let aiTurnKey = '';
  let aiTurnEndsAt = 0;
  let turnAnimRaf = null;
  /** Debounce für automatischen Angriff / Nachlegen (mehrere Karten gleichen Rangs) */
  let autoCommitTimer = null;
  const AUTO_ATTACK_MS = 420;

  const TURN_MS = 15000;
  /** KI „denkt“ zufällig lange vor jedem Zug (ms) */
  const AI_THINK_MIN_MS = 2000;
  const AI_THINK_MAX_MS = 4000;
  const RING_C = 270.177;

  function randomAiThinkMs() {
    return AI_THINK_MIN_MS + Math.floor(Math.random() * (AI_THINK_MAX_MS - AI_THINK_MIN_MS + 1));
  }
  /** Farbe Pik → Herz (Reihenfolge links in der Hand) */
  const SUIT_ORDER = { '♠': 0, '♣': 1, '♥': 2, '♦': 3 };
  const SUIT_LABEL = {
    '♠': 'Pik',
    '♣': 'Kreuz',
    '♥': 'Herz',
    '♦': 'Karo',
  };

  function showScreen(name) {
    if (appRoot) appRoot.classList.toggle('app--game', name === 'game');
    screens.menu.classList.toggle('hidden', name !== 'menu');
    screens.lobby.classList.toggle('hidden', name !== 'lobby');
    screens.game.classList.toggle('hidden', name !== 'game');
    if (name === 'game') {
      screens.game.classList.remove('screen-enter');
      requestAnimationFrame(() => {
        screens.game.classList.add('screen-enter');
      });
    }
  }

  const BTN_PRIMARY =
    'btn-primary touch-manipulation rounded-2xl px-5 py-3 font-display text-sm font-bold text-felt sm:px-8 sm:py-3.5 sm:text-base md:px-10 md:py-4 md:text-lg';
  const BTN_GHOST =
    'btn-ghost touch-manipulation rounded-2xl border border-white/20 bg-white/[0.06] px-5 py-3 font-display text-sm font-semibold text-white hover:bg-white/10 sm:px-6 sm:py-3.5 sm:text-base md:px-8 md:py-4';
  const BTN_DANGER =
    'btn-ghost touch-manipulation rounded-2xl bg-rose-600/90 px-5 py-3 font-display text-sm font-semibold text-white shadow-lg shadow-rose-900/30 hover:bg-rose-500 sm:px-6 sm:py-3.5 sm:text-base md:px-8 md:py-4';
  function turnTimerKeyFromSnap(snap) {
    if (!snap || snap.winnerIndex !== null) return '';
    const undef = snap.table ? snap.table.filter((r) => !r[1]).length : 0;
    return [snap.phase, snap.attackerIndex, snap.defenderIndex, snap.table.length, undef, snap.deckCount].join('|');
  }

  function clearAutoCommitTimer() {
    if (autoCommitTimer) {
      clearTimeout(autoCommitTimer);
      autoCommitTimer = null;
    }
  }

  function scheduleAutoCommitAttackToss() {
    clearAutoCommitTimer();
    const snapRef =
      mode === 'ai' && localState
        ? `ai|${localState.phase}|${localState.attackerIndex}|${localState.table.length}|${localState.defenderIndex}`
        : mode === 'online' && window.__lastOnlineSnap
          ? (() => {
              const s = window.__lastOnlineSnap;
              return `on|${s.phase}|${s.attackerIndex}|${s.table.length}|${s.defenderIndex}|${s.myIndex}`;
            })()
          : '';
    autoCommitTimer = setTimeout(() => {
      autoCommitTimer = null;
      if (mode === 'ai' && localState) {
        const cur = localState;
        const curKey = `ai|${cur.phase}|${cur.attackerIndex}|${cur.table.length}|${cur.defenderIndex}`;
        if (curKey !== snapRef) return;
        if (cur.phase !== 'attack' && cur.phase !== 'toss') return;
        if (cur.attackerIndex !== 0) return;
        const ids = [...selected];
        if (ids.length === 0) return;
        doAttack(ids);
      } else if (mode === 'online' && socket && window.__lastOnlineSnap) {
        const cur = window.__lastOnlineSnap;
        const curKey = `on|${cur.phase}|${cur.attackerIndex}|${cur.table.length}|${cur.defenderIndex}|${cur.myIndex}`;
        if (curKey !== snapRef) return;
        if (cur.phase !== 'attack' && cur.phase !== 'toss') return;
        if (cur.attackerIndex !== cur.myIndex) return;
        const ids = [...selected];
        if (ids.length === 0) return;
        doAttack(ids);
      }
    }, AUTO_ATTACK_MS);
  }

  function tryAutoDefendAi() {
    if (mode !== 'ai' || !localState) return;
    if (localState.phase !== 'defend' || localState.defenderIndex !== 0) return;
    const need = localState.table.filter((r) => !r[1]).length;
    if (need === 0 || need !== defendOrder.length) return;
    doDefend([...defendOrder]);
  }

  function tryAutoDefendOnline() {
    if (!socket || !window.__lastOnlineSnap) return;
    const cur = window.__lastOnlineSnap;
    if (cur.phase !== 'defend' || cur.defenderIndex !== cur.myIndex) return;
    const need = cur.table.filter((r) => !r[1]).length;
    if (need === 0 || need !== defendOrder.length) return;
    doDefend([...defendOrder]);
  }

  function sortHandDisplay(hand, trumpSuit) {
    return hand.slice().sort((a, b) => {
      const at = a.suit === trumpSuit ? 1 : 0;
      const bt = b.suit === trumpSuit ? 1 : 0;
      if (at !== bt) return at - bt;
      if (at === 0) {
        const so = (SUIT_ORDER[a.suit] ?? 0) - (SUIT_ORDER[b.suit] ?? 0);
        if (so !== 0) return so;
      }
      return E.RANK_VALUE[a.rank] - E.RANK_VALUE[b.rank];
    });
  }

  function enrichAiSnapWithDeadline(baseSnap) {
    if (!baseSnap) return baseSnap;
    if (baseSnap.winnerIndex !== null) {
      aiTurnKey = '';
      return baseSnap;
    }
    const nk = turnTimerKeyFromSnap(baseSnap);
    if (nk !== aiTurnKey) {
      aiTurnKey = nk;
      aiTurnEndsAt = Date.now() + TURN_MS;
    }
    return { ...baseSnap, turnEndsAt: aiTurnEndsAt };
  }

  function stopTurnVisualizer() {
    if (turnAnimRaf) cancelAnimationFrame(turnAnimRaf);
    turnAnimRaf = null;
  }

  function resetTurnRingsIdle() {
    const ringOpp = $('turn-ring-opp');
    const ringMe = $('turn-ring-me');
    const wrapOpp = $('turn-wrap-opp');
    const wrapMe = $('turn-wrap-me');
    if (!ringOpp || !ringMe || !wrapOpp || !wrapMe) return;
    ringOpp.style.strokeDashoffset = String(RING_C);
    ringMe.style.strokeDashoffset = String(RING_C);
    ringOpp.style.stroke = 'rgba(148, 163, 184, 0.35)';
    ringMe.style.stroke = 'rgba(148, 163, 184, 0.35)';
    wrapOpp.classList.remove('turn-slot-active');
    wrapMe.classList.remove('turn-slot-active');
    wrapOpp.classList.remove('scale-105', 'opacity-100');
    wrapMe.classList.remove('scale-105', 'opacity-100');
    wrapOpp.classList.add('opacity-60');
    wrapMe.classList.add('opacity-60');
    const so = $('turn-sec-opp');
    const sm = $('turn-sec-me');
    if (so) so.textContent = '';
    if (sm) sm.textContent = '';
  }

  function updateTrumpPanel(snap) {
    const nameEl = $('trump-suit-name');
    const symEl = $('trump-display');
    const pinEl = $('trump-card-pin');
    if (!snap || !nameEl || !symEl) return;
    const s = snap.trumpSuit;
    symEl.textContent = s || '—';
    nameEl.textContent = SUIT_LABEL[s] || 'Trumpffarbe';

    let rankGuess = '';
    if (snap.trumpCardId && s && typeof snap.trumpCardId === 'string' && snap.trumpCardId.endsWith(s)) {
      rankGuess = snap.trumpCardId.slice(0, -s.length);
    }
    const redTrump = s === '♥' || s === '♦';

    if (pinEl && rankGuess) {
      pinEl.classList.remove('hidden');
      pinEl.innerHTML =
        '<div class="card-face mx-auto flex h-[3.55rem] w-[2.5rem] flex-col justify-between rounded-md border border-amber-200/40 p-1 text-[10px] shadow-card sm:h-[3.75rem] sm:w-[2.65rem]" data-trump-mini>' +
        '<span class="' +
        (redTrump ? 'text-rose-500' : 'text-slate-800') +
        ' font-bold leading-none">' +
        rankGuess +
        '</span><span class="text-center text-lg leading-none ' +
        (redTrump ? 'text-rose-500' : 'text-slate-800') +
        '">' +
        s +
        '</span><span></span></div>' +
        '<p class="mt-1 text-center text-[10px] text-white/55">Ausgeteilt: unterste Karte im Nachziehstapel legt Trumpf fest</p>';
    } else if (pinEl) {
      pinEl.classList.add('hidden');
      pinEl.innerHTML = '';
    }
  }

  function syncTurnAvatarLabels() {
    const oppTxt = $('turn-avatar-opp');
    const lbl = $('turn-label-opp');
    if (!oppTxt) return;
    if (mode === 'online') oppTxt.textContent = 'P2';
    else oppTxt.textContent = 'KI';
    if (lbl) lbl.textContent = mode === 'online' ? 'Mitspieler' : 'Gegner';
  }

  function restartTurnVisualizer(snap) {
    stopTurnVisualizer();

    syncTurnAvatarLabels();

    if (!snap || snap.winnerIndex !== null || snap.activePlayerIndex == null || snap.turnEndsAt == null) {
      resetTurnRingsIdle();
      return;
    }

    const deadline = snap.turnEndsAt;

    function tick() {
      const ends = deadline;
      if (!ends) {
        resetTurnRingsIdle();
        return;
      }
      const left = Math.max(0, ends - Date.now());
      const ratio = Math.min(1, left / TURN_MS);
      const myIdx = snap.myIndex;
      const active = snap.activePlayerIndex;
      const oppActive = active === 1 - myIdx;
      const meActive = active === myIdx;
      const ringOpp = $('turn-ring-opp');
      const ringMe = $('turn-ring-me');
      const wrapOpp = $('turn-wrap-opp');
      const wrapMe = $('turn-wrap-me');
      const secOpp = $('turn-sec-opp');
      const secMe = $('turn-sec-me');
      const hue = Math.max(0, Math.min(120, ratio * 120));
      const lumPct = ratio > 0.35 ? 52 : 48;
      const strokeCol = `hsl(${hue} 92% ${lumPct}%)`;

      if (wrapOpp && wrapMe) {
        wrapOpp.classList.toggle('opacity-60', !oppActive);
        wrapMe.classList.toggle('opacity-60', !meActive);
        wrapOpp.classList.toggle('scale-105', oppActive);
        wrapMe.classList.toggle('scale-105', meActive);
        wrapOpp.classList.toggle('turn-slot-active', oppActive);
        wrapMe.classList.toggle('turn-slot-active', meActive);
      }

      if (ringOpp && ringMe) {
        ringOpp.style.strokeDashoffset = oppActive ? String(RING_C * (1 - ratio)) : String(RING_C);
        ringMe.style.strokeDashoffset = meActive ? String(RING_C * (1 - ratio)) : String(RING_C);
        ringOpp.style.stroke = oppActive ? strokeCol : 'rgba(100,116,139,0.35)';
        ringMe.style.stroke = meActive ? strokeCol : 'rgba(100,116,139,0.35)';
      }
      const secShown = Math.max(1, Math.ceil(left / 1000));
      if (secOpp) secOpp.textContent = oppActive ? secShown + 's' : '';
      if (secMe) secMe.textContent = meActive ? secShown + 's' : '';

      if (left <= 0) {
        stopTurnVisualizer();
        if (mode === 'ai' && localState) {
          const ap = E.activePlayerIndex(localState);
          if (ap != null && localState.winnerIndex === null) {
            const r = E.applyTurnTimeout(localState, ap);
            if (r.ok) {
              selected.clear();
              defendOrder = [];
              clearAiTimer();
              renderGame();
              maybeScheduleAi();
            }
          }
        }
        return;
      }
      turnAnimRaf = requestAnimationFrame(tick);
    }
    turnAnimRaf = requestAnimationFrame(tick);
  }

  function cardClass(c) {
    const red = c.suit === '♥' || c.suit === '♦';
    return (
      'card card-face relative flex h-[7.25rem] w-[4.85rem] shrink-0 cursor-pointer select-none flex-col justify-between rounded-xl border border-slate-200/80 p-2 text-sm shadow-card sm:h-[8.25rem] sm:w-[5.65rem] sm:p-2.5 sm:text-base md:h-[9rem] md:w-24 ' +
      (red ? 'card-red' : 'card-black')
    );
  }

  function renderCardMini(c, trumpSuit, extraClass) {
    const red = c.suit === '♥' || c.suit === '♦';
    const trump = c.suit === trumpSuit;
    const el = document.createElement('div');
    el.className =
      'card-face flex h-[5.5rem] w-[3.85rem] flex-col justify-between rounded-lg border border-slate-200/70 p-1.5 text-xs shadow-card sm:h-24 sm:w-[4.65rem] sm:rounded-xl sm:p-2 sm:text-sm md:h-[6.5rem] md:w-[4.5rem] ' +
      (red ? 'card-red' : 'card-black') +
      (trump ? ' card-trump' : '') +
      (extraClass ? ' ' + extraClass : '');
    el.innerHTML = `<span class="font-bold leading-none">${c.rank}</span><span class="text-center text-xl leading-none sm:text-2xl">${c.suit}</span><span></span>`;
    return el;
  }

  function renderOpponentBacks(count) {
    const host = $('opponent-backs');
    if (!host) return;
    host.innerHTML = '';
    const n = Math.min(Math.max(0, count), 10);
    for (let i = 0; i < n; i++) {
      const d = document.createElement('div');
      d.className =
        'card-back relative h-14 w-10 shrink-0 rounded-md sm:h-[4.25rem] sm:w-[3.25rem] md:h-[4.75rem] md:w-[3.5rem]';
      d.style.marginLeft = i ? '-1.35rem' : '0';
      d.style.zIndex = String(n - i);
      d.style.setProperty('--rot', (i % 2 === 0 ? -1 : 1) * (1.5 + i * 0.2) + 'deg');
      d.style.animation = 'card-deal 0.45s var(--ease-out-expo, cubic-bezier(0.16,1,0.3,1)) both';
      d.style.animationDelay = i * 45 + 'ms';
      host.appendChild(d);
    }
  }

  function clearAiTimer() {
    if (aiTimer) {
      clearTimeout(aiTimer);
      aiTimer = null;
    }
  }

  function scheduleAi(delay) {
    clearAiTimer();
    aiTimer = setTimeout(runAiTurn, delay);
  }

  function rankVal(r) {
    return E.RANK_VALUE[r];
  }

  function aiChooseAttack(state) {
    const hand = state.hands[1];
    const trump = state.trumpSuit;
    if (state.phase === 'attack') {
      const byRank = {};
      for (const c of hand) {
        if (!byRank[c.rank]) byRank[c.rank] = [];
        byRank[c.rank].push(c);
      }
      let best = null;
      for (const r of E.RANKS) {
        const arr = byRank[r];
        if (!arr || !arr.length) continue;
        const nonT = arr.filter((c) => c.suit !== trump);
        const use = nonT.length ? [nonT[0]] : [arr[0]];
        const score = use[0].suit === trump ? 100 + rankVal(r) : rankVal(r);
        if (!best || score < best.score) best = { ids: use.map((c) => c.id), score };
        if (arr.length >= 2) {
          const pair = arr.slice(0, 2);
          const pr = rankVal(r) + (pair.every((c) => c.suit !== trump) ? 0 : 50);
          if (!best || pr < best.score) best = { ids: pair.map((c) => c.id), score: pr };
        }
      }
      return best ? best.ids : [hand[0].id];
    }
    if (state.phase === 'toss') {
      const allowed = E.ranksOnTable(state.table);
      const candidates = hand.filter((c) => allowed.has(c.rank));
      if (!candidates.length) return null;
      candidates.sort((a, b) => rankVal(a.rank) - rankVal(b.rank) || (a.suit === trump ? 1 : 0) - (b.suit === trump ? 1 : 0));
      return [candidates[0].id];
    }
    return null;
  }

  function aiChooseDefend(state) {
    const hand = state.hands[1];
    const trump = state.trumpSuit;
    const undef = state.table.filter((r) => !r[1]).map((r) => r[0]);
    const used = new Set();
    const picks = [];
    for (const a of undef) {
      let best = null;
      for (const c of hand) {
        if (used.has(c.id)) continue;
        if (!E.beats(a, c, trump)) continue;
        const waste = rankVal(c.rank) + (c.suit === trump ? 0.3 : 0);
        if (best == null || waste < best.waste) best = { c, waste };
      }
      if (!best) return null;
      picks.push(best.c.id);
      used.add(best.c.id);
    }
    return picks;
  }

  function maybeScheduleAi() {
    if (mode !== 'ai' || !localState || localState.winnerIndex !== null) return;
    const st = localState;
    if (st.phase === 'defend' && st.defenderIndex === 1) scheduleAi(randomAiThinkMs());
    else if ((st.phase === 'attack' || st.phase === 'toss') && st.attackerIndex === 1) scheduleAi(randomAiThinkMs());
  }

  function runAiTurn() {
    aiTimer = null;
    if (mode !== 'ai' || !localState || localState.winnerIndex !== null) return;
    const st = localState;

    if (st.phase === 'defend' && st.defenderIndex === 1) {
      const picks = aiChooseDefend(st);
      if (picks) {
        const r = E.defend(st, picks, 1);
        if (!r.ok) E.defenderTake(st, 1);
      } else E.defenderTake(st, 1);
      renderGame();
      maybeScheduleAi();
      return;
    }

    if ((st.phase === 'attack' || st.phase === 'toss') && st.attackerIndex === 1) {
      if (st.phase === 'toss') {
        const add = aiChooseAttack(st);
        if (add && add.length) {
          const r = E.attack(st, add, 1);
          if (!r.ok) E.attackerPass(st, 1);
        } else E.attackerPass(st, 1);
      } else {
        const ids = aiChooseAttack(st);
        E.attack(st, ids, 1);
      }
      renderGame();
      maybeScheduleAi();
    }
  }

  function renderTable(snap) {
    const root = $('table-rows');
    root.innerHTML = '';
    if (!snap || !snap.table.length) {
      const empty = document.createElement('p');
      empty.className =
        'w-full py-6 text-center text-xs font-medium text-white/35 sm:py-10 sm:text-sm md:py-16 md:text-base';
      empty.textContent = 'Warte auf den ersten Angriff …';
      root.appendChild(empty);
      return;
    }
    snap.table.forEach((row, i) => {
      const pair = document.createElement('div');
      pair.className = 'anim-table-pair flex items-end gap-1.5 sm:gap-2';
      pair.style.setProperty('--i', String(i));
      pair.appendChild(renderCardMini(row[0], snap.trumpSuit));
      if (row[1]) {
        const vs = document.createElement('span');
        vs.className = 'pb-8 text-xs font-medium text-white/30 sm:pb-10';
        vs.textContent = '↯';
        pair.appendChild(vs);
        pair.appendChild(renderCardMini(row[1], snap.trumpSuit));
      } else {
        const hole = document.createElement('div');
        hole.className =
          'flex h-[5.5rem] w-[3.85rem] items-center justify-center rounded-lg border-2 border-dashed border-gold/35 bg-black/20 text-sm font-medium text-gold/50 shadow-inner sm:h-24 sm:w-[4.65rem] md:h-[6.5rem] md:w-[4.5rem]';
        hole.textContent = '?';
        pair.appendChild(hole);
      }
      root.appendChild(pair);
    });
  }

  function renderHand(snap) {
    const root = $('hand');
    root.innerHTML = '';
    if (!snap) return;
    const trump = snap.trumpSuit;
    const phase = snap.phase;
    const myAtt = snap.attackerIndex === snap.myIndex;
    const myDef = snap.defenderIndex === snap.myIndex;

    const sorted = sortHandDisplay(snap.myHand, trump);
    sorted.forEach((c, i) => {
      const el = document.createElement('button');
      el.type = 'button';
      const picked = selected.has(c.id);
      const ord = defendOrder.indexOf(c.id);
      el.style.setProperty('--i', String(i));
      el.style.setProperty('--rot', (i % 5) * 0.8 - 1.6 + 'deg');
      el.className =
        'anim-hand-card ' +
        cardClass(c) +
        (c.suit === trump ? ' card-trump-hand' : '') +
        (picked ? ' card-pick' : '');
      el.innerHTML = `<span class="font-bold">${c.rank}</span><span class="text-center text-3xl leading-none sm:text-4xl">${c.suit}</span><span class="min-h-[14px] text-center text-[11px] font-semibold text-slate-500">${picked && phase === 'defend' && myDef ? ord + 1 : ''}</span>`;
      el.addEventListener('click', () => onCardClick(c.id, snap));
      root.appendChild(el);
    });
  }

  function onCardClick(cardId, snap) {
    const phase = snap.phase;
    const myAtt = snap.attackerIndex === snap.myIndex;
    const myDef = snap.defenderIndex === snap.myIndex;

    if (mode === 'ai' && localState) {
      if (phase === 'attack' && myAtt) {
        if (selected.has(cardId)) selected.delete(cardId);
        else selected.add(cardId);
        pruneAttackSelection();
        renderGame();
        scheduleAutoCommitAttackToss();
        return;
      }
      if (phase === 'toss' && myAtt) {
        if (selected.has(cardId)) selected.delete(cardId);
        else selected.add(cardId);
        renderGame();
        scheduleAutoCommitAttackToss();
        return;
      }
      if (phase === 'defend' && myDef) {
        const idx = defendOrder.indexOf(cardId);
        if (idx >= 0) defendOrder.splice(idx, 1);
        else defendOrder.push(cardId);
        syncDefendSelectionFromOrder();
        renderGame();
        tryAutoDefendAi();
        return;
      }
    }
  }

  function pruneAttackSelection() {
    if (!localState || localState.phase !== 'attack') return;
    const ids = [...selected];
    if (ids.length <= 1) return;
    const cards = ids.map((id) => localState.hands[0].find((c) => c.id === id)).filter(Boolean);
    const r0 = cards[0]?.rank;
    for (const c of cards) if (c.rank !== r0) selected.delete(c.id);
  }

  function syncDefendSelectionFromOrder() {
    selected = new Set(defendOrder);
  }

  function renderActions(snap) {
    const bar = $('action-bar');
    bar.innerHTML = '';
    if (!snap || snap.winnerIndex !== null) return;

    const myAtt = snap.attackerIndex === snap.myIndex;
    const myDef = snap.defenderIndex === snap.myIndex;

    function btn(label, cls, onClick) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = label;
      b.addEventListener('click', onClick);
      bar.appendChild(b);
    }

    if (snap.phase === 'toss' && myAtt) {
      btn('Passen · Stich gewonnen', BTN_GHOST, () => doPass());
    }
    if (snap.phase === 'defend' && myDef) {
      btn('Aufnehmen', BTN_DANGER, () => doTake());
    }
  }

  function phaseHint(snap) {
    const el = $('phase-hint');
    if (!snap) {
      el.textContent = '';
      el.classList.remove('phase-hint-anim');
      return;
    }
    if (snap.winnerIndex !== null) {
      el.textContent = '';
      el.classList.remove('phase-hint-anim');
      return;
    }
    const me = snap.myIndex;
    let t = '';
    if (snap.phase === 'attack') {
      t =
        snap.attackerIndex === me
          ? 'Karten wählen (gleicher Rang) — Angriff startet automatisch kurz nach der Auswahl.'
          : 'Gegner greift an.';
    } else if (snap.phase === 'defend') {
      t =
        snap.defenderIndex === me
          ? 'Karten in Angriffs-Reihenfolge antippen — bei gültiger Verteidigung automatisch ausgeführt.'
          : 'Gegner verteidigt …';
    } else if (snap.phase === 'toss') {
      t =
        snap.attackerIndex === me
          ? 'Passende Ränge antippen (Nachlegen automatisch) oder Passen zum Stichgewinn.'
          : 'Gegner legt nach oder passt …';
    }
    el.textContent = t;
    el.classList.remove('phase-hint-anim');
    void el.offsetWidth;
    el.classList.add('phase-hint-anim');
  }

  function renderGame() {
    if (mode === 'online' && window.__lastOnlineSnap) {
      renderGameOnline(window.__lastOnlineSnap);
      return;
    }
    if (mode !== 'ai' || !localState) return;
    let snap = E.publicSnapshot(localState, 0);
    snap = enrichAiSnapWithDeadline(snap);

    $('game-mode-label').textContent = mode === 'ai' ? 'Modus · KI' : 'Modus · Online';
    $('opponent-label').textContent = mode === 'ai' ? 'Gegner · KI' : 'Gegner · Mitspieler';
    if (snap) {
      $('opponent-cards').textContent = snap.opponentCount + ' Karten';
      updateTrumpPanel(snap);
      const dc = $('deck-count');
      if (dc) dc.textContent = snap.deckCount > 0 ? 'Nachziehstapel · ' + snap.deckCount : 'Stapel leer';
      renderOpponentBacks(snap.opponentCount);
    }

    const win = $('winner-banner');
    if (snap && snap.winnerIndex !== null) {
      win.classList.remove('hidden', 'winner-show');
      void win.offsetWidth;
      win.classList.add('winner-show');
      if (snap.winnerIndex === snap.myIndex) win.textContent = 'Du hast gewonnen!';
      else if (snap.winnerIndex === -1) win.textContent = 'Unentschieden';
      else win.textContent = 'Du bist der Durak.';
    } else {
      win.classList.add('hidden');
      win.classList.remove('winner-show');
    }

    renderTable(snap);
    renderHand(snap);
    renderActions(snap);
    phaseHint(snap);
    restartTurnVisualizer(snap);

    if (localState.winnerIndex === null) maybeScheduleAi();
  }

  function doAttack(ids) {
    if (mode === 'ai' && localState) {
      const r = E.attack(localState, ids, 0);
      if (!r.ok) {
        $('phase-hint').textContent = r.err;
        return;
      }
      selected.clear();
      defendOrder = [];
      renderGame();
      scheduleAi(randomAiThinkMs());
      return;
    }
    if (mode === 'online' && socket) {
      socket.emit('attack', ids, (r) => {
        if (!r.ok) $('phase-hint').textContent = r.err || 'Fehler';
        selected.clear();
      });
    }
  }

  function doDefend(ids) {
    if (mode === 'ai' && localState) {
      const r = E.defend(localState, ids, 0);
      if (!r.ok) {
        $('phase-hint').textContent = r.err;
        return;
      }
      defendOrder = [];
      selected.clear();
      renderGame();
      scheduleAi(randomAiThinkMs());
      return;
    }
    if (mode === 'online' && socket) {
      socket.emit('defend', ids, (r) => {
        if (!r.ok) $('phase-hint').textContent = r.err || 'Fehler';
        defendOrder = [];
        selected.clear();
      });
    }
  }

  function doPass() {
    if (mode === 'ai' && localState) {
      E.attackerPass(localState, 0);
      selected.clear();
      renderGame();
      scheduleAi(randomAiThinkMs());
      return;
    }
    if (mode === 'online' && socket) {
      socket.emit('pass', () => {
        selected.clear();
      });
    }
  }

  function doTake() {
    if (mode === 'ai' && localState) {
      E.defenderTake(localState, 0);
      defendOrder = [];
      selected.clear();
      renderGame();
      scheduleAi(randomAiThinkMs());
      return;
    }
    if (mode === 'online' && socket) {
      socket.emit('take', () => {
        defendOrder = [];
        selected.clear();
      });
    }
  }

  function startAi() {
    clearAutoCommitTimer();
    clearAiTimer();
    stopTurnVisualizer();
    aiTurnKey = '';
    aiTurnEndsAt = 0;
    mode = 'ai';
    localState = E.newGame();
    selected.clear();
    defendOrder = [];
    showScreen('game');
    renderGame();
    if (localState.attackerIndex === 1) scheduleAi(randomAiThinkMs());
  }

  function exitGame() {
    clearAutoCommitTimer();
    clearAiTimer();
    stopTurnVisualizer();
    aiTurnKey = '';
    aiTurnEndsAt = 0;
    mode = 'menu';
    localState = null;
    selected.clear();
    defendOrder = [];
    window.__lastOnlineSnap = null;
    if (socket) {
      socket.disconnect();
      socket = null;
    }
    showScreen('menu');
  }

  $('btn-ai').addEventListener('click', startAi);

  $('btn-online').addEventListener('click', () => {
    showScreen('lobby');
    $('lobby-msg').textContent = '';
    $('room-panel').classList.add('hidden');
  });

  $('btn-lobby-back').addEventListener('click', () => showScreen('menu'));

  $('btn-game-exit').addEventListener('click', () => {
    if (mode === 'online' && socket && !confirm('Online-Spiel wirklich verlassen?')) return;
    exitGame();
  });

  $('btn-create').addEventListener('click', () => {
    const name = $('input-name').value.trim() || 'Spieler';
    if (socket) {
      socket.disconnect();
      socket = null;
    }
    socket = io();
    socket.emit('createRoom', name, (res) => {
      if (!res.ok) {
        $('lobby-msg').textContent = res.err || 'Fehler';
        return;
      }
      mySlotOnline = res.slot;
      $('room-panel').classList.remove('hidden');
      $('room-code').textContent = res.code;
      $('lobby-msg').textContent = '';
      updateRoomUi({ started: false, names: res.names || ['', ''] });
    });
    wireSocket();
  });

  $('btn-join').addEventListener('click', () => {
    const code = $('input-code').value.trim().toUpperCase();
    const name = $('input-name').value.trim() || 'Spieler';
    if (code.length < 4) {
      $('lobby-msg').textContent = 'Code eingeben';
      return;
    }
    if (!socket) socket = io();
    socket.emit('joinRoom', { code, name }, (res) => {
      if (!res.ok) {
        $('lobby-msg').textContent = res.err || 'Fehler';
        return;
      }
      mySlotOnline = res.slot;
      $('room-panel').classList.remove('hidden');
      $('room-code').textContent = res.code;
      $('lobby-msg').textContent = '';
      updateRoomUi({ started: false, names: res.names || ['', ''] });
      wireSocket();
    });
  });

  function updateRoomUi(payload) {
    const st = $('room-status');
    const n = payload.names || [];
    if (!payload.started) {
      const p0 = n[0] || '—';
      const p1 = n[1] || '—';
      st.textContent = `${p0} vs ${p1}`;
      const startBtn = $('btn-start-online');
      if (mySlotOnline === 0 && n[0] && n[1]) {
        startBtn.classList.remove('hidden');
      } else {
        startBtn.classList.add('hidden');
      }
    } else {
      st.textContent = 'Läuft…';
      $('btn-start-online').classList.add('hidden');
    }
  }

  $('btn-start-online').addEventListener('click', () => {
    if (!socket) return;
    socket.emit('startGame', (res) => {
      if (!res.ok) $('lobby-msg').textContent = res.err || 'Start fehlgeschlagen';
    });
  });

  function wireSocket() {
    if (!socket || socket.__wired) return;
    socket.__wired = true;
    socket.on('state', (payload) => {
      clearAutoCommitTimer();
      if (payload.mySlot != null) mySlotOnline = payload.mySlot;
      updateRoomUi(payload);
      if (payload.started && payload.snapshot) {
        mode = 'online';
        const merged = { ...payload.snapshot, turnEndsAt: payload.turnEndsAt };
        window.__lastOnlineSnap = merged;
        showScreen('game');
        renderGameOnline(merged);
      }
    });
  }

  function renderGameOnline(snap) {
    $('game-mode-label').textContent = 'Modus · Online';
    $('opponent-label').textContent = 'Gegner · Mitspieler';
    $('opponent-cards').textContent = snap.opponentCount + ' Karten';
    updateTrumpPanel(snap);
    const dc = $('deck-count');
    if (dc) dc.textContent = snap.deckCount > 0 ? 'Nachziehstapel · ' + snap.deckCount : 'Stapel leer';
    renderOpponentBacks(snap.opponentCount);

    const win = $('winner-banner');
    if (snap.winnerIndex !== null) {
      win.classList.remove('hidden', 'winner-show');
      void win.offsetWidth;
      win.classList.add('winner-show');
      if (snap.winnerIndex === snap.myIndex) win.textContent = 'Du hast gewonnen!';
      else if (snap.winnerIndex === -1) win.textContent = 'Unentschieden';
      else win.textContent = 'Du bist der Durak.';
    } else {
      win.classList.add('hidden');
      win.classList.remove('winner-show');
    }

    renderTable(snap);
    renderHandOnline(snap);
    renderActionsOnline(snap);
    phaseHint(snap);
    restartTurnVisualizer(snap);
  }

  function renderHandOnline(snap) {
    const root = $('hand');
    root.innerHTML = '';
    const trump = snap.trumpSuit;
    const phase = snap.phase;
    const myAtt = snap.attackerIndex === snap.myIndex;
    const myDef = snap.defenderIndex === snap.myIndex;

    const sorted = sortHandDisplay(snap.myHand, trump);
    sorted.forEach((c, i) => {
      const el = document.createElement('button');
      el.type = 'button';
      const picked = selected.has(c.id);
      const ord = defendOrder.indexOf(c.id);
      el.style.setProperty('--i', String(i));
      el.style.setProperty('--rot', (i % 5) * 0.8 - 1.6 + 'deg');
      el.className =
        'anim-hand-card ' +
        cardClass(c) +
        (c.suit === trump ? ' card-trump-hand' : '') +
        (picked ? ' card-pick' : '');
      el.innerHTML = `<span class="font-bold">${c.rank}</span><span class="text-center text-3xl leading-none sm:text-4xl">${c.suit}</span><span class="min-h-[14px] text-center text-[11px] font-semibold text-slate-500">${picked && phase === 'defend' && myDef ? ord + 1 : ''}</span>`;
      el.addEventListener('click', () => {
        const cur = window.__lastOnlineSnap;
        if (!cur) return;
        const ph = cur.phase;
        const iAtt = cur.attackerIndex === cur.myIndex;
        const iDef = cur.defenderIndex === cur.myIndex;
        if (ph === 'attack' && iAtt) {
          if (selected.has(c.id)) selected.delete(c.id);
          else selected.add(c.id);
          if (cur.table.length === 0) {
            const ids = [...selected];
            const cards = ids.map((id) => cur.myHand.find((x) => x.id === id)).filter(Boolean);
            const r0 = cards[0]?.rank;
            for (const x of cards) if (x.rank !== r0) selected.delete(x.id);
          }
          renderGameOnline(cur);
          scheduleAutoCommitAttackToss();
        } else if (ph === 'toss' && iAtt) {
          if (selected.has(c.id)) selected.delete(c.id);
          else selected.add(c.id);
          renderGameOnline(cur);
          scheduleAutoCommitAttackToss();
        } else if (ph === 'defend' && iDef) {
          const idx = defendOrder.indexOf(c.id);
          if (idx >= 0) defendOrder.splice(idx, 1);
          else defendOrder.push(c.id);
          selected = new Set(defendOrder);
          renderGameOnline(cur);
          tryAutoDefendOnline();
        }
      });
      root.appendChild(el);
    });
  }

  function renderActionsOnline(snap) {
    const bar = $('action-bar');
    bar.innerHTML = '';
    if (!snap || snap.winnerIndex !== null) return;
    const myAtt = snap.attackerIndex === snap.myIndex;
    const myDef = snap.defenderIndex === snap.myIndex;

    function btn(label, cls, onClick) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.textContent = label;
      b.addEventListener('click', onClick);
      bar.appendChild(b);
    }

    if (snap.phase === 'toss' && myAtt) {
      btn('Passen', BTN_GHOST, () => {
        socket.emit('pass', () => {
          selected.clear();
        });
      });
    }
    if (snap.phase === 'defend' && myDef) {
      btn('Aufnehmen', BTN_DANGER, () => {
        socket.emit('take', () => {
          defendOrder = [];
          selected.clear();
        });
      });
    }
  }

  const splashEl = document.getElementById('screen-splash');
  const splashBtn = document.getElementById('btn-splash-continue');
  function dismissSplash() {
    if (!splashEl || splashEl.classList.contains('is-out')) return;
    splashEl.classList.add('is-out');
    document.body.classList.remove('splash-active');
    window.setTimeout(() => {
      splashEl.classList.add('hidden');
      splashEl.setAttribute('aria-hidden', 'true');
    }, 460);
  }
  if (splashBtn) splashBtn.addEventListener('click', dismissSplash);
})();
